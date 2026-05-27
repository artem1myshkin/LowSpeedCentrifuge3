'use strict';

const { clamp } = require('./util');
const { PRIORITY } = require('./queue');
const { ticksPerRev } = require('./res');

// Lean poll: data point (TM;PX) + live speed (VX) for the "ready" criterion (§4.4.4).
const DATA_POLL = 'TM;PX;VX;';
const LEAN_POLL = DATA_POLL;

// State poll: critical health/state fields, emitted ~once per second (§4.4.4).
// AN[?] (analog pressure input) index is unconfirmed on the stand (§11.7), so it is
// opt-in via options.analogParam rather than baked in.
function buildStatePoll(options) {
  const opts = options || {};
  let cmd = 'MS;MO;SO;SR;AF;OL[1];OL[2];';
  if (opts.analogParam) cmd += opts.analogParam + ';';
  return cmd;
}

const buildExtendedPoll = buildStatePoll;

// Whether the next scheduler tick should enqueue the slower state payload.
function shouldExtend(lastExtendedAt, now, statePeriodMs) {
  return (now - lastExtendedAt) >= statePeriodMs;
}

function buildPollEnvelope(args) {
  const a = args || {};
  const role = a.role || (a.extended ? 'state' : 'data');
  const isState = role === 'state';
  return {
    id: a.id,
    kind: 'poll',
    priority: PRIORITY.poll,
    cmd: isState ? buildStatePoll(a.options) : DATA_POLL,
    extended: isState,
    pollRole: isState ? 'state' : 'data',
    expect: 'parse',
    meta: { topic: isState ? 'poll_state' : 'poll_data', origin: 'transport', pollRole: isState ? 'state' : 'data' },
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
  const omega = ctx.omegaSource === 'setpoint'
    ? Math.abs(Number(ctx.setpointDegS) || 0)
    : omegaDegPerSec(ctx.vx, ctx.resolution);
  const rate = computeRateHz(omega, options);
  return Math.round(1000 / rate);
}

module.exports = {
  DATA_POLL,
  LEAN_POLL,
  buildStatePoll,
  buildExtendedPoll,
  shouldExtend,
  buildPollEnvelope,
  omegaDegPerSec,
  computeRateHz,
  computePollDelayMs,
};
