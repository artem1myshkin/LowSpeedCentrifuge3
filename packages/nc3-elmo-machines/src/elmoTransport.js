'use strict';

const { setup, assign, createActor } = require('xstate');
const { priorityInsert, dequeue: queueDequeue, PRIORITY } = require('./queue');
const { buildPollEnvelope, shouldExtend, computePollDelayMs } = require('./poll');
const { parseElmoScalars } = require('./parse');
const { clamp, splitElmoCommands } = require('./util');

// ElmoTransport — single serialized owner of the ELMO UDP link (plan §4, reworked for UDP).
//
// UDP model: ELMO listens on a UDP port and answers each command datagram with exactly one
// reply datagram. Node-RED `udp out` / `udp in` are NOT a correlated request/response pair,
// so the transport keeps a SINGLE in-flight request and sends logical batches as ordered
// atomic commands (`TM`, then `PX`, then `VX`; or `AC=...`, `DC=...`, `JV=...`, `BG` for a
// command sequence). Replies are reassembled before being forwarded downstream. A received
// datagram is already a complete frame — there is no FrameSplitter / idle-gap reassembly,
// which is what capped the old TCP `sit` path at ~4 Hz.
//
// UDP is connectionless: a lost datagram is just a missed reply, so a request timeout frees
// the in-flight slot and polling continues; only after `maxMisses` consecutive timeouts is the
// link declared offline (which then self-heals by re-probing). There is no socket to reset.
//
// effects:
//   sendCmd(cmd)            -> emit one command datagram to `udp out` (out0)
//   forwardResp(raw, topic) -> forward a raw reply to ResponseParser with restored topic (out1)
//   emitEvent(evt)          -> emit a domain event (CMD.ACKED/FAILED, POLL.BAD_FRAME, ...) (out2)
//   setStatus(status)       -> node.status({fill,shape,text})
//   now()                   -> clock (defaults to Date.now); injectable for tests
//   timeoutMs               -> per-request reply watchdog (default 1000)
//   connectTimeoutMs        -> probe watchdog while connecting (default 2000)
//   reconnectMs             -> delay before re-probing after going offline (default 1000)
//   maxMisses               -> consecutive reply timeouts before the link is offline (default 3)
//   statePeriodMs           -> minimal state-poll cadence (default 1000)
//   probeCmd                -> liveness probe sent on connect (default single TM read)
//   initialFullState        -> enqueue full-state poll after connect/recover (default true)
//   pollOptions             -> { minHz, maxHz, analogParam } for poll scheduling/payload
// input.pollConfig:
//   { isRecording, isRecordingRaw, rawDataEnabled, fastRawPollHz, ... } toggles the fast raw
//   recording poll path without coupling the machine to Node-RED globals.

function createElmoTransport(effects) {
  const e = effects || {};
  const sendCmd = e.sendCmd || (() => {});
  const forwardResp = e.forwardResp || (() => {});
  const emitEvent = e.emitEvent || (() => {});
  const setStatus = e.setStatus || (() => {});
  const now = e.now || (() => Date.now());
  const timeoutMs = e.timeoutMs == null ? 1000 : e.timeoutMs;
  const connectTimeoutMs = e.connectTimeoutMs == null ? 2000 : e.connectTimeoutMs;
  const reconnectMs = e.reconnectMs == null ? 1000 : e.reconnectMs;
  const maxMisses = e.maxMisses == null ? 3 : e.maxMisses;
  const statePeriodMs = e.statePeriodMs == null ? 1000 : e.statePeriodMs;
  const probeCmd = e.probeCmd || 'TM';
  const initialFullState = e.initialFullState !== false;
  const pollOptions = e.pollOptions || {};

  let seq = 0;
  const nextId = () => 'e' + (++seq);

  function finiteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizePollConfig(config) {
    const cfg = config || {};
    return {
      isRecording: cfg.isRecording === true,
      isRecordingRaw: cfg.isRecordingRaw === true,
      rawDataEnabled: cfg.rawDataEnabled === true,
      fastRawPollingEnabled: cfg.fastRawPollingEnabled !== false,
      fastRawPollHz: clamp(finiteNumber(cfg.fastRawPollHz, 30), 1, 30),
      fastStableSamples: Math.round(clamp(finiteNumber(cfg.fastStableSamples, 3), 1, 50)),
      fastStableToleranceTicks: Math.max(0, finiteNumber(cfg.fastStableToleranceTicks, 1000)),
    };
  }

  function shouldFastPoll(config) {
    const cfg = normalizePollConfig(config);
    return cfg.fastRawPollingEnabled && cfg.isRecording && (cfg.isRecordingRaw || cfg.rawDataEnabled);
  }

  function isFastPollRole(role) {
    return role === 'fast_seek' || role === 'fast_data';
  }

  function fastPollRoleFor(context) {
    return context.fastStable ? 'fast_data' : 'fast_seek';
  }

  function normalizeEnvelope(env) {
    const src = env || {};
    const kind = src.kind || 'cmd';
    const cmds = splitElmoCommands(src.cmds || src.cmd);
    return {
      id: src.id || nextId(),
      kind,
      priority: typeof src.priority === 'number' ? src.priority : (PRIORITY[kind] || 0),
      cmd: cmds[0] || src.cmd,
      cmds: cmds.length ? cmds : undefined,
      cursor: 0,
      parts: [],
      expect: src.expect || (kind === 'poll' ? 'parse' : 'ack'),
      meta: src.meta || {},
    };
  }

  function pollRoleOf(env) {
    return (env && env.meta && env.meta.pollRole) || (env && env.pollRole) || (env && env.extended ? 'full_state' : 'data');
  }

  function topicFor(env) {
    if (env && env.meta && env.meta.topic) return env.meta.topic;
    if (env && env.kind === 'poll') return pollRoleOf(env) === 'data' ? 'poll_data' : 'poll_state';
    return undefined;
  }

  function isAckable(env) {
    return env && (env.kind === 'cmd' || env.kind === 'tilt');
  }

  function hasPollRole(queue, role) {
    return queue.some((env) => env && env.kind === 'poll' && pollRoleOf(env) === role);
  }

  function hasAnyFastPoll(queue) {
    return queue.some((env) => env && env.kind === 'poll' && isFastPollRole(pollRoleOf(env)));
  }

  function hasPollRoleInFlight(context, role) {
    return context.inFlight && context.inFlight.kind === 'poll' && pollRoleOf(context.inFlight) === role;
  }

  function hasAnyFastPollInFlight(context) {
    return context.inFlight && context.inFlight.kind === 'poll' && isFastPollRole(pollRoleOf(context.inFlight));
  }

  function missingFields(parsed, fields) {
    return fields.filter((field) => parsed[field] === undefined);
  }

  // Stand finding: ELMO does NOT batch its reply — one datagram per parameter. So a logical
  // poll is sent as a SEQUENCE of atomic single-parameter commands (cmds[]); each atomic reply
  // is one datagram (= one part), and the parts are reassembled into the logical raw frame.
  function isMultiPart(env) {
    return env && Array.isArray(env.cmds) && env.cmds.length > 0;
  }

  function isBatchPoll(env) {
    return env && env.kind === 'poll' && isMultiPart(env);
  }

  function cursorOf(env) {
    return Math.max(0, Number(env && env.cursor) || 0);
  }

  function commandFor(env) {
    if (isMultiPart(env)) return env.cmds[Math.min(cursorOf(env), env.cmds.length - 1)];
    return env && env.cmd;
  }

  function rawFor(env, raw) {
    if (!isMultiPart(env)) return raw;
    return (env.parts || []).concat([raw]).join('');
  }

  // Whole-frame validation (after all parts reassembled, or for a non-batch envelope).
  function validatePollResponse(env, raw) {
    if (!env || env.kind !== 'poll') return { ok: true, role: undefined, missing: [] };
    const role = pollRoleOf(env);
    const parsed = parseElmoScalars(raw);
    const required = env.required || (role === 'full_state'
      ? ['ms', 'mo', 'so', 'sr', 'af', 'ol1', 'ol2']
      : (role === 'state' ? ['mo', 'so', 'sr'] : ['tm', 'px', 'vx']));
    const missing = missingFields(parsed, required);
    return { ok: missing.length === 0, role, missing };
  }

  // Per-part validation: does the current atomic reply carry the field we just requested?
  // A stale/cross-attributed datagram (the bug we fixed by going atomic) will fail this check
  // and surface as POLL.BAD_FRAME for the part, instead of silently corrupting the frame.
  function validateCurrentPollPart(env, raw) {
    if (!isBatchPoll(env)) return validatePollResponse(env, raw);
    const role = pollRoleOf(env);
    const idx = cursorOf(env);
    const required = (env.partRequired && env.partRequired[idx]) || [];
    const missing = missingFields(parseElmoScalars(raw), required);
    return { ok: missing.length === 0, role, missing, part: idx, cmd: commandFor(env) };
  }

  function responseValidation(env, rawEvent) {
    const partValidation = validateCurrentPollPart(env, rawEvent);
    const raw = rawFor(env, rawEvent);
    const validation = partValidation.ok ? validatePollResponse(env, raw) : partValidation;
    return { raw, validation };
  }

  function commandListFor(env) {
    if (!env) return [];
    if (Array.isArray(env.cmds) && env.cmds.length) return env.cmds;
    return env.cmd ? [env.cmd] : [];
  }

  function commandRequests(env, pattern) {
    return commandListFor(env).some((cmd) => pattern.test(String(cmd || '').toUpperCase()));
  }

  function confirmPollRoleFor(env) {
    if (!isAckable(env)) return null;
    const meta = env.meta || {};
    if (meta.confirmPollRole) return meta.confirmPollRole;
    if (commandRequests(env, /\bMO\s*=/)) return 'state';
    if (commandRequests(env, /\bOL\[1\]\s*=/)) return 'full_state';
    if (commandRequests(env, /\bOL\[2\]\s*=/)) return 'full_state';
    if (commandRequests(env, /\bAF\s*=/)) return 'full_state';
    return null;
  }

  function fastStabilityPatch(context, vx) {
    const cfg = context.pollConfig || normalizePollConfig();
    const prev = context.lastFastVx;
    const delta = prev == null ? Infinity : Math.abs(Number(vx) - Number(prev));
    const count = delta <= cfg.fastStableToleranceTicks ? (Number(context.fastStableCount) || 0) + 1 : 1;
    return {
      lastFastVx: Number(vx),
      fastStableCount: count,
      fastStable: count >= cfg.fastStableSamples,
    };
  }

  return setup({
    guards: {
      hasWork: ({ context }) => context.queue.length > 0,
      // Evaluated before the timeout actions run, so it predicts the post-bump miss count.
      tooManyMisses: ({ context }) => (Number(context.missCount) || 0) + 1 >= maxMisses,
      // True while the in-flight request still has more atomic commands to send. Poll parts
      // must validate before advancing; command batches only require another part.
      hasNextPollPart: ({ context, event }) => {
        const env = context.inFlight;
        if (!isMultiPart(env)) return false;
        if (env.kind === 'poll' && !validateCurrentPollPart(env, event.raw).ok) return false;
        return cursorOf(env) < env.cmds.length - 1;
      },
    },
    delays: {
      POLL_DELAY: ({ context }) => computePollDelayMs({ ...context, nowMs: now() }, pollOptions),
      TIMEOUT: () => timeoutMs,
      CONNECT_TIMEOUT: () => connectTimeoutMs,
      RECONNECT_DELAY: () => reconnectMs,
    },
    actions: {
      configurePoll: assign(({ context, event }) => {
        const pollConfig = normalizePollConfig(event.config);
        const fastRawActive = shouldFastPoll(pollConfig);
        const patch = { pollConfig, fastRawActive };
        if (fastRawActive !== context.fastRawActive || !fastRawActive) {
          patch.fastStable = false;
          patch.fastStableCount = 0;
          patch.lastFastVx = undefined;
          patch.lastFastPollStartedAt = 0;
        }
        return patch;
      }),

      enqueueCmd: assign(({ context, event }) => {
        const env = normalizeEnvelope(event.envelope);
        const patch = { queue: priorityInsert(context.queue, env) };
        // Setpoint fallback (§4.4): use target speed for poll rate until the first VX poll.
        const sp = env.meta && env.meta.setpointDegS;
        if (sp != null && Number.isFinite(Number(sp))) {
          patch.omegaSource = 'setpoint';
          patch.setpointDegS = Number(sp);
        }
        return patch;
      }),

      // Update only the fields the transport needs for its own decisions (poll rate, range).
      // Does NOT replace ResponseParser — raw is still forwarded downstream (§4.6).
      ingestResp: assign(({ context, event }) => {
        // Reassemble parts so the parser sees the whole logical frame, not just the last one.
        const raw = rawFor(context.inFlight, event.raw);
        if (!validatePollResponse(context.inFlight, raw).ok) return {};
        const f = parseElmoScalars(raw);
        const patch = {};
        if (f.tm !== undefined) patch.tm = f.tm;
        if (f.px !== undefined) patch.px = f.px;
        if (f.vx !== undefined) { patch.vx = f.vx; patch.omegaSource = 'measured'; }
        if (f.resolution) patch.resolution = f.resolution;
        if (f.ol1 !== undefined) patch.ol1 = f.ol1;
        if (f.ol2 !== undefined) patch.ol2 = f.ol2;
        if (f.mo !== undefined) patch.mo = f.mo;
        if (f.so !== undefined) patch.so = f.so;
        if (f.ms !== undefined) patch.ms = f.ms;
        if (f.sr !== undefined) patch.sr = f.sr;
        if (f.af !== undefined) patch.af = f.af;
        if (isFastPollRole(pollRoleOf(context.inFlight)) && f.vx !== undefined) {
          Object.assign(patch, fastStabilityPatch(context, f.vx));
        }
        return patch;
      }),

      enqueuePoll: assign(({ context }) => {
        // Keep data and state polls as separate serialized datagrams; dedup by role.
        const t = now();
        let queue = context.queue;
        let lastExtendedAt = context.lastExtendedAt;
        if (context.fastRawActive) {
          const role = fastPollRoleFor(context);
          const hasDiagnostic = hasPollRole(queue, 'full_state') || hasPollRoleInFlight(context, 'full_state');
          if (!hasDiagnostic && !hasAnyFastPoll(queue) && !hasAnyFastPollInFlight(context)) {
            queue = priorityInsert(queue, buildPollEnvelope({ id: nextId(), role, options: pollOptions }));
          }
          return { queue, lastExtendedAt };
        }
        if (!hasPollRole(queue, 'data') && !hasPollRoleInFlight(context, 'data')) {
          queue = priorityInsert(queue, buildPollEnvelope({ id: nextId(), role: 'data', options: pollOptions }));
        }
        if (
          shouldExtend(context.lastExtendedAt, t, statePeriodMs)
          && !hasPollRole(queue, 'state')
          && !hasPollRoleInFlight(context, 'state')
        ) {
          queue = priorityInsert(queue, buildPollEnvelope({ id: nextId(), role: 'state', options: pollOptions }));
          lastExtendedAt = t;
        }
        return {
          queue,
          lastExtendedAt,
        };
      }),

      enqueueFullStatePoll: assign(({ context }) => {
        if (hasPollRole(context.queue, 'full_state') || hasPollRoleInFlight(context, 'full_state')) return {};
        return {
          queue: priorityInsert(context.queue, buildPollEnvelope({ id: nextId(), role: 'full_state', options: pollOptions })),
        };
      }),

      enqueueInitialFullStatePoll: assign(({ context }) => {
        if (!initialFullState) return {};
        if (hasPollRole(context.queue, 'full_state') || hasPollRoleInFlight(context, 'full_state')) return {};
        return {
          queue: priorityInsert(context.queue, buildPollEnvelope({ id: nextId(), role: 'full_state', options: pollOptions })),
        };
      }),

      enqueueConfirmPoll: assign(({ context }) => {
        const role = confirmPollRoleFor(context.inFlight);
        if (!role || hasPollRole(context.queue, role) || hasPollRoleInFlight(context, role)) return {};
        return {
          queue: priorityInsert(context.queue, buildPollEnvelope({ id: nextId(), role, options: pollOptions })),
        };
      }),

      enqueueDiagnosticOnBadPoll: assign(({ context, event }) => {
        const env = context.inFlight;
        if (!env || env.kind !== 'poll' || !isFastPollRole(pollRoleOf(env))) return {};
        const { validation } = responseValidation(env, event.raw);
        if (validation.ok || hasPollRole(context.queue, 'full_state') || hasPollRoleInFlight(context, 'full_state')) return {};
        return {
          queue: priorityInsert(
            context.queue,
            buildPollEnvelope({ id: nextId(), role: 'full_state', options: pollOptions, priority: PRIORITY.init })
          ),
          fastStable: false,
          fastStableCount: 0,
          lastFastVx: undefined,
        };
      }),

      takeNext: assign(({ context }) => {
        const { inFlight, queue } = queueDequeue(context.queue);
        const patch = { inFlight, queue };
        if (inFlight && inFlight.kind === 'poll' && isFastPollRole(pollRoleOf(inFlight))) {
          patch.lastFastPollStartedAt = now();
        }
        return patch;
      }),

      sendInFlight: ({ context }) => {
        if (context.inFlight) sendCmd(commandFor(context.inFlight));
      },

      // After a part validates, append its raw and advance the cursor; sendingNextPart then
      // emits the next atomic command.
      collectPollPart: assign(({ context, event }) => {
        const env = context.inFlight;
        if (!isMultiPart(env)) return {};
        return {
          inFlight: {
            ...env,
            parts: (env.parts || []).concat([event.raw]),
            cursor: cursorOf(env) + 1,
          },
        };
      }),

      sendProbe: () => {
        sendCmd(probeCmd);
      },

      forwardAndAck: ({ context, event }) => {
        const env = context.inFlight;
        const { raw, validation } = responseValidation(env, event.raw);
        if (!validation.ok) {
          emitEvent({
            type: 'POLL.BAD_FRAME',
            id: env.id,
            role: validation.role,
            missing: validation.missing,
            part: validation.part,
            cmd: validation.cmd != null ? validation.cmd : env.cmd,
            raw,
          });
          return;
        }
        forwardResp(raw, topicFor(env));
        if (isAckable(env)) emitEvent({ type: 'CMD.ACKED', id: env.id, raw: event.raw });
      },

      failInFlight: ({ context }) => {
        const env = context.inFlight;
        if (isAckable(env)) emitEvent({ type: 'CMD.FAILED', id: env.id, reason: 'timeout' });
      },

      bumpMiss: assign(({ context }) => ({ missCount: (Number(context.missCount) || 0) + 1 })),
      resetMiss: assign({ missCount: 0 }),
      freeInFlight: assign({ inFlight: null }),

      statusOffline: () => setStatus({ fill: 'red', shape: 'ring', text: 'ELMO offline' }),
      statusConnecting: () => setStatus({ fill: 'yellow', shape: 'ring', text: 'ELMO connecting' }),
      statusIdle: () => setStatus({ fill: 'green', shape: 'dot', text: 'ELMO online' }),
      statusBusy: () => setStatus({ fill: 'blue', shape: 'dot', text: 'ELMO busy' }),
    },
  }).createMachine({
    id: 'transport',
    context: ({ input }) => {
      const pollConfig = normalizePollConfig(input && input.pollConfig);
      return {
        queue: [],
        inFlight: null,
        resolution: (input && input.resolution) || 'high',
        vx: 0,
        omegaSource: 'measured', // 'setpoint' right after a speed command (§4.4 fallback)
        setpointDegS: 0,
        lastExtendedAt: 0,
        missCount: 0,
        pollConfig,
        fastRawActive: shouldFastPoll(pollConfig),
        fastStable: false,
        fastStableCount: 0,
        lastFastVx: undefined,
        lastFastPollStartedAt: 0,
      };
    },
    initial: 'offline',
    on: {
      'POLL.CONFIG': { actions: 'configurePoll' },
    },
    states: {
      offline: {
        entry: 'statusOffline',
        // UDP self-heal: re-probe after a quiet period even without an explicit CONNECT.
        after: { RECONNECT_DELAY: { target: 'connecting' } },
        on: {
          // First command (or explicit CONNECT) brings the link up. enqueue happens on the
          // accepting transition so the first request is not lost (§4.3.1).
          'UI.CMD': { actions: 'enqueueCmd', target: 'connecting' },
          CONNECT: 'connecting',
        },
      },

      connecting: {
        entry: ['statusConnecting', 'sendProbe'],
        after: { CONNECT_TIMEOUT: { target: 'offline' } },
        on: {
          'UI.CMD': { actions: 'enqueueCmd' },
          'ELMO.RESP': { target: '#transport.connected', actions: ['resetMiss', 'enqueueInitialFullStatePoll'] },
          'ELMO.TIMEOUT': 'offline',
        },
      },

      connected: {
        initial: 'idle',
        // Commands/poll ticks accepted in any substate; internal (targetless) so they do
        // not disturb the active request (single in-flight preserved).
        on: {
          'UI.CMD': { actions: 'enqueueCmd' },
          'POLL.TICK': { actions: 'enqueuePoll' },
          'POLL.FULL_STATE': { actions: 'enqueueFullStatePoll' },
        },
        states: {
          idle: {
            entry: 'statusIdle',
            // Self-clocked poll: when idle with no work for POLL_DELAY, enqueue a poll (§4.4.5).
            after: { POLL_DELAY: { actions: 'enqueuePoll' } },
            always: { guard: 'hasWork', target: 'sending' },
          },
          sending: {
            entry: ['statusBusy', 'takeNext', 'sendInFlight'],
            always: 'awaiting',
          },
          awaiting: {
            // UDP timeout = missed reply. Free the slot and keep polling; only declare the
            // link offline after maxMisses consecutive misses (then offline self-heals).
            after: {
              TIMEOUT: [
                { guard: 'tooManyMisses', target: '#transport.offline', actions: ['failInFlight', 'bumpMiss', 'freeInFlight'] },
                { target: 'idle', actions: ['failInFlight', 'bumpMiss', 'freeInFlight'] },
              ],
            },
            on: {
              // Multi-part: if the just-arrived part validated and more atomic commands remain,
              // collect it and send the next; otherwise dispatch the (whole, reassembled) frame.
              'ELMO.RESP': [
                { guard: 'hasNextPollPart', target: 'sendingNextPart', actions: ['resetMiss', 'collectPollPart'] },
                { target: 'dispatch', actions: ['resetMiss', 'ingestResp', 'forwardAndAck', 'enqueueDiagnosticOnBadPoll', 'enqueueConfirmPoll'] },
              ],
              'ELMO.TIMEOUT': [
                { guard: 'tooManyMisses', target: '#transport.offline', actions: ['failInFlight', 'bumpMiss', 'freeInFlight'] },
                { target: 'idle', actions: ['failInFlight', 'bumpMiss', 'freeInFlight'] },
              ],
            },
          },
          sendingNextPart: {
            entry: 'sendInFlight',
            always: 'awaiting',
          },
          dispatch: {
            entry: 'freeInFlight',
            always: 'idle',
          },
        },
      },
    },
  });
}

// Convenience for the Node-RED glue: create + start the actor in one call so the Function
// node only needs the `nc3` module (xstate stays internal to this package).
function startElmoTransport(effects, input) {
  return createActor(createElmoTransport(effects), { input: input || {} }).start();
}

module.exports = { createElmoTransport, startElmoTransport };
