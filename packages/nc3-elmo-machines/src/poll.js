'use strict';

const { clamp } = require('./util');
const { PRIORITY } = require('./queue');
const { ticksPerRev } = require('./res');

// Lean poll: data point (TM;PX) + live speed (VX) for the "ready" criterion (§4.4.4).
const DATA_POLL = 'TM;PX;VX;';
const LEAN_POLL = DATA_POLL;
const DATA_POLL_FIELDS = ['TM', 'PX', 'VX'];
const FAST_SEEK_POLL_FIELDS = ['VX', 'PX'];
const FAST_DATA_POLL_FIELDS = ['VX', 'PX', 'TM'];
const STATE_POLL_FIELDS = ['MO', 'SO', 'SR'];
const FULL_STATE_POLL_FIELDS = ['MS', 'MO', 'SO', 'SR', 'AF', 'OL[1]', 'OL[2]'];
const FIELD_KEYS = {
  TM: 'tm',
  PX: 'px',
  VX: 'vx',
  MS: 'ms',
  MO: 'mo',
  SO: 'so',
  SR: 'sr',
  AF: 'af',
  'OL[1]': 'ol1',
  'OL[2]': 'ol2',
};

// State poll: small live health fields, emitted ~once per second (§4.4.4).
// AN[?] (analog pressure input) index is unconfirmed on the stand (§11.7), so it is
// opt-in for full_state via options.analogParam rather than baked in.
function buildStatePoll(options) {
  const opts = options || {};
  return buildPollFields('state', opts).map((field) => field + ';').join('');
}

function buildFullStatePoll(options) {
  const opts = options || {};
  return buildPollFields('full_state', opts).map((field) => field + ';').join('');
}

const buildExtendedPoll = buildFullStatePoll;

// Whether the next scheduler tick should enqueue the slower state payload.
function shouldExtend(lastExtendedAt, now, statePeriodMs) {
  return (now - lastExtendedAt) >= statePeriodMs;
}

function buildPollFields(role, options) {
  const opts = options || {};
  let fields;
  if (role === 'full_state') fields = FULL_STATE_POLL_FIELDS.slice();
  else if (role === 'state') fields = STATE_POLL_FIELDS.slice();
  else if (role === 'fast_seek') fields = FAST_SEEK_POLL_FIELDS.slice();
  else if (role === 'fast_data') fields = FAST_DATA_POLL_FIELDS.slice();
  else fields = DATA_POLL_FIELDS.slice();
  if (role === 'full_state' && opts.analogParam) fields.push(String(opts.analogParam));
  return fields;
}

function requiredKeysFor(fields) {
  return fields.map((field) => FIELD_KEYS[field]).filter(Boolean);
}

function pollTopicFor(role) {
  if (role === 'fast_seek') return 'poll_fast';
  if (role === 'data' || role === 'fast_data') return 'poll_data';
  return 'poll_state';
}

// UDP + ATOMIC commands. Stand finding: ELMO answers a batched line (`TM;PX;VX;`) poorly —
// it sends ONE datagram per parameter, and our single-in-flight assumption then mis-attributes
// leftover datagrams to the next request. So each logical poll is a SEQUENCE of one-parameter
// commands (`TM`, then `PX`, then `VX`), each producing exactly one reply datagram (1:1).
// The transport reassembles the parts into a single logical raw frame that downstream sees
// just like the old time-poll did. Over UDP the per-command round-trip is ~ms, so even three
// atomic commands per data poll fit well inside a 30 Hz budget — there is no idle-gap penalty.
function buildPollEnvelope(args) {
  const a = args || {};
  const role = a.role || (a.extended ? 'full_state' : 'data');
  const isNonData = role !== 'data';
  const isFast = role === 'fast_seek' || role === 'fast_data';
  const fields = buildPollFields(role, a.options);
  const cmds = fields.slice();
  const required = requiredKeysFor(fields);
  return {
    id: a.id,
    kind: 'poll',
    priority: typeof a.priority === 'number' ? a.priority : (isFast ? PRIORITY.fastPoll : PRIORITY.poll),
    cmd: cmds[0],
    cmds,
    cursor: 0,
    parts: [],
    required,
    partRequired: fields.map((field) => requiredKeysFor([field])),
    extended: isNonData,
    pollRole: role,
    expect: 'parse',
    meta: { topic: pollTopicFor(role), origin: 'transport', pollRole: role },
  };
}

// VX arrives in encoder ticks/s; convert to deg/s by current resolution (§4.4 P2).
function omegaDegPerSec(vx, resolution) {
  const tpr = ticksPerRev(resolution);
  if (!tpr) return 0;
  return (Math.abs(Number(vx) || 0) / tpr) * 360;
}

// rate_hz = clamp(|omega|/12, 1, 30): 30 points/rev at max speed, never below 1 Hz.
function computeRateHz(omegaDegSec, options) {
  const o = options || {};
  const minHz = o.minHz == null ? 1 : o.minHz;
  const maxHz = o.maxHz == null ? 30 : o.maxHz;
  return clamp(Math.abs(omegaDegSec) / 12, minHz, maxHz);
}

// Delay (ms) until the next poll, self-clocked from the speed source (§4.4.5).
// omegaSource lets the scheduler use the setpoint right after a speed command, before
// the first poll has reported the new VX (§4.4 fallback).
function computePollDelayMs(context, options) {
  const ctx = context || {};
  if (ctx.fastRawActive) {
    const cfg = ctx.pollConfig || {};
    const hz = clamp(Number(cfg.fastRawPollHz) || 30, 1, 30);
    const targetMs = 1000 / hz;
    const startedAt = Number(ctx.lastFastPollStartedAt) || 0;
    const nowMs = Number(ctx.nowMs) || 0;
    const elapsedMs = startedAt > 0 && nowMs > 0 ? Math.max(0, nowMs - startedAt) : 0;
    return Math.max(1, Math.round(targetMs - elapsedMs));
  }
  const omega = ctx.omegaSource === 'setpoint'
    ? Math.abs(Number(ctx.setpointDegS) || 0)
    : omegaDegPerSec(ctx.vx, ctx.resolution);
  const rate = computeRateHz(omega, options);
  return Math.round(1000 / rate);
}

module.exports = {
  DATA_POLL,
  LEAN_POLL,
  DATA_POLL_FIELDS,
  FAST_SEEK_POLL_FIELDS,
  FAST_DATA_POLL_FIELDS,
  STATE_POLL_FIELDS,
  FULL_STATE_POLL_FIELDS,
  buildStatePoll,
  buildFullStatePoll,
  buildExtendedPoll,
  buildPollFields,
  shouldExtend,
  buildPollEnvelope,
  omegaDegPerSec,
  computeRateHz,
  computePollDelayMs,
};
