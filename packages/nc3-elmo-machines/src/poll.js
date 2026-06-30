'use strict';

const { clamp } = require('./util');
const { PRIORITY } = require('./queue');
const { ticksPerRev } = require('./res');

// Lean poll: data point (TM;PX) + live speed (VX) for the "ready" criterion (§4.4.4).
const DATA_POLL = 'TM;PX;VX;';
const LEAN_POLL = DATA_POLL;
const DATA_POLL_FIELDS = ['TM', 'PX', 'VX'];
const FAST_SEEK_POLL_FIELDS = ['VX', 'PX'];
const FAST_DATA_POLL_FIELDS = ['TM', 'PX'];
const STATE_POLL_FIELDS = ['MO', 'SO', 'SR'];
const FULL_STATE_POLL_FIELDS = ['MS', 'MO', 'SO', 'SR', 'AF', 'OL[1]', 'OL[2]'];
// One-shot poll on initial connect to read drive parameters not needed at run-time.
const INIT_PARAMS_POLL_FIELDS = ['KP[2]'];
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
  'KP[2]': 'kp2',
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
  else if (role === 'init_params') fields = INIT_PARAMS_POLL_FIELDS.slice();
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
  return 'poll_state';  // full_state, state, init_params all use poll_state
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

function sampleValue(sample, keys) {
  for (const key of keys) {
    if (sample && sample[key] != null && sample[key] !== '') {
      const n = Number(sample[key]);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function estimateVelocityFromPositionSamples(samples, options) {
  const o = options || {};
  const minSpanUs = Math.max(1, Number(o.minSpanUs) || 200000);
  const maxSpanUs = Math.max(minSpanUs, Number(o.maxSpanUs) || 3000000);
  const data = Array.isArray(samples)
    ? samples.map((sample) => ({
      positionTicks: sampleValue(sample, ['positionTicks', 'position', 'px']),
      tmUs: sampleValue(sample, ['tmUs', 'tm_us', 'tm']),
    })).filter((sample) => Number.isFinite(sample.positionTicks) && Number.isFinite(sample.tmUs))
    : [];
  if (data.length < 2) return null;

  const last = data[data.length - 1];
  let first = null;
  for (let i = data.length - 2; i >= 0; i--) {
    const candidate = data[i];
    const dtUs = last.tmUs - candidate.tmUs;
    if (!(dtUs > 0)) continue;
    if (dtUs > maxSpanUs) break;
    first = candidate;
  }
  if (!first) return null;

  const dtUs = last.tmUs - first.tmUs;
  if (dtUs < minSpanUs) return null;
  const ticksPerSec = (last.positionTicks - first.positionTicks) * 1000000 / dtUs;
  if (!Number.isFinite(ticksPerSec)) return null;
  return {
    ticksPerSec,
    dtSec: dtUs / 1000000,
    positionDeltaTicks: last.positionTicks - first.positionTicks,
  };
}

// Legacy helper for speed-proportional polling. The runtime scheduler now uses fixed
// normalPollHz/fastRawPollHz, but this remains exported for callers that still need it.
function computeRateHz(omegaDegSec, options) {
  const o = options || {};
  const minHz = o.minHz == null ? 1 : o.minHz;
  const maxHz = o.maxHz == null ? 30 : o.maxHz;
  return clamp(Math.abs(omegaDegSec) / 12, minHz, maxHz);
}

// Delay (ms) until the next poll. Normal mode is fixed-rate; fast raw mode is
// start-to-start from lastFastPollStartedAt so 30 Hz is not slowed by response latency.
//
// `options.timerCompensationMs` (default 0) is subtracted from the computed delay before
// the floor at 1 ms. On Windows `setTimeout` is quantized to the system timer tick
// (~15.625 ms by default), so a naive `setTimeout(18)` actually lands on the SECOND tick
// (~31 ms) — losing one whole tick every cycle. Passing half a tick (~8 ms) as the
// compensation rounds the request to the NEAREST tick instead of always ceiling it, which
// recovers the lost tick at high target frequencies (30 Hz target jumps from ~22 Hz actual
// to ~32 Hz on Windows). On Linux / with `timeBeginPeriod(1)` the effect is negligible.
function computePollDelayMs(context, options) {
  const ctx = context || {};
  const o = options || {};
  const compensation = Math.max(0, Number(o.timerCompensationMs) || 0);
  if (ctx.fastRawActive || ctx.lowVelocityPollActive) {
    const cfg = ctx.pollConfig || {};
    const configuredHz = ctx.fastRawActive ? cfg.fastRawPollHz : cfg.lowVelocityPollHz;
    const hz = clamp(Number(configuredHz) || (ctx.fastRawActive ? 30 : 10), 1, 30);
    const targetMs = 1000 / hz;
    const startedAt = Number(ctx.lastFastPollStartedAt) || 0;
    const nowMs = Number(ctx.nowMs) || 0;
    const elapsedMs = startedAt > 0 && nowMs > 0 ? Math.max(0, nowMs - startedAt) : 0;
    return Math.max(1, Math.round(targetMs - elapsedMs - compensation));
  }
  const cfg = ctx.pollConfig || {};
  const minHz = o.minHz == null ? 1 : o.minHz;
  const maxHz = o.maxHz == null ? 30 : o.maxHz;
  const rate = clamp(Number(cfg.normalPollHz) || Number(o.normalPollHz) || 2, minHz, maxHz);
  return Math.max(1, Math.round(1000 / rate - compensation));
}

module.exports = {
  DATA_POLL,
  LEAN_POLL,
  DATA_POLL_FIELDS,
  FAST_SEEK_POLL_FIELDS,
  FAST_DATA_POLL_FIELDS,
  STATE_POLL_FIELDS,
  FULL_STATE_POLL_FIELDS,
  INIT_PARAMS_POLL_FIELDS,
  buildStatePoll,
  buildFullStatePoll,
  buildExtendedPoll,
  buildPollFields,
  shouldExtend,
  buildPollEnvelope,
  omegaDegPerSec,
  estimateVelocityFromPositionSamples,
  computeRateHz,
  computePollDelayMs,
};
