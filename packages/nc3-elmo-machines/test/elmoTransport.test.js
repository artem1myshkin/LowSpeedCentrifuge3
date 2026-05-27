'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createActor } = require('xstate');

const { createElmoTransport, startElmoTransport } = require('../src/elmoTransport');
const { LEAN_POLL } = require('../src/poll');

// Harness: mock effects with call recording and an injectable clock.
// timeoutMs/connectTimeoutMs are large so the real `after` watchdogs never fire during
// synchronous tests — the timeout path is exercised via the injectable ELMO.TIMEOUT event.
function makeHarness(opts = {}) {
  const calls = { sendTcp: [], resetTcp: 0, forwardResp: [], emitEvent: [], status: [] };
  let clock = opts.startNow == null ? 1000000 : opts.startNow;
  const effects = {
    sendTcp: (cmd) => calls.sendTcp.push(cmd),
    resetTcp: () => { calls.resetTcp += 1; },
    forwardResp: (raw, topic) => calls.forwardResp.push({ raw, topic }),
    emitEvent: (evt) => calls.emitEvent.push(evt),
    setStatus: (st) => calls.status.push(st),
    now: () => clock,
    timeoutMs: 5000,
    connectTimeoutMs: 5000,
    statePeriodMs: 1000,
  };
  const actor = createActor(createElmoTransport(effects), { input: { resolution: 'high' } }).start();
  return { actor, calls, setClock: (v) => { clock = v; }, value: () => actor.getSnapshot().value, ctx: () => actor.getSnapshot().context };
}

function acked(calls) { return calls.emitEvent.filter((e) => e.type === 'CMD.ACKED'); }
function failed(calls) { return calls.emitEvent.filter((e) => e.type === 'CMD.FAILED'); }
function badPoll(calls) { return calls.emitEvent.filter((e) => e.type === 'POLL.BAD_FRAME'); }

// Drive to connected.awaiting with one command in flight.
function connectedWithCmd(opts) {
  const h = makeHarness(opts);
  h.actor.send({ type: 'UI.CMD', envelope: { id: 'cmdA', kind: 'cmd', cmd: 'JV=100;BG', meta: { topic: 'set_velocity' } } });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe-ok' });
  return h;
}

test('offline -> connecting (probe) -> connected -> sends first queued cmd', () => {
  const h = makeHarness();
  assert.equal(h.value(), 'offline');

  h.actor.send({ type: 'UI.CMD', envelope: { id: 'cmdA', kind: 'cmd', cmd: 'JV=100;BG', meta: { topic: 'set_velocity' } } });
  assert.equal(h.value(), 'connecting');
  assert.deepEqual(h.calls.sendTcp, ['TM;PX;VX;']); // probe sent on connect

  h.actor.send({ type: 'ELMO.RESP', raw: 'probe-ok' });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.id, 'cmdA');
  assert.deepEqual(h.calls.sendTcp, ['TM;PX;VX;', 'JV=100;BG']); // first in-flight dispatched
});

test('ELMO.RESP acks the in-flight cmd, forwards raw with restored topic', () => {
  const h = connectedWithCmd();
  h.calls.forwardResp.length = 0;
  h.calls.emitEvent.length = 0;

  h.actor.send({ type: 'ELMO.RESP', raw: ';' });
  assert.deepEqual(h.value(), { connected: 'idle' });
  assert.equal(h.ctx().inFlight, null);
  assert.deepEqual(h.calls.forwardResp, [{ raw: ';', topic: 'set_velocity' }]);
  assert.equal(acked(h.calls).length, 1);
  assert.equal(acked(h.calls)[0].id, 'cmdA');
});

test('single in-flight: a second cmd waits until the first is dispatched', () => {
  const h = connectedWithCmd();
  const sentBefore = h.calls.sendTcp.length;

  h.actor.send({ type: 'UI.CMD', envelope: { id: 'cmdB', kind: 'cmd', cmd: 'ST', meta: { topic: 'drive_stop' } } });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.id, 'cmdA'); // still A
  assert.equal(h.calls.sendTcp.length, sentBefore); // B not sent yet

  h.actor.send({ type: 'ELMO.RESP', raw: 'ok-A' });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.id, 'cmdB'); // now B
  assert.equal(h.calls.sendTcp[h.calls.sendTcp.length - 1], 'ST');
});

test('timeout -> fault (CMD.FAILED + reset + cleared inFlight) -> recover', () => {
  const h = connectedWithCmd();

  h.actor.send({ type: 'ELMO.TIMEOUT' });
  assert.equal(h.value(), 'fault');
  assert.equal(failed(h.calls).length, 1);
  assert.equal(failed(h.calls)[0].id, 'cmdA');
  assert.equal(h.calls.resetTcp, 1);
  assert.equal(h.ctx().inFlight, null); // stale request cleared

  h.actor.send({ type: 'CLEARED' });
  assert.deepEqual(h.value(), { connected: 'idle' });
});

test('fault auto-recovers on next good ELMO.RESP', () => {
  const h = connectedWithCmd();
  h.actor.send({ type: 'ELMO.TIMEOUT' });
  assert.equal(h.value(), 'fault');
  h.actor.send({ type: 'ELMO.RESP', raw: 'alive' });
  assert.deepEqual(h.value(), { connected: 'idle' });
});

test('POLL.TICK enqueues a lean poll (no ack on poll response)', () => {
  const h = makeHarness({ startNow: 500 }); // < statePeriodMs since lastExtendedAt=0 -> lean
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });
  assert.deepEqual(h.value(), { connected: 'idle' });

  h.actor.send({ type: 'POLL.TICK' });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.kind, 'poll');
  assert.equal(h.calls.sendTcp[h.calls.sendTcp.length - 1], LEAN_POLL);

  h.calls.forwardResp.length = 0;
  h.actor.send({ type: 'ELMO.RESP', raw: 'TM=1;PX=2;VX=0;' });
  assert.deepEqual(h.value(), { connected: 'idle' });
  assert.equal(acked(h.calls).length, 0); // polls are not acked
  assert.equal(h.calls.forwardResp[0].topic, 'poll_data'); // restored logical topic
});

test('POLL.TICK enqueues an extended poll past statePeriod and records lastExtendedAt', () => {
  const h = makeHarness({ startNow: 2000 }); // >= statePeriodMs since lastExtendedAt=0
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });

  h.actor.send({ type: 'POLL.TICK' });
  assert.equal(h.ctx().inFlight.pollRole, 'data');
  assert.equal(h.ctx().queue.length, 1);
  assert.equal(h.ctx().queue[0].pollRole, 'state');
  assert.equal(h.ctx().queue[0].cmd, 'MS;MO;SO;SR;AF;OL[1];OL[2];');
  assert.equal(h.ctx().lastExtendedAt, 2000);

  h.actor.send({ type: 'ELMO.RESP', raw: 'TM=1;PX=2;VX=0;' });
  const cmd = h.calls.sendTcp[h.calls.sendTcp.length - 1];
  for (const tok of ['SO', 'SR', 'OL[1]', 'OL[2]', 'AF', 'MS', 'MO']) {
    assert.ok(cmd.includes(tok), 'state poll missing ' + tok);
  }
  for (const tok of ['TM', 'PX', 'VX']) {
    assert.ok(!cmd.includes(tok), 'state poll should not include data field ' + tok);
  }
});

test('poll dedup: only one poll in flight/queue at a time', () => {
  const h = makeHarness({ startNow: 500 });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });

  h.actor.send({ type: 'POLL.TICK' }); // -> poll in flight (awaiting)
  assert.equal(h.ctx().inFlight.kind, 'poll');
  h.actor.send({ type: 'POLL.TICK' }); // deduped: inFlight is already a poll
  assert.equal(h.ctx().queue.length, 0);
});

test('ingests VX/OL[1] from a poll response (drives dynamic poll rate)', () => {
  const { computePollDelayMs } = require('../src/poll');
  const h = makeHarness({ startNow: 500 });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });   // connected.idle
  h.actor.send({ type: 'POLL.TICK' });                  // lean poll in flight (awaiting)
  assert.equal(h.ctx().inFlight.kind, 'poll');

  // High speed (low range, 180 deg/s) response -> context updates -> faster poll.
  h.actor.send({ type: 'ELMO.RESP', raw: 'TM=1;PX=2;VX=-3276800;OL[1]=1;MS=0;' });
  const c = h.ctx();
  assert.equal(c.vx, -3276800);
  assert.equal(c.resolution, 'low');
  assert.equal(c.omegaSource, 'measured');
  // 180 deg/s -> 15 Hz -> ~67 ms (was 1000 ms at rest), proving the rate is now dynamic.
  assert.equal(computePollDelayMs(c), Math.round(1000 / 15));
});

test('drops invalid data poll frames and emits POLL.BAD_FRAME', () => {
  const h = makeHarness({ startNow: 500 });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });
  h.actor.send({ type: 'POLL.TICK' });
  assert.equal(h.ctx().inFlight.pollRole, 'data');

  h.actor.send({ type: 'ELMO.RESP', raw: 'TM;123;\r;' });
  assert.equal(h.calls.forwardResp.length, 0);
  assert.equal(badPoll(h.calls).length, 1);
  assert.deepEqual(badPoll(h.calls)[0].missing, ['px', 'vx']);
  assert.equal(h.ctx().tm, undefined);
});

test('forwards valid state poll frames on poll_state topic', () => {
  const h = makeHarness({ startNow: 2000 });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });
  h.actor.send({ type: 'POLL.TICK' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'TM;1;PX;2;VX;0;' });
  assert.equal(h.ctx().inFlight.pollRole, 'state');

  h.calls.forwardResp.length = 0;
  h.actor.send({ type: 'ELMO.RESP', raw: 'MS;3;MO;0;SO;0;SR;100663616;AF;0;OL[1];1;OL[2];1;\r;' });
  assert.equal(h.calls.forwardResp.length, 1);
  assert.equal(h.calls.forwardResp[0].topic, 'poll_state');
  assert.equal(badPoll(h.calls).length, 0);
  assert.equal(h.ctx().resolution, 'low');
});

test('ingests observed ELMO CR-separated scalar response and returns to measured speed', () => {
  const h = makeHarness({ startNow: 500 });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });
  h.actor.send({ type: 'UI.CMD', envelope: { id: 'jv', kind: 'cmd', cmd: 'JV=1;BG', meta: { setpointDegS: 360 } } });
  assert.equal(h.ctx().omegaSource, 'setpoint');

  h.actor.send({ type: 'ELMO.RESP', raw: 'ok' }); // command ack -> dispatch -> poll can run
  h.actor.send({ type: 'POLL.TICK' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'TM;1;PX;2;VX\r0.000000e+00;OL[1]\r1;MS\r0;SO\r1;SR\r105120016;' });

  const c = h.ctx();
  assert.equal(c.vx, 0);
  assert.equal(c.resolution, 'low');
  assert.equal(c.ms, 0);
  assert.equal(c.so, 1);
  assert.equal(c.sr, 105120016);
  assert.equal(c.omegaSource, 'measured');
});

test('setpoint hint sets omegaSource before first VX poll', () => {
  const h = connectedWithCmd();
  h.actor.send({ type: 'UI.CMD', envelope: { id: 'jv', kind: 'cmd', cmd: 'JV=1;BG', meta: { topic: 'set_velocity', setpointDegS: 360 } } });
  const c = h.ctx();
  assert.equal(c.omegaSource, 'setpoint');
  assert.equal(c.setpointDegS, 360);
});

test('startElmoTransport returns a started actor in offline with given resolution', () => {
  const actor = startElmoTransport({ sendTcp: () => {} }, { resolution: 'low' });
  assert.equal(actor.getSnapshot().value, 'offline');
  assert.equal(actor.getSnapshot().context.resolution, 'low');
  actor.stop();
});

test('a cmd preempts a queued poll (priority)', () => {
  const h = makeHarness({ startNow: 500 });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' }); // connected.idle

  // First poll goes in flight; queue a poll-then-cmd while awaiting.
  h.actor.send({ type: 'POLL.TICK' }); // poll in flight
  h.actor.send({ type: 'UI.CMD', envelope: { id: 'cmdX', kind: 'cmd', cmd: 'ST', meta: { topic: 'drive_stop' } } });
  // queue currently: [cmdX] (poll is in flight, deduped)
  assert.equal(h.ctx().queue[0].id, 'cmdX');

  h.actor.send({ type: 'ELMO.RESP', raw: 'poll-data' }); // dispatch poll -> idle -> send cmdX
  assert.equal(h.ctx().inFlight.id, 'cmdX');
});
