'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { priorityInsert, dequeue, PRIORITY } = require('../src/queue');
const {
  DATA_POLL,
  LEAN_POLL,
  buildStatePoll,
  buildFullStatePoll,
  buildExtendedPoll,
  buildPollEnvelope,
  shouldExtend,
  omegaDegPerSec,
  computeRateHz,
  computePollDelayMs,
} = require('../src/poll');
const { ensureCr, clamp, splitElmoCommands } = require('../src/util');
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

test('splitElmoCommands: splits semicolon and CR command batches', () => {
  assert.deepEqual(splitElmoCommands('AC=1;DC=2;JV=3;BG\r'), ['AC=1', 'DC=2', 'JV=3', 'BG']);
  assert.deepEqual(splitElmoCommands('OL[1]=0;\rCA[18]=262144000;'), ['OL[1]=0', 'CA[18]=262144000']);
  assert.deepEqual(splitElmoCommands(['ST', 'MO=0']), ['ST', 'MO=0']);
  assert.deepEqual(splitElmoCommands(';;'), []);
});

test('clamp', () => {
  assert.equal(clamp(5, 1, 30), 5);
  assert.equal(clamp(0, 1, 30), 1);
  assert.equal(clamp(100, 1, 30), 30);
});

test('poll payloads: atomic single-parameter commands (cmds[])', () => {
  assert.equal(DATA_POLL, LEAN_POLL);
  // ELMO answers one datagram per parameter, so a logical poll is a SEQUENCE of atomic
  // single-parameter commands (cmds[]); the transport reassembles parts into one logical raw.
  const data = buildPollEnvelope({ id: 'p', extended: false });
  assert.equal(data.cmd, 'TM');
  assert.deepEqual(data.cmds, ['TM', 'PX', 'VX']);
  assert.deepEqual(data.required, ['tm', 'px', 'vx']);
  assert.deepEqual(data.partRequired, [['tm'], ['px'], ['vx']]);
  const stateEnv = buildPollEnvelope({ id: 'p', role: 'state' });
  assert.equal(stateEnv.cmd, 'MO');
  assert.deepEqual(stateEnv.cmds, ['MO', 'SO', 'SR']);
  assert.deepEqual(stateEnv.required, ['mo', 'so', 'sr']);
  const extEnv = buildPollEnvelope({ id: 'p', extended: true });
  const ext = buildExtendedPoll();
  assert.equal(extEnv.cmd, 'MS');
  assert.deepEqual(extEnv.cmds, ['MS', 'MO', 'SO', 'SR', 'AF', 'OL[1]', 'OL[2]']);
  assert.deepEqual(extEnv.required, ['ms', 'mo', 'so', 'sr', 'af', 'ol1', 'ol2']);
  for (const tok of ['MS', 'MO', 'SO', 'SR', 'AF', 'OL[1]', 'OL[2]']) {
    assert.ok(ext.includes(tok), 'state poll missing ' + tok);
  }
  for (const tok of ['TM', 'PX', 'VX']) {
    assert.ok(!ext.includes(tok), 'state poll should not include data field ' + tok);
  }
  assert.equal(buildPollEnvelope({ id: 'p' }).meta.topic, 'poll_data');
  assert.equal(buildPollEnvelope({ id: 'p', role: 'state' }).meta.topic, 'poll_state');
  assert.equal(buildPollEnvelope({ id: 'p', role: 'state' }).pollRole, 'state');

  const fastSeek = buildPollEnvelope({ id: 'fast-seek', role: 'fast_seek' });
  assert.deepEqual(fastSeek.cmds, ['VX', 'PX']);
  assert.deepEqual(fastSeek.required, ['vx', 'px']);
  assert.equal(fastSeek.priority, PRIORITY.fastPoll);
  assert.equal(fastSeek.meta.topic, 'poll_fast');

  const fastData = buildPollEnvelope({ id: 'fast-data', role: 'fast_data' });
  assert.deepEqual(fastData.cmds, ['TM', 'PX']);
  assert.deepEqual(fastData.required, ['tm', 'px']);
  assert.equal(fastData.meta.topic, 'poll_data');
});

test('buildExtendedPoll: analog pressure param is opt-in', () => {
  assert.equal(buildStatePoll({}), 'MO;SO;SR;');
  assert.equal(buildExtendedPoll, buildFullStatePoll);
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
  // Normal mode is fixed at 2 Hz.
  assert.equal(computePollDelayMs({ vx: 0, resolution: 'high', omegaSource: 'measured' }), 500);
  assert.equal(
    computePollDelayMs({ vx: degPerSecToTicks(360, 'low'), resolution: 'low', omegaSource: 'measured' }),
    500
  );
  assert.equal(computePollDelayMs({ omegaSource: 'setpoint', setpointDegS: 120 }), 500);
  assert.equal(computePollDelayMs({ pollConfig: { normalPollHz: 4 } }), 250);
  // fast raw recording mode uses configured fixed rate, not velocity-derived rate
  assert.equal(
    computePollDelayMs({ fastRawActive: true, pollConfig: { fastRawPollHz: 30 }, vx: 0, resolution: 'high' }),
    Math.round(1000 / 30)
  );
  // If the logical fast poll already spent time waiting for its reply, do not add
  // another full period after it finishes (start-to-start fast cadence).
  assert.equal(
    computePollDelayMs({
      fastRawActive: true,
      pollConfig: { fastRawPollHz: 30 },
      lastFastPollStartedAt: 1000,
      nowMs: 1240,
    }),
    1
  );
  assert.equal(
    computePollDelayMs({
      fastRawActive: true,
      pollConfig: { fastRawPollHz: 1 },
      lastFastPollStartedAt: 1000,
      nowMs: 1240,
    }),
    760
  );
});

test('computePollDelayMs: timerCompensationMs trims the request to cross Windows tick boundary', () => {
  // 30 Hz fast target, 15 ms already spent on RTTs: without comp the request is 18 ms (which
  // setTimeout on Windows rounds up to the 2nd tick = ~31 ms). With 8 ms compensation the
  // request drops to 10 ms (< 15.625 tick), so setTimeout lands on the 1st tick (~15.625 ms),
  // saving one whole tick per cycle.
  assert.equal(
    computePollDelayMs({
      fastRawActive: true,
      pollConfig: { fastRawPollHz: 30 },
      lastFastPollStartedAt: 1000,
      nowMs: 1015,
    }),
    18
  );
  assert.equal(
    computePollDelayMs(
      {
        fastRawActive: true,
        pollConfig: { fastRawPollHz: 30 },
        lastFastPollStartedAt: 1000,
        nowMs: 1015,
      },
      { timerCompensationMs: 8 }
    ),
    10
  );
  // Compensation never drives the delay below the 1 ms floor.
  assert.equal(
    computePollDelayMs(
      {
        fastRawActive: true,
        pollConfig: { fastRawPollHz: 30 },
        lastFastPollStartedAt: 1000,
        nowMs: 1030,
      },
      { timerCompensationMs: 8 }
    ),
    1
  );
  // Also applies in the normal 2 Hz path.
  assert.equal(
    computePollDelayMs(
      { vx: 0, resolution: 'high', omegaSource: 'measured' },
      { timerCompensationMs: 8 }
    ),
    492
  );
});

test('ticksPerRev matches CA[18]', () => {
  assert.equal(ticksPerRev('high'), 262144000);
  assert.equal(ticksPerRev('low'), 6553600);
});
