'use strict';

const { setup, assign, createActor } = require('xstate');
const { priorityInsert, dequeue: queueDequeue, PRIORITY } = require('./queue');
const { buildPollEnvelope, shouldExtend, computePollDelayMs } = require('./poll');
const { parseElmoScalars } = require('./parse');

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
//   statePeriodMs           -> extended-poll cadence (default 1000)
//   probeCmd                -> liveness probe sent on connect (default lean poll)
//   pollOptions             -> { minHz, maxHz, analogParam } for poll scheduling/payload

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
  const probeCmd = e.probeCmd || 'TM;PX;VX;';
  const pollOptions = e.pollOptions || {};

  let seq = 0;
  const nextId = () => 'e' + (++seq);

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
    if (env && env.kind === 'poll') return 'poll_data';
    return undefined;
  }

  function isAckable(env) {
    return env && (env.kind === 'cmd' || env.kind === 'tilt');
  }

  function pollRoleOf(env) {
    return (env && env.meta && env.meta.pollRole) || (env && env.pollRole) || (env && env.extended ? 'state' : 'data');
  }

  function hasPollRole(queue, role) {
    return queue.some((env) => env && env.kind === 'poll' && pollRoleOf(env) === role);
  }

  function hasPollRoleInFlight(context, role) {
    return context.inFlight && context.inFlight.kind === 'poll' && pollRoleOf(context.inFlight) === role;
  }

  function missingFields(parsed, fields) {
    return fields.filter((field) => parsed[field] === undefined);
  }

  function validatePollResponse(env, raw) {
    if (!env || env.kind !== 'poll') return { ok: true, role: undefined, missing: [] };
    const role = pollRoleOf(env);
    const parsed = parseElmoScalars(raw);
    const required = role === 'state'
      ? ['ms', 'mo', 'so', 'sr', 'af', 'ol1', 'ol2']
      : ['tm', 'px', 'vx'];
    const missing = missingFields(parsed, required);
    return { ok: missing.length === 0, role, missing };
  }

  return setup({
    guards: {
      hasWork: ({ context }) => context.queue.length > 0,
    },
    delays: {
      POLL_DELAY: ({ context }) => computePollDelayMs(context, pollOptions),
      TIMEOUT: () => timeoutMs,
      CONNECT_TIMEOUT: () => connectTimeoutMs,
    },
    actions: {
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
        if (!validatePollResponse(context.inFlight, event.raw).ok) return {};
        const f = parseElmoScalars(event.raw);
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
        return patch;
      }),

      enqueuePoll: assign(({ context }) => {
        // Keep data and state polls as separate serialized requests; dedup by role.
        const t = now();
        let queue = context.queue;
        let lastExtendedAt = context.lastExtendedAt;
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

      takeNext: assign(({ context }) => {
        const { inFlight, queue } = queueDequeue(context.queue);
        return { inFlight, queue };
      }),

      sendInFlight: ({ context }) => {
        if (context.inFlight) sendTcp(context.inFlight.cmd);
      },

      sendProbe: () => {
        sendTcp(probeCmd);
      },

      forwardAndAck: ({ context, event }) => {
        const env = context.inFlight;
        const validation = validatePollResponse(env, event.raw);
        if (!validation.ok) {
          emitEvent({ type: 'POLL.BAD_FRAME', id: env.id, role: validation.role, missing: validation.missing, raw: event.raw });
          return;
        }
        forwardResp(event.raw, topicFor(env));
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
    context: ({ input }) => ({
      queue: [],
      inFlight: null,
      resolution: (input && input.resolution) || 'high',
      vx: 0,
      omegaSource: 'measured', // 'setpoint' right after a speed command (§4.4 fallback)
      setpointDegS: 0,
      lastExtendedAt: 0,
    }),
    initial: 'offline',
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
          'ELMO.RESP': '#transport.connected',
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
              'ELMO.RESP': { target: 'dispatch', actions: ['ingestResp', 'forwardAndAck'] },
              'ELMO.TIMEOUT': { target: '#transport.fault', actions: 'failInFlight' },
            },
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
          'ELMO.RESP': '#transport.connected',
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
