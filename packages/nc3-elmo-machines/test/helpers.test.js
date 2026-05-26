'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { priorityInsert, dequeue, PRIORITY } = require('../src/queue');
const {
  LEAN_POLL,
  buildExtendedPoll,
  buildPollEnvelope,
  shouldExtend,
  omegaDegPerSec,
  computeRateHz,
  computePollDelayMs,
} = require('../src/poll');
const { ensureCr, clamp } = require('../src/util');
const { ticksPerRev, degPerSecToTicks } = require('../src/res');

test('priorityInsert: cmd before poll, stable FIFO within priority', () => {
  let q = [];
  q = priorityInsert(q, { id: 'p1', kind: 'poll', priority: PRIORITY.poll });
  q = priorityInsert(q, { id: 'c1', kind: 'cmd', priority: PRIORITY.cmd });
  q = priorityInsert(q, { id: 'c2', kind: 'cmd', priority: PRIORITY.cmd });
  q = priorityInsert(q, { id: 't1', kind: 'tilt', priority: PRIORITY.tilt });
  assert.deepEqual(q.map((x) => x.id), ['c1', 'c2', 't1', 'p1']);
});

test('priorityInsert: derives priority from kind when missing', () => {
  let q = [{ id: 'p1', kind: 'poll' }];
  q = priorityInsert(q, { id: 'c1', kind: 'cmd' });
  assert.deepEqual(q.map((x) => x.id), ['c1', 'p1']);
});

test('dequeue: takes head, returns rest', () => {
  const { inFlight, queue } = dequeue([{ id: 'a' }, { id: 'b' }]);
  assert.equal(inFlight.id, 'a');
  assert.deepEqual(queue.map((x) => x.id), ['b']);
  assert.deepEqual(dequeue([]), { inFlight: null, queue: [] });
});

test('ensureCr: appends CR once', () => {
  assert.equal(ensureCr('JV=1;BG'), 'JV=1;BG\r');
  assert.equal(ensureCr('JV=1;BG\r'), 'JV=1;BG\r');
  assert.equal(ensureCr(''), '\r');
  assert.equal(ensureCr(null), '\r');
});

test('clamp', () => {
  assert.equal(clamp(5, 1, 30), 5);
  assert.equal(clamp(0, 1, 30), 1);
  assert.equal(clamp(100, 1, 30), 30);
});

test('poll payloads: lean vs extended', () => {
  assert.equal(buildPollEnvelope({ id: 'p', extended: false }).cmd, LEAN_POLL);
  const ext = buildPollEnvelope({ id: 'p', extended: true }).cmd;
  for (const tok of ['TM', 'PX', 'VX', 'MS', 'MO', 'SO', 'SR', 'AF', 'OL[1]', 'OL[2]']) {
    assert.ok(ext.includes(tok), 'extended poll missing ' + tok);
  }
  assert.equal(buildPollEnvelope({ id: 'p' }).meta.topic, 'poll_data');
});

test('buildExtendedPoll: analog pressure param is opt-in', () => {
  assert.ok(!buildExtendedPoll({}).includes('AN'));
  assert.ok(buildExtendedPoll({ analogParam: 'AN[1]' }).includes('AN[1];'));
});

test('shouldExtend: true only past statePeriod', () => {
  assert.equal(shouldExtend(0, 999, 1000), false);
  assert.equal(shouldExtend(0, 1000, 1000), true);
  assert.equal(shouldExtend(5000, 5500, 1000), false);
});

test('omegaDegPerSec: ticks/s -> deg/s by resolution', () => {
  // high: 262144000 ticks/rev. The manual example: 728177 ticks/s ~= 1 deg/s.
  assert.ok(Math.abs(omegaDegPerSec(728177, 'high') - 1) < 1e-3);
  // 5 deg/s example: 3640888 ticks/s.
  assert.ok(Math.abs(omegaDegPerSec(3640888, 'high') - 5) < 1e-3);
  // low: 6553600 ticks/rev; -3276800 ticks/s ~= 180 deg/s (abs).
  assert.ok(Math.abs(omegaDegPerSec(-3276800, 'low') - 180) < 1e-3);
});

test('computeRateHz: clamp 1..30', () => {
  assert.equal(computeRateHz(0), 1); // rest -> 1 Hz
  assert.equal(computeRateHz(12), 1); // 12/12 = 1
  assert.equal(computeRateHz(360), 30); // 360/12 = 30
  assert.equal(computeRateHz(600), 30); // clamped
  assert.equal(computeRateHz(120), 10); // 120/12 = 10
});

test('computePollDelayMs: measured vs setpoint source', () => {
  // rest -> 1 Hz -> 1000 ms
  assert.equal(computePollDelayMs({ vx: 0, resolution: 'high', omegaSource: 'measured' }), 1000);
  // 360 deg/s -> 30 Hz -> ~33 ms
  assert.equal(
    computePollDelayMs({ vx: degPerSecToTicks(360, 'low'), resolution: 'low', omegaSource: 'measured' }),
    Math.round(1000 / 30)
  );
  // setpoint fallback before first VX poll
  assert.equal(computePollDelayMs({ omegaSource: 'setpoint', setpointDegS: 120 }), 100);
});

test('ticksPerRev matches CA[18]', () => {
  assert.equal(ticksPerRev('high'), 262144000);
  assert.equal(ticksPerRev('low'), 6553600);
});
