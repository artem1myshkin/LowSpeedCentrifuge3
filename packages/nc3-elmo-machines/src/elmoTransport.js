'use strict';

const { setup, assign, createActor } = require('xstate');
const { priorityInsert, dequeue: queueDequeue, PRIORITY } = require('./queue');
const { buildPollEnvelope, shouldExtend, computePollDelayMs } = require('./poll');
const { parseElmoScalars } = require('./parse');
const { clamp, splitElmoCommands } = require('./util');

// SR is included so the homing run can watch bit 7 (HM[1] active -> 0 when the index mark
// is captured) without a separate poll (Recommendations section 6).
const MOTION_STATUS_POLL_CMDS = ['MS', 'TM', 'PX', 'VX', 'SR'];

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
//   motionMaxMisses         -> same, but while waiting for SO=1 / motion done (default 6): a
//                              lost datagram during a long wait re-polls instead of tripping
//                              the ST;MO=0 safety stop on a healthy drive (B1.8)
//   soReadyTimeoutMs        -> max wait after MO=1 until SO becomes 1 (default 30000)
//   envelope meta.minMotionMs -> earliest time after BG at which MS=0/1 counts as motion done
//   statePeriodMs           -> minimal state-poll cadence (default 1000)
//   probeCmd                -> liveness probe sent on connect (default single TM read)
//   initialFullState        -> enqueue full-state poll after connect/recover (default true)
//   pollOptions             -> { normalPollHz, minHz, maxHz, analogParam } for poll scheduling/payload
// input.pollConfig:
//   { isRecording, isRecordingRaw, rawDataEnabled, normalPollHz, fastRawPollHz, lowVelocityPollHz, ... }
//   toggles the fast raw recording and low-resolution velocity poll paths without coupling the
//   machine to Node-RED globals.

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
  const motionMaxMisses = e.motionMaxMisses == null ? Math.max(maxMisses, 6) : e.motionMaxMisses;
  const soReadyTimeoutMs = e.soReadyTimeoutMs == null ? 30000 : e.soReadyTimeoutMs;
  const statePeriodMs = e.statePeriodMs == null ? 1000 : e.statePeriodMs;
  const motionPollDelayMs = e.motionPollDelayMs == null ? 500 : e.motionPollDelayMs;
  const motionDoneTimeoutMs = e.motionDoneTimeoutMs == null ? 120000 : e.motionDoneTimeoutMs;
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
      lowVelocityPollingEnabled: cfg.lowVelocityPollingEnabled !== false,
      normalPollHz: clamp(finiteNumber(cfg.normalPollHz, 2), 1, 30),
      fastRawPollHz: clamp(finiteNumber(cfg.fastRawPollHz, 30), 1, 30),
      lowVelocityPollHz: clamp(finiteNumber(cfg.lowVelocityPollHz, 10), 1, 30),
      fastStableSamples: Math.round(clamp(finiteNumber(cfg.fastStableSamples, 3), 1, 50)),
      fastStableToleranceTicks: Math.max(0, finiteNumber(cfg.fastStableToleranceTicks, 1000)),
    };
  }

  function shouldFastRawPoll(config) {
    const cfg = normalizePollConfig(config);
    return cfg.fastRawPollingEnabled && cfg.isRecording && cfg.isRecordingRaw && cfg.rawDataEnabled;
  }

  function shouldLowVelocityPoll(config, resolution) {
    const cfg = normalizePollConfig(config);
    return cfg.lowVelocityPollingEnabled && resolution === 'low';
  }

  function fastDataPollActive(context) {
    return !!(context.fastRawActive || context.lowVelocityPollActive);
  }

  function isFastPollRole(role) {
    return role === 'fast_seek' || role === 'fast_data';
  }

  function fastPollRoleFor(context) {
    return 'fast_data';
  }

  function normalizeEnvelope(env) {
    const src = env || {};
    const kind = src.kind || 'cmd';
    const cmds = splitElmoCommands(src.cmds || src.cmd);
    const priority = typeof src.priority === 'number'
      ? src.priority
      : (isOperatorAbortEnvelope(src) ? PRIORITY.init + 1 : (PRIORITY[kind] || 0));
    return {
      id: src.id || nextId(),
      kind,
      priority,
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
      ? ['ms', 'mo', 'so', 'sr', 'af', 'ol1', 'ol2', 'vh2']
      : (role === 'state' ? ['mo', 'so', 'sr', 'ms'] : ['tm', 'px', 'vx']));
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

  function topicOfEnvelope(env) {
    return (env && env.meta && env.meta.topic) || (env && env.topic) || '';
  }

  function commandRequests(env, pattern) {
    return commandListFor(env).some((cmd) => pattern.test(String(cmd || '').toUpperCase()));
  }

  function envelopeRequests(env, pattern) {
    return splitElmoCommands(env && (env.cmds || env.cmd)).some((cmd) => pattern.test(String(cmd || '').toUpperCase()));
  }

  function isOperatorAbortEnvelope(env) {
    const topic = topicOfEnvelope(env);
    if (topic === 'drive_stop' || topic === 'motor_off') return true;
    // motor_on starts with ST only to clear a stale motion command before MO=1 (B1.7);
    // it is a normal command, not an operator abort, so it must not preempt in-flight work.
    if (topic === 'motor_on') return false;
    return envelopeRequests(env, /\bST\b|\bMO\s*=\s*0\b/);
  }

  function isMoOnCommand(cmd) {
    return /\bMO\s*=\s*1\b/.test(String(cmd || '').toUpperCase());
  }

  function isBgCommand(cmd) {
    return /\bBG\b/.test(String(cmd || '').toUpperCase());
  }

  function needsSoReadyWait(env) {
    return isAckable(env) && isMoOnCommand(commandFor(env));
  }

  // 'PA=@PX<+/-ticks>' — dynamic one-revolution target: the absolute position is computed
  // from the PX read answered right before this part, not from a poll snapshot taken before
  // a head switch (stale and scaled in old-resolution ticks). meta.targetPosition is patched
  // so the motion-done check tracks the resolved target. Falls back to the precomputed
  // meta.targetPosition when the PX reply does not parse.
  const DYNAMIC_PA_RE = /^PA=@PX([+-]\d+(?:\.\d+)?)$/i;

  function resolveDynamicPa(cmd, raw, meta) {
    const m = DYNAMIC_PA_RE.exec(String(cmd == null ? '' : cmd).trim());
    if (!m) return null;
    const offset = Number(m[1]);
    const px = parseElmoScalars(raw).px;
    const fallbackTarget = Number(meta && meta.targetPosition);
    const base = Number.isFinite(px) ? px : (Number.isFinite(fallbackTarget) ? fallbackTarget - offset : NaN);
    if (!Number.isFinite(base)) return null;
    const target = Math.round(base + offset);
    return { cmd: 'PA=' + target, targetPosition: target, basePosition: Math.round(base) };
  }

  function needsMotionDoneWait(env) {
    return isAckable(env) && env.meta && env.meta.waitForMotionDone === true && isBgCommand(commandFor(env));
  }

  function canOperatorAbort(env) {
    return !!env;
  }

  function hasPendingCommandPart(env) {
    return isMultiPart(env) && cursorOf(env) < env.cmds.length;
  }

  function soReadyAndHasPendingCommandPart(env, raw) {
    return soReadyFromRaw(raw) && hasPendingCommandPart(env);
  }

  function soReadyFromRaw(raw) {
    return parseElmoScalars(raw).so === 1;
  }

  function motionDoneTimeoutFor(env) {
    const n = Number(env && env.meta && env.meta.motionDoneTimeoutMs);
    return Number.isFinite(n) && n > 0 ? n : motionDoneTimeoutMs;
  }

  // meta.minMotionMs: ignore "done" verdicts this soon after BG — right after the start the
  // drive may still report MS=0 of the previous (completed) command (homing revolution, B2.2).
  function motionDoneFromRaw(raw, env, context) {
    const f = parseElmoScalars(raw);
    const ms = f.ms;
    const meta = (env && env.meta) || {};
    const minMotionMs = Math.max(0, finiteNumber(meta.minMotionMs, 0));
    const startedAt = Number(context && context.motionWaitStartedAt) || 0;
    if (minMotionMs > 0 && startedAt > 0 && now() - startedAt < minMotionMs) return false;
    const target = Number(meta.targetPosition);
    if (Number.isFinite(target) && f.px !== undefined) {
      const tolerance = Math.max(0, finiteNumber(meta.positionToleranceTicks, 0));
      const velocityTolerance = Math.max(0, finiteNumber(meta.velocityToleranceTicks, 0));
      const positionDone = Math.abs(Number(f.px) - target) <= tolerance;
      const notMoving = ms === 0 || ms === 1 || ms === 3
        || (f.vx !== undefined && Math.abs(Number(f.vx)) <= velocityTolerance);
      return positionDone && notMoving;
    }
    return ms === 0 || ms === 1;
  }

  function motionPollCursorOf(context) {
    return Math.max(0, Number(context && context.motionPollCursor) || 0);
  }

  function motionPollCmdsOf(context) {
    return Array.isArray(context && context.motionPollCmds) && context.motionPollCmds.length
      ? context.motionPollCmds
      : MOTION_STATUS_POLL_CMDS;
  }

  function motionPollCommandFor(context) {
    const cmds = motionPollCmdsOf(context);
    return cmds[Math.min(motionPollCursorOf(context), cmds.length - 1)];
  }

  function motionPollRawFor(context, raw) {
    return ((context && context.motionPollParts) || []).concat([raw]).join('');
  }

  function confirmPollRoleFor(env) {
    if (!isAckable(env)) return null;
    const meta = env.meta || {};
    if (meta.confirmPollRole) return meta.confirmPollRole;
    if (commandRequests(env, /\bOL\[1\]\s*=/)) return 'full_state';
    if (commandRequests(env, /\bOL\[2\]\s*=/)) return 'full_state';
    if (commandRequests(env, /\bAF\s*=/)) return 'full_state';
    if (commandRequests(env, /\bMO\s*=/)) return 'state';
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
      tooManyMotionMisses: ({ context }) => (Number(context.missCount) || 0) + 1 >= motionMaxMisses,
      // True while the in-flight request still has more atomic commands to send. Poll parts
      // must validate before advancing; command batches only require another part.
      hasNextPollPart: ({ context, event }) => {
        const env = context.inFlight;
        if (!isMultiPart(env)) return false;
        if (env.kind === 'poll' && !validateCurrentPollPart(env, event.raw).ok) return false;
        return cursorOf(env) < env.cmds.length - 1;
      },
      needsSoReadyWait: ({ context }) => needsSoReadyWait(context.inFlight),
      soReadyAndHasPendingCommandPart: ({ context, event }) => soReadyAndHasPendingCommandPart(context.inFlight, event.raw),
      soReady: ({ event }) => soReadyFromRaw(event.raw),
      needsMotionDoneWait: ({ context }) => needsMotionDoneWait(context.inFlight),
      hasNextMotionPollPart: ({ context }) => motionPollCursorOf(context) < motionPollCmdsOf(context).length - 1,
      motionDoneAfterMotionPoll: ({ context, event }) => motionDoneFromRaw(motionPollRawFor(context, event.raw), context.inFlight, context),
      operatorAbortCommand: ({ context, event }) => canOperatorAbort(context.inFlight) && isOperatorAbortEnvelope(event.envelope),
      motionWaitTimedOut: ({ context }) => {
        const startedAt = Number(context.motionWaitStartedAt) || 0;
        return startedAt > 0 && now() - startedAt >= motionDoneTimeoutFor(context.inFlight);
      },
    },
    delays: {
      POLL_DELAY: ({ context }) => computePollDelayMs({ ...context, nowMs: now() }, pollOptions),
      TIMEOUT: () => timeoutMs,
      CONNECT_TIMEOUT: () => connectTimeoutMs,
      RECONNECT_DELAY: () => reconnectMs,
      SO_READY_TIMEOUT: () => soReadyTimeoutMs,
      MOTION_POLL_DELAY: () => motionPollDelayMs,
    },
    actions: {
      configurePoll: assign(({ context, event }) => {
        const pollConfig = normalizePollConfig(event.config);
        const fastRawActive = shouldFastRawPoll(pollConfig);
        const lowVelocityPollActive = shouldLowVelocityPoll(pollConfig, context.resolution);
        const wasFastDataActive = fastDataPollActive(context);
        const patch = { pollConfig, fastRawActive, lowVelocityPollActive };
        if (fastDataPollActive(patch) !== wasFastDataActive || !fastDataPollActive(patch)) {
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
        if (f.resolution) {
          patch.resolution = f.resolution;
          patch.lowVelocityPollActive = shouldLowVelocityPoll(context.pollConfig, f.resolution);
        }
        if (f.ol1 !== undefined) patch.ol1 = f.ol1;
        if (f.ol2 !== undefined) patch.ol2 = f.ol2;
        if (f.mo !== undefined) patch.mo = f.mo;
        if (f.so !== undefined) patch.so = f.so;
        if (f.ms !== undefined) patch.ms = f.ms;
        if (f.sr !== undefined) patch.sr = f.sr;
        if (f.af !== undefined) patch.af = f.af;
        if (f.kp2 !== undefined) patch.kp2 = f.kp2;
        if (f.vh2 !== undefined) patch.vh2 = f.vh2;
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
        if (fastDataPollActive(context)) {
          const role = fastPollRoleFor(context);
          const hasDiagnostic = hasPollRole(queue, 'full_state') || hasPollRoleInFlight(context, 'full_state');
          if (!hasDiagnostic && !hasAnyFastPoll(queue) && !hasAnyFastPollInFlight(context)) {
            queue = priorityInsert(queue, buildPollEnvelope({ id: nextId(), role, options: pollOptions }));
          }
        } else if (!hasPollRole(queue, 'data') && !hasPollRoleInFlight(context, 'data')) {
          queue = priorityInsert(queue, buildPollEnvelope({ id: nextId(), role: 'data', options: pollOptions }));
        }
        // The state poll stays alive during fast raw polling too (4 atomic reads per second,
        // negligible against 30 Hz TM/PX). Stand finding 2026-09-17: with it suppressed, MS
        // froze at the value captured right after BG and the scenario's MS criterion timed out
        // while the speed was already inside the window.
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

      enqueueInitialParamsPoll: assign(({ context }) => {
        if (!initialFullState) return {};
        if (hasPollRole(context.queue, 'init_params') || hasPollRoleInFlight(context, 'init_params')) return {};
        return {
          queue: priorityInsert(context.queue, buildPollEnvelope({ id: nextId(), role: 'init_params', options: pollOptions })),
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

      emitStarted: ({ context }) => {
        const env = context.inFlight;
        if (isAckable(env)) emitEvent({ type: 'CMD.STARTED', id: env.id, topic: topicFor(env), meta: env.meta || {} });
      },

      // After a part validates, append its raw and advance the cursor; sendingNextPart then
      // emits the next atomic command. If the next command is a dynamic PA token, resolve it
      // from the reply just collected (the PX read preceding it).
      collectPollPart: assign(({ context, event }) => {
        const env = context.inFlight;
        if (!isMultiPart(env)) return {};
        const cursor = cursorOf(env) + 1;
        let cmds = env.cmds;
        let meta = env.meta;
        const resolved = cursor < cmds.length ? resolveDynamicPa(cmds[cursor], event.raw, meta) : null;
        if (resolved) {
          cmds = cmds.slice();
          cmds[cursor] = resolved.cmd;
          meta = { ...meta, targetPosition: resolved.targetPosition, basePosition: resolved.basePosition };
        }
        return {
          inFlight: {
            ...env,
            cmds,
            meta,
            parts: (env.parts || []).concat([event.raw]),
            cursor,
          },
        };
      }),

      collectSoReadyPart: assign(({ context, event }) => {
        const env = context.inFlight;
        if (!isMultiPart(env)) return {};
        return {
          inFlight: {
            ...env,
            parts: (env.parts || []).concat([event.raw]),
          },
        };
      }),

      markSoWait: assign(() => ({ soWaitStartedAt: now() })),
      clearSoWait: assign({ soWaitStartedAt: 0 }),

      sendProbe: () => {
        sendCmd(probeCmd);
      },

      sendSoPoll: () => {
        sendCmd('SO');
      },

      startMotionPoll: assign(() => ({
        motionPollCmds: MOTION_STATUS_POLL_CMDS,
        motionPollCursor: 0,
        motionPollParts: [],
      })),

      sendMotionPollPart: ({ context }) => {
        sendCmd(motionPollCommandFor(context));
      },

      markMotionWait: assign(({ context }) => (context.motionWaitStartedAt ? {} : { motionWaitStartedAt: now() })),
      clearMotionWait: assign({ motionWaitStartedAt: 0 }),
      clearMotionPoll: assign({ motionPollCmds: [], motionPollCursor: 0, motionPollParts: [] }),

      collectMotionPollPart: assign(({ context, event }) => ({
        motionPollParts: (context.motionPollParts || []).concat([event.raw]),
      })),

      advanceMotionPoll: assign(({ context }) => ({
        motionPollCursor: motionPollCursorOf(context) + 1,
      })),

      ingestMotionPoll: assign(({ context, event }) => {
        const f = parseElmoScalars(motionPollRawFor(context, event.raw));
        const patch = {};
        if (f.tm !== undefined) patch.tm = f.tm;
        if (f.px !== undefined) patch.px = f.px;
        if (f.vx !== undefined) { patch.vx = f.vx; patch.omegaSource = 'measured'; }
        if (f.ms !== undefined) patch.ms = f.ms;
        if (f.sr !== undefined) patch.sr = f.sr;
        return patch;
      }),

      forwardMotionPollData: ({ context, event }) => {
        forwardResp(motionPollRawFor(context, event.raw), 'poll_data');
      },

      // Forward the reassembled command echoes downstream BEFORE entering a long wait
      // (SO-ready, motion-done). For waitForMotionDone envelopes the regular forwardAndAck
      // dispatch never runs, so without this the ResponseParser would not see the
      // OL[1]/CA[18]/PX echoes of a driveInit batch until after the init revolution —
      // leaving the poll context on the pre-switch resolution (velocity display off by the
      // 40x head ratio, commands validated against the old range limits).
      forwardBatchParts: ({ context, event }) => {
        const env = context.inFlight;
        if (!isAckable(env) || !isMultiPart(env)) return;
        forwardResp(rawFor(env, event.raw), topicFor(env));
      },

      // ELMO answers with '?' (observed ':?') when it rejects a command. Poll parts are
      // validated by field, but command batches only advance — surface a rejected write so a
      // failed OL[1]/CA[18] switch lands in the journal instead of silently degrading the init.
      reportRejectedPart: ({ context, event }) => {
        const env = context.inFlight;
        if (!isAckable(env)) return;
        const raw = String(event.raw == null ? '' : event.raw);
        if (raw.indexOf('?') === -1) return;
        emitEvent({
          type: 'CMD.PART_REJECTED',
          id: env.id,
          cmd: commandFor(env),
          raw,
          topic: topicFor(env),
          meta: env.meta || {},
        });
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
        if (isAckable(env)) emitEvent({ type: 'CMD.ACKED', id: env.id, raw, topic: topicFor(env), meta: env.meta || {} });
      },

      failInFlight: ({ context }) => {
        const env = context.inFlight;
        if (isAckable(env)) emitEvent({ type: 'CMD.FAILED', id: env.id, reason: 'timeout', topic: topicFor(env), meta: env.meta || {} });
      },

      failInFlightAborted: ({ context }) => {
        const env = context.inFlight;
        if (isAckable(env)) emitEvent({ type: 'CMD.FAILED', id: env.id, reason: 'operator_aborted', topic: topicFor(env), meta: env.meta || {} });
      },

      failSoWait: ({ context }) => {
        const env = context.inFlight;
        if (!isAckable(env)) return;
        emitEvent({
          type: 'CMD.FAILED',
          id: env.id,
          reason: 'so_timeout',
          message: 'SO did not become 1 within ' + soReadyTimeoutMs + ' ms after MO=1',
          topic: topicFor(env),
          meta: env.meta || {},
        });
      },

      completeMotionWait: ({ context, event }) => {
        const env = context.inFlight;
        if (!isAckable(env)) return;
        const raw = motionPollRawFor(context, event.raw);
        emitEvent({ type: 'CMD.COMPLETED', id: env.id, raw, topic: topicFor(env), meta: env.meta || {} });
      },

      failMotionWait: ({ context }) => {
        const env = context.inFlight;
        if (!isAckable(env)) return;
        const timeout = motionDoneTimeoutFor(env);
        emitEvent({
          type: 'CMD.FAILED',
          id: env.id,
          reason: 'motion_timeout',
          message: 'Motion did not complete within ' + timeout + ' ms after BG',
          topic: topicFor(env),
          meta: env.meta || {},
        });
      },

      sendEmergencyStop: () => {
        sendCmd('ST');
        sendCmd('MO=0');
      },

      bumpMiss: assign(({ context }) => ({ missCount: (Number(context.missCount) || 0) + 1 })),
      resetMiss: assign({ missCount: 0 }),
      freeInFlight: assign({ inFlight: null }),

      statusOffline: () => setStatus({ fill: 'red', shape: 'ring', text: 'ELMO offline' }),
      statusConnecting: () => setStatus({ fill: 'yellow', shape: 'ring', text: 'ELMO connecting' }),
      statusIdle: () => setStatus({ fill: 'green', shape: 'dot', text: 'ELMO online' }),
      statusBusy: () => setStatus({ fill: 'blue', shape: 'dot', text: 'ELMO busy' }),
      statusWaitingSo: () => setStatus({ fill: 'yellow', shape: 'dot', text: 'ELMO waiting SO=1' }),
      statusWaitingMotion: () => setStatus({ fill: 'yellow', shape: 'dot', text: 'ELMO waiting motion done' }),
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
        fastRawActive: shouldFastRawPoll(pollConfig),
        lowVelocityPollActive: shouldLowVelocityPoll(pollConfig, (input && input.resolution) || 'high'),
        fastStable: false,
        fastStableCount: 0,
        lastFastVx: undefined,
        lastFastPollStartedAt: 0,
        soWaitStartedAt: 0,
        motionWaitStartedAt: 0,
        motionPollCmds: [],
        motionPollCursor: 0,
        motionPollParts: [],
        kp2: null,
        vh2: null,
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
          'ELMO.RESP': { target: '#transport.connected', actions: ['resetMiss', 'enqueueInitialFullStatePoll', 'enqueueInitialParamsPoll'] },
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
            entry: ['statusBusy', 'takeNext', 'emitStarted', 'sendInFlight'],
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
              'UI.CMD': [
                { guard: 'operatorAbortCommand', target: 'idle', actions: ['failInFlightAborted', 'freeInFlight', 'clearSoWait', 'clearMotionWait', 'enqueueCmd'] },
                { actions: 'enqueueCmd' },
              ],
              // Multi-part: if the just-arrived part validated and more atomic commands remain,
              // collect it and send the next; otherwise dispatch the (whole, reassembled) frame.
              // reportRejectedPart/forwardBatchParts run before collectPollPart on purpose:
              // both read the pre-advance cursor / pre-append parts.
              'ELMO.RESP': [
                { guard: 'needsSoReadyWait', target: 'waitingForSoReady', actions: ['resetMiss', 'reportRejectedPart', 'forwardBatchParts', 'collectPollPart', 'markSoWait'] },
                { guard: 'needsMotionDoneWait', target: 'waitingForMotionDone', actions: ['resetMiss', 'reportRejectedPart', 'forwardBatchParts', 'markMotionWait'] },
                { guard: 'hasNextPollPart', target: 'sendingNextPart', actions: ['resetMiss', 'reportRejectedPart', 'collectPollPart'] },
                { target: 'dispatch', actions: ['resetMiss', 'reportRejectedPart', 'ingestResp', 'forwardAndAck', 'enqueueDiagnosticOnBadPoll', 'enqueueConfirmPoll'] },
              ],
              'ELMO.TIMEOUT': [
                { guard: 'tooManyMisses', target: '#transport.offline', actions: ['failInFlight', 'bumpMiss', 'freeInFlight'] },
                { target: 'idle', actions: ['failInFlight', 'bumpMiss', 'freeInFlight'] },
              ],
            },
          },
          // SO-ready wait after MO=1. Nested so a lost SO reply datagram is re-polled after
          // TIMEOUT (instead of silently waiting for the 30 s SO_READY_TIMEOUT and then
          // tripping the safety stop on a healthy drive), and so consecutive SO=0 replies are
          // paced by MOTION_POLL_DELAY instead of hammering the drive in a tight loop (B1.8).
          waitingForSoReady: {
            entry: 'statusWaitingSo',
            initial: 'polling',
            after: {
              SO_READY_TIMEOUT: {
                target: 'idle',
                actions: ['failSoWait', 'sendEmergencyStop', 'freeInFlight', 'clearSoWait'],
              },
            },
            on: {
              'UI.CMD': [
                { guard: 'operatorAbortCommand', target: 'idle', actions: ['failInFlightAborted', 'freeInFlight', 'clearSoWait', 'enqueueCmd'] },
                { actions: 'enqueueCmd' },
              ],
            },
            states: {
              polling: {
                entry: 'sendSoPoll',
                after: {
                  TIMEOUT: [
                    { guard: 'tooManyMotionMisses', target: '#transport.offline', actions: ['failSoWait', 'bumpMiss', 'sendEmergencyStop', 'freeInFlight', 'clearSoWait'] },
                    { target: 'polling', reenter: true, actions: ['bumpMiss'] },
                  ],
                },
                on: {
                  'ELMO.RESP': [
                    { guard: 'soReadyAndHasPendingCommandPart', target: '#transport.connected.sendingNextPart', actions: ['resetMiss', 'collectSoReadyPart', 'clearSoWait'] },
                    { guard: 'soReady', target: '#transport.connected.dispatch', actions: ['resetMiss', 'forwardAndAck', 'enqueueConfirmPoll', 'clearSoWait'] },
                    { target: 'pause', actions: ['resetMiss'] },
                  ],
                  'ELMO.TIMEOUT': [
                    { guard: 'tooManyMotionMisses', target: '#transport.offline', actions: ['failSoWait', 'bumpMiss', 'sendEmergencyStop', 'freeInFlight', 'clearSoWait'] },
                    { target: 'polling', reenter: true, actions: ['bumpMiss'] },
                  ],
                },
              },
              pause: {
                after: { MOTION_POLL_DELAY: 'polling' },
              },
            },
          },
          waitingForMotionDone: {
            entry: ['statusWaitingMotion', 'startMotionPoll', 'sendMotionPollPart'],
            on: {
              'UI.CMD': [
                { guard: 'operatorAbortCommand', target: 'idle', actions: ['failInFlightAborted', 'freeInFlight', 'clearMotionWait', 'clearMotionPoll', 'enqueueCmd'] },
                { actions: 'enqueueCmd' },
              ],
              'ELMO.RESP': [
                { guard: 'hasNextMotionPollPart', target: 'sendingMotionPollPart', actions: ['resetMiss', 'collectMotionPollPart', 'advanceMotionPoll'] },
                { guard: 'motionDoneAfterMotionPoll', target: 'dispatch', actions: ['resetMiss', 'ingestMotionPoll', 'forwardMotionPollData', 'completeMotionWait', 'clearMotionWait', 'clearMotionPoll', 'enqueueConfirmPoll'] },
                { target: 'motionPollPause', actions: ['resetMiss', 'ingestMotionPoll', 'forwardMotionPollData', 'clearMotionPoll'] },
              ],
              'ELMO.TIMEOUT': [
                { guard: 'tooManyMotionMisses', target: '#transport.offline', actions: ['failMotionWait', 'bumpMiss', 'sendEmergencyStop', 'freeInFlight', 'clearMotionWait', 'clearMotionPoll'] },
                { target: 'motionPollPause', actions: ['bumpMiss', 'clearMotionPoll'] },
              ],
            },
          },
          sendingMotionPollPart: {
            entry: 'sendMotionPollPart',
            always: 'waitingForMotionPollPart',
          },
          waitingForMotionPollPart: {
            on: {
              'UI.CMD': [
                { guard: 'operatorAbortCommand', target: 'idle', actions: ['failInFlightAborted', 'freeInFlight', 'clearMotionWait', 'clearMotionPoll', 'enqueueCmd'] },
                { actions: 'enqueueCmd' },
              ],
              'ELMO.RESP': [
                { guard: 'hasNextMotionPollPart', target: 'sendingMotionPollPart', actions: ['resetMiss', 'collectMotionPollPart', 'advanceMotionPoll'] },
                { guard: 'motionDoneAfterMotionPoll', target: 'dispatch', actions: ['resetMiss', 'ingestMotionPoll', 'forwardMotionPollData', 'completeMotionWait', 'clearMotionWait', 'clearMotionPoll', 'enqueueConfirmPoll'] },
                { target: 'motionPollPause', actions: ['resetMiss', 'ingestMotionPoll', 'forwardMotionPollData', 'clearMotionPoll'] },
              ],
              'ELMO.TIMEOUT': [
                { guard: 'tooManyMotionMisses', target: '#transport.offline', actions: ['failMotionWait', 'bumpMiss', 'sendEmergencyStop', 'freeInFlight', 'clearMotionWait', 'clearMotionPoll'] },
                { target: 'motionPollPause', actions: ['bumpMiss', 'clearMotionPoll'] },
              ],
            },
          },
          motionPollPause: {
            on: {
              'UI.CMD': [
                { guard: 'operatorAbortCommand', target: 'idle', actions: ['failInFlightAborted', 'freeInFlight', 'clearMotionWait', 'clearMotionPoll', 'enqueueCmd'] },
                { actions: 'enqueueCmd' },
              ],
            },
            after: {
              MOTION_POLL_DELAY: [
                { guard: 'motionWaitTimedOut', target: 'idle', actions: ['failMotionWait', 'sendEmergencyStop', 'freeInFlight', 'clearMotionWait', 'clearMotionPoll'] },
                { target: 'waitingForMotionDone' },
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
