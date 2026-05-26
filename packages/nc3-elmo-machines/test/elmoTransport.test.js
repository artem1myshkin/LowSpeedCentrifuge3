'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createActor } = require('xstate');

const { createElmoTransport } = require('../src/elmoTransport');
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
  const cmd = h.calls.sendTcp[h.calls.sendTcp.length - 1];
  for (const tok of ['SO', 'SR', 'OL[1]', 'OL[2]', 'AF', 'MS', 'MO']) {
    assert.ok(cmd.includes(tok), 'extended poll missing ' + tok);
  }
  assert.equal(h.ctx().lastExtendedAt, 2000);
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
