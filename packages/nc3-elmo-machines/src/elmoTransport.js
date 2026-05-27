'use strict';

const { setup, assign, createActor } = require('xstate');
const { priorityInsert, dequeue: queueDequeue, PRIORITY } = require('./queue');
const { buildPollEnvelope, shouldExtend, computePollDelayMs } = require('./poll');
const { parseElmoScalars } = require('./parse');
const { clamp } = require('./util');

// ElmoTransport — single serialized owner of the ELMO TCP socket (plan §4).
// The machine is pure: all I/O is delegated to injected `effects` so it can be unit-tested
// outside Node-RED. The Node-RED Function node wires these effects to one `tcp request`
// node and the loopback (§4.6).
//
// effects:
//   sendTcp(cmd)            -> emit a command string to the single tcp request (out0)
//   resetTcp()              -> force socket reset (sit mode: msg.reset) on timeout/fault
//   forwardResp(raw, topic) -> forward a raw response to ResponseParser with restored topic (out1)
//   emitEvent(evt)          -> emit a domain event (CMD.ACKED/FAILED, ...) to consumers (out2)
//   setStatus(status)       -> node.status({fill,shape,text})
//   now()                   -> clock (defaults to Date.now); injectable for tests
//   timeoutMs               -> per-request watchdog (default 180)
//   connectTimeoutMs        -> probe watchdog while connecting (default 1000)
//   statePeriodMs           -> minimal state-poll cadence (default 1000)
//   probeCmd                -> liveness probe sent on connect (default single TM read)
//   initialFullState        -> enqueue full-state poll after connect/recover (default true)
//   pollOptions             -> { minHz, maxHz, analogParam } for poll scheduling/payload
// input.pollConfig:
//   { isRecording, isRecordingRaw, rawDataEnabled, fastRawPollHz, ... } toggles
//   the fast raw-recording poll path without coupling the machine to Node-RED globals.

function createElmoTransport(effects) {
  const e = effects || {};
  const sendTcp = e.sendTcp || (() => {});
  const resetTcp = e.resetTcp || (() => {});
  const forwardResp = e.forwardResp || (() => {});
  const emitEvent = e.emitEvent || (() => {});
  const setStatus = e.setStatus || (() => {});
  const now = e.now || (() => Date.now());
  const timeoutMs = e.timeoutMs == null ? 180 : e.timeoutMs;
  const connectTimeoutMs = e.connectTimeoutMs == null ? 1000 : e.connectTimeoutMs;
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
    return {
      id: src.id || nextId(),
      kind,
      priority: typeof src.priority === 'number' ? src.priority : (PRIORITY[kind] || 0),
      cmd: src.cmd,
      expect: src.expect || (kind === 'poll' ? 'parse' : 'ack'),
      meta: src.meta || {},
    };
  }

  function topicFor(env) {
    if (env && env.meta && env.meta.topic) return env.meta.topic;
    if (env && env.kind === 'poll') return pollRoleOf(env) === 'data' ? 'poll_data' : 'poll_state';
    return undefined;
  }

  function isAckable(env) {
    return env && (env.kind === 'cmd' || env.kind === 'tilt');
  }

  function pollRoleOf(env) {
    return (env && env.meta && env.meta.pollRole) || (env && env.pollRole) || (env && env.extended ? 'full_state' : 'data');
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

  function isBatchPoll(env) {
    return env && env.kind === 'poll' && Array.isArray(env.cmds) && env.cmds.length > 0;
  }

  function cursorOf(env) {
    return Math.max(0, Number(env && env.cursor) || 0);
  }

  function commandFor(env) {
    if (isBatchPoll(env)) return env.cmds[Math.min(cursorOf(env), env.cmds.length - 1)];
    return env && env.cmd;
  }

  function rawFor(env, raw) {
    if (!isBatchPoll(env)) return raw;
    return (env.parts || []).concat([raw]).join('');
  }

  function missingFields(parsed, fields) {
    return fields.filter((field) => parsed[field] === undefined);
  }

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

  function commandRequests(cmd, pattern) {
    return pattern.test(String(cmd || '').toUpperCase());
  }

  function confirmPollRoleFor(env) {
    if (!isAckable(env)) return null;
    const meta = env.meta || {};
    if (meta.confirmPollRole) return meta.confirmPollRole;
    const cmd = env.cmd;
    if (commandRequests(cmd, /\bMO\s*=/)) return 'state';
    if (commandRequests(cmd, /\bOL\[1\]\s*=/)) return 'full_state';
    if (commandRequests(cmd, /\bOL\[2\]\s*=/)) return 'full_state';
    if (commandRequests(cmd, /\bAF\s*=/)) return 'full_state';
    return null;
  }

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
      hasNextPollPart: ({ context, event }) => {
        const env = context.inFlight;
        if (!isBatchPoll(env)) return false;
        if (!validateCurrentPollPart(env, event.raw).ok) return false;
        return cursorOf(env) < env.cmds.length - 1;
      },
    },
    delays: {
      POLL_DELAY: ({ context }) => computePollDelayMs(context, pollOptions),
      TIMEOUT: () => timeoutMs,
      CONNECT_TIMEOUT: () => connectTimeoutMs,
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
        // Keep data and state polls as separate serialized requests; dedup by role.
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
        return { inFlight, queue };
      }),

      collectPollPart: assign(({ context, event }) => {
        const env = context.inFlight;
        if (!isBatchPoll(env)) return {};
        return {
          inFlight: {
            ...env,
            parts: (env.parts || []).concat([event.raw]),
            cursor: cursorOf(env) + 1,
          },
        };
      }),

      sendInFlight: ({ context }) => {
        if (context.inFlight) sendTcp(commandFor(context.inFlight));
      },

      sendProbe: () => {
        sendTcp(probeCmd);
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
            cmd: validation.cmd,
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

      freeInFlight: assign({ inFlight: null }),

      doReset: () => {
        resetTcp();
      },

      statusOffline: () => setStatus({ fill: 'red', shape: 'ring', text: 'ELMO offline' }),
      statusConnecting: () => setStatus({ fill: 'yellow', shape: 'ring', text: 'ELMO connecting' }),
      statusIdle: () => setStatus({ fill: 'green', shape: 'dot', text: 'ELMO online' }),
      statusBusy: () => setStatus({ fill: 'blue', shape: 'dot', text: 'ELMO busy' }),
      statusFault: () => setStatus({ fill: 'red', shape: 'dot', text: 'ELMO fault' }),
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
        pollConfig,
        fastRawActive: shouldFastPoll(pollConfig),
        fastStable: false,
        fastStableCount: 0,
        lastFastVx: undefined,
      };
    },
    initial: 'offline',
    on: {
      'POLL.CONFIG': { actions: 'configurePoll' },
    },
    states: {
      offline: {
        entry: 'statusOffline',
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
          'ELMO.RESP': { target: '#transport.connected', actions: 'enqueueInitialFullStatePoll' },
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
            after: { TIMEOUT: { target: '#transport.fault', actions: 'failInFlight' } },
            on: {
              'ELMO.RESP': [
                { guard: 'hasNextPollPart', target: 'sendingNextPart', actions: 'collectPollPart' },
                { target: 'dispatch', actions: ['ingestResp', 'forwardAndAck', 'enqueueDiagnosticOnBadPoll', 'enqueueConfirmPoll'] },
              ],
              'ELMO.TIMEOUT': { target: '#transport.fault', actions: 'failInFlight' },
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

      fault: {
        // failInFlight (on the timeout transition) runs first and reads inFlight;
        // then fault entry resets the socket and clears the stale request.
        entry: ['statusFault', 'doReset', 'freeInFlight'],
        on: {
          'UI.CMD': { actions: 'enqueueCmd' },
          CLEARED: '#transport.connected',
          'ELMO.RESP': { target: '#transport.connected', actions: 'enqueueInitialFullStatePoll' },
          LOST: 'offline',
        },
      },
    },
  });
}

// Convenience for the Node-RED glue: create + start the actor in one call so the Function
// node only needs the `nc3` module (xstate stays internal to this package — no second
// external module / no userDir install needed; see docs/xstate-integration-plan.md §9.1).
function startElmoTransport(effects, input) {
  return createActor(createElmoTransport(effects), { input: input || {} }).start();
}

module.exports = { createElmoTransport, startElmoTransport };
