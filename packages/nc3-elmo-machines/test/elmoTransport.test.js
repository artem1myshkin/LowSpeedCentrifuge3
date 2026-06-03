'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createActor } = require('xstate');

const { createElmoTransport, startElmoTransport } = require('../src/elmoTransport');
const { LEAN_POLL } = require('../src/poll');

// All actors created by the harness are stopped after the suite. The UDP machine recovers
// from a timeout back to connected.idle (not a terminal fault), so an un-stopped actor would
// loop on real `after` timers forever and keep the test process alive. Watchdog delays are
// set far beyond the suite runtime so no real timer fires mid-run; the timeout path is
// exercised via the injectable ELMO.TIMEOUT event instead.
const createdActors = [];
after(() => {
  for (const a of createdActors) {
    try { a.stop(); } catch (_) { /* already stopped */ }
  }
});

function makeHarness(opts = {}) {
  const calls = { sendCmd: [], forwardResp: [], emitEvent: [], status: [] };
  let clock = opts.startNow == null ? 1000000 : opts.startNow;
  const effects = {
    sendCmd: (cmd) => calls.sendCmd.push(cmd),
    forwardResp: (raw, topic) => calls.forwardResp.push({ raw, topic }),
    emitEvent: (evt) => calls.emitEvent.push(evt),
    setStatus: (st) => calls.status.push(st),
    now: () => clock,
    timeoutMs: 600000,
    connectTimeoutMs: 600000,
    reconnectMs: 600000,
    statePeriodMs: 1000,
    initialFullState: opts.initialFullState === true,
  };
  if (opts.maxMisses != null) effects.maxMisses = opts.maxMisses;
  if (opts.soReadyTimeoutMs != null) effects.soReadyTimeoutMs = opts.soReadyTimeoutMs;
  if (opts.motionPollDelayMs != null) effects.motionPollDelayMs = opts.motionPollDelayMs;
  if (opts.motionDoneTimeoutMs != null) effects.motionDoneTimeoutMs = opts.motionDoneTimeoutMs;
  const input = { resolution: opts.resolution || 'high' };
  if (opts.pollConfig) input.pollConfig = opts.pollConfig;
  const actor = createActor(createElmoTransport(effects), { input }).start();
  createdActors.push(actor);
  return { actor, calls, setClock: (v) => { clock = v; }, value: () => actor.getSnapshot().value, ctx: () => actor.getSnapshot().context };
}

function acked(calls) { return calls.emitEvent.filter((e) => e.type === 'CMD.ACKED'); }
function completed(calls) { return calls.emitEvent.filter((e) => e.type === 'CMD.COMPLETED'); }
function failed(calls) { return calls.emitEvent.filter((e) => e.type === 'CMD.FAILED'); }
function badPoll(calls) { return calls.emitEvent.filter((e) => e.type === 'POLL.BAD_FRAME'); }

// ELMO answers one datagram per parameter, so each logical poll feeds N atomic ELMO.RESP
// events (one per requested field). The transport reassembles the parts into a single raw
// frame for downstream.
function feedDataPoll(h, opts = {}) {
  h.actor.send({ type: 'ELMO.RESP', raw: opts.tm || 'TM;1;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.px || 'PX;2;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.vx || 'VX;0;' });
}

function feedFastSeekPoll(h, opts = {}) {
  h.actor.send({ type: 'ELMO.RESP', raw: opts.vx || 'VX;0;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.px || 'PX;2;' });
}

function feedFastDataPoll(h, opts = {}) {
  h.actor.send({ type: 'ELMO.RESP', raw: opts.tm || 'TM;1;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.px || 'PX;2;' });
}

function feedStatePoll(h, opts = {}) {
  h.actor.send({ type: 'ELMO.RESP', raw: opts.mo || 'MO;0;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.so || 'SO;0;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.sr || 'SR;100663616;' });
}

function feedFullStatePoll(h, opts = {}) {
  h.actor.send({ type: 'ELMO.RESP', raw: opts.ms || 'MS;3;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.mo || 'MO;0;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.so || 'SO;0;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.sr || 'SR;100663616;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.af || 'AF;0;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.ol1 || 'OL[1];1;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.ol2 || 'OL[2];1;' });
}

function feedMotionStatusPoll(h, opts = {}) {
  h.actor.send({ type: 'ELMO.RESP', raw: opts.ms || 'MS;2;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.tm || 'TM;100;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.px || 'PX;10;' });
  h.actor.send({ type: 'ELMO.RESP', raw: opts.vx || 'VX;1;' });
}

// Drive to connected.awaiting with one command in flight.
function connectedWithCmd(opts) {
  const h = makeHarness(opts);
  h.actor.send({ type: 'UI.CMD', envelope: { id: 'cmdA', kind: 'cmd', cmd: 'JV=100', meta: { topic: 'set_velocity' } } });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe-ok' });
  return h;
}

test('offline -> connecting (probe) -> connected -> sends first queued cmd', () => {
  const h = makeHarness();
  assert.equal(h.value(), 'offline');

  h.actor.send({ type: 'UI.CMD', envelope: { id: 'cmdA', kind: 'cmd', cmd: 'JV=100;BG', meta: { topic: 'set_velocity' } } });
  assert.equal(h.value(), 'connecting');
  assert.deepEqual(h.calls.sendCmd, ['TM']); // single-register probe datagram sent on connect

  h.actor.send({ type: 'ELMO.RESP', raw: 'probe-ok' });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.id, 'cmdA');
  assert.deepEqual(h.calls.sendCmd, ['TM', 'JV=100']); // first atomic command dispatched
  assert.deepEqual(h.ctx().inFlight.cmds, ['JV=100', 'BG']);
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

test('command batches are sent atomically and reassembled before forwarding', () => {
  const h = makeHarness();
  h.actor.send({
    type: 'UI.CMD',
    envelope: { id: 'cmdBatch', kind: 'cmd', cmd: 'AC=1;DC=2;JV=3;BG', meta: { topic: 'set_velocity' } },
  });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe-ok' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'AC=1');

  h.actor.send({ type: 'ELMO.RESP', raw: 'AC;1;' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'DC=2');
  h.actor.send({ type: 'ELMO.RESP', raw: 'DC;2;' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'JV=3');
  h.actor.send({ type: 'ELMO.RESP', raw: 'JV;3;' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'BG');

  h.calls.forwardResp.length = 0;
  h.calls.emitEvent.length = 0;
  h.actor.send({ type: 'ELMO.RESP', raw: ';' });

  assert.deepEqual(h.value(), { connected: 'idle' });
  assert.equal(h.calls.forwardResp.length, 1);
  assert.equal(h.calls.forwardResp[0].topic, 'set_velocity');
  assert.equal(h.calls.forwardResp[0].raw, 'AC;1;DC;2;JV;3;;');
  assert.equal(acked(h.calls).length, 1);
  assert.equal(acked(h.calls)[0].id, 'cmdBatch');
  assert.equal(acked(h.calls)[0].raw, 'AC;1;DC;2;JV;3;;');
});

test('command batch waits for SO=1 after MO=1 before continuing', () => {
  const h = makeHarness();
  h.actor.send({
    type: 'UI.CMD',
    envelope: { id: 'init', kind: 'cmd', cmd: 'MO=1;PR=1;BG', meta: { topic: 'driveInit' } },
  });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe-ok' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'MO=1');

  h.actor.send({ type: 'ELMO.RESP', raw: 'MO;1;' });
  assert.deepEqual(h.value(), { connected: 'waitingForSoReady' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'SO');

  h.actor.send({ type: 'ELMO.RESP', raw: 'SO;0;' });
  assert.deepEqual(h.value(), { connected: 'waitingForSoReady' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'SO');

  h.actor.send({ type: 'ELMO.RESP', raw: 'SO;1;' });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'PR=1');

  h.actor.send({ type: 'ELMO.RESP', raw: 'PR;1;' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'BG');
  h.actor.send({ type: 'ELMO.RESP', raw: ';' });

  assert.equal(acked(h.calls).at(-1).id, 'init');
  assert.equal(acked(h.calls).at(-1).raw, 'MO;1;SO;1;PR;1;;');
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.pollRole, 'state');
});

test('waitForMotionDone command completes only after MS reports motion done', async () => {
  const h = makeHarness({ motionPollDelayMs: 5, motionDoneTimeoutMs: 1000 });
  h.actor.send({
    type: 'UI.CMD',
    envelope: {
      id: 'init',
      kind: 'cmd',
      cmd: 'MO=1;PR=1;BG',
      meta: { topic: 'driveInit', waitForMotionDone: true },
    },
  });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe-ok' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'MO;1;' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'SO;1;' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'PR;1;' });
  h.actor.send({ type: 'ELMO.RESP', raw: ';' });

  assert.deepEqual(h.value(), { connected: 'waitingForMotionDone' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'MS');
  assert.equal(acked(h.calls).filter((e) => e.id === 'init').length, 0);
  assert.equal(completed(h.calls).length, 0);

  feedMotionStatusPoll(h, { ms: 'MS;2;', tm: 'TM;100;', px: 'PX;10;', vx: 'VX;5;' });
  assert.deepEqual(h.value(), { connected: 'motionPollPause' });
  assert.equal(h.calls.forwardResp.at(-1).topic, 'poll_data');
  assert.equal(h.calls.forwardResp.at(-1).raw, 'MS;2;TM;100;PX;10;VX;5;');
  assert.equal(h.ctx().ms, 2);
  assert.equal(h.ctx().tm, 100);
  assert.equal(h.ctx().px, 10);
  assert.equal(h.ctx().vx, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(h.value(), { connected: 'waitingForMotionDone' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'MS');

  h.calls.forwardResp.length = 0;
  feedMotionStatusPoll(h, { ms: 'MS;0;', tm: 'TM;200;', px: 'PX;20;', vx: 'VX;0;' });

  assert.equal(completed(h.calls).at(-1).id, 'init');
  assert.equal(completed(h.calls).at(-1).topic, 'driveInit');
  assert.equal(completed(h.calls).at(-1).raw, 'MS;0;TM;200;PX;20;VX;0;');
  assert.equal(h.calls.forwardResp[0].topic, 'poll_data');
  assert.equal(h.calls.forwardResp[0].raw, 'MS;0;TM;200;PX;20;VX;0;');
  assert.equal(h.ctx().inFlight.pollRole, 'state');
});

test('operator stop aborts waitForMotionDone command and preempts the queue', () => {
  const h = makeHarness({ motionPollDelayMs: 5, motionDoneTimeoutMs: 1000 });
  h.actor.send({
    type: 'UI.CMD',
    envelope: {
      id: 'init',
      kind: 'cmd',
      cmd: 'MO=1;PR=1;BG',
      meta: { topic: 'driveInit', waitForMotionDone: true },
    },
  });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe-ok' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'MO;1;' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'SO;1;' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'PR;1;' });
  h.actor.send({ type: 'ELMO.RESP', raw: ';' });
  assert.deepEqual(h.value(), { connected: 'waitingForMotionDone' });

  h.actor.send({
    type: 'UI.CMD',
    envelope: { id: 'stop', kind: 'cmd', cmd: 'ST', meta: { topic: 'drive_stop' } },
  });

  assert.equal(failed(h.calls).at(-1).id, 'init');
  assert.equal(failed(h.calls).at(-1).reason, 'operator_aborted');
  assert.equal(h.ctx().inFlight.id, 'stop');
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'ST');
});

test('single MO=1 command waits for SO=1 before ack', () => {
  const h = makeHarness();
  h.actor.send({
    type: 'UI.CMD',
    envelope: { id: 'motor-on', kind: 'cmd', cmd: 'MO=1', meta: { topic: 'motor_on' } },
  });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe-ok' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'MO;1;' });
  assert.deepEqual(h.value(), { connected: 'waitingForSoReady' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'SO');

  h.actor.send({ type: 'ELMO.RESP', raw: 'SO;1;' });

  assert.equal(acked(h.calls).at(-1).id, 'motor-on');
  assert.equal(acked(h.calls).at(-1).raw, 'MO;1;SO;1;');
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.pollRole, 'state');
});

test('SO wait timeout fails command and sends emergency stop', async () => {
  const h = makeHarness({ soReadyTimeoutMs: 5 });
  h.actor.send({
    type: 'UI.CMD',
    envelope: { id: 'init-timeout', kind: 'cmd', cmd: 'MO=1;PR=1', meta: { topic: 'driveInit' } },
  });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe-ok' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'MO;1;' });
  assert.deepEqual(h.value(), { connected: 'waitingForSoReady' });

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(h.value(), { connected: 'idle' });
  assert.equal(h.ctx().inFlight, null);
  assert.equal(failed(h.calls).at(-1).id, 'init-timeout');
  assert.equal(failed(h.calls).at(-1).reason, 'so_timeout');
  assert.match(failed(h.calls).at(-1).message, /SO did not become 1/);
  assert.deepEqual(h.calls.sendCmd.slice(-2), ['ST', 'MO=0']);
});

test('single in-flight: a second cmd waits until the first is dispatched', () => {
  const h = connectedWithCmd();
  const sentBefore = h.calls.sendCmd.length;

  h.actor.send({ type: 'UI.CMD', envelope: { id: 'cmdB', kind: 'cmd', cmd: 'JV=200', meta: { topic: 'set_velocity' } } });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.id, 'cmdA'); // still A
  assert.equal(h.calls.sendCmd.length, sentBefore); // B not sent yet

  h.actor.send({ type: 'ELMO.RESP', raw: 'ok-A' });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.id, 'cmdB'); // now B
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'JV=200');
});

test('operator stop aborts a regular in-flight command and preempts queued work', () => {
  const h = connectedWithCmd();

  h.actor.send({ type: 'UI.CMD', envelope: { id: 'cmdB', kind: 'cmd', cmd: 'JV=200', meta: { topic: 'set_velocity' } } });
  h.actor.send({ type: 'UI.CMD', envelope: { id: 'stop', kind: 'cmd', cmd: 'ST', meta: { topic: 'drive_stop' } } });

  assert.equal(failed(h.calls).at(-1).id, 'cmdA');
  assert.equal(failed(h.calls).at(-1).reason, 'operator_aborted');
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.id, 'stop');
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'ST');
  assert.equal(h.ctx().queue[0].id, 'cmdB');
});

test('request timeout fails the in-flight cmd and keeps the link up (no socket reset)', () => {
  const h = connectedWithCmd();

  h.actor.send({ type: 'ELMO.TIMEOUT' });
  // UDP: a single miss is not fatal — back to idle, ready to poll/command again.
  assert.deepEqual(h.value(), { connected: 'idle' });
  assert.equal(failed(h.calls).length, 1);
  assert.equal(failed(h.calls)[0].id, 'cmdA');
  assert.equal(h.ctx().inFlight, null); // stale request cleared
  assert.equal(h.ctx().missCount, 1);
});

test('declares link offline after maxMisses consecutive reply timeouts', () => {
  const h = makeHarness({ maxMisses: 2, startNow: 500 }); // lean poll only (one in-flight chain)
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' }); // connected.idle

  h.actor.send({ type: 'POLL.TICK' });               // poll in flight
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  h.actor.send({ type: 'ELMO.TIMEOUT' });            // miss 1 -> back to idle
  assert.deepEqual(h.value(), { connected: 'idle' });
  assert.equal(h.ctx().missCount, 1);

  h.actor.send({ type: 'POLL.TICK' });               // poll in flight again
  h.actor.send({ type: 'ELMO.TIMEOUT' });            // miss 2 -> offline
  assert.equal(h.value(), 'offline');
});

test('offline recovers and resets miss count on CONNECT + probe reply', () => {
  const h = makeHarness({ maxMisses: 1, startNow: 500 });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });
  h.actor.send({ type: 'POLL.TICK' });
  h.actor.send({ type: 'ELMO.TIMEOUT' }); // maxMisses=1 -> offline immediately
  assert.equal(h.value(), 'offline');

  h.actor.send({ type: 'CONNECT' });
  assert.equal(h.value(), 'connecting');
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe2' });
  assert.deepEqual(h.value(), { connected: 'idle' });
  assert.equal(h.ctx().missCount, 0);
});

test('connect enqueues one full-state initialization poll when enabled', () => {
  const h = makeHarness({ initialFullState: true });
  h.actor.send({ type: 'CONNECT' });
  assert.deepEqual(h.calls.sendCmd, ['TM']);

  h.actor.send({ type: 'ELMO.RESP', raw: 'TM;1;' });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.pollRole, 'full_state');
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'MS');

  h.calls.forwardResp.length = 0;
  feedFullStatePoll(h);
  assert.equal(h.calls.forwardResp.length, 1);
  assert.equal(h.calls.forwardResp[0].topic, 'poll_state');
  assert.equal(h.ctx().resolution, 'low');
});

test('POLL.TICK enqueues a lean poll (no ack on poll response)', () => {
  const h = makeHarness({ startNow: 500 }); // < statePeriodMs since lastExtendedAt=0 -> lean
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });
  assert.deepEqual(h.value(), { connected: 'idle' });

  h.actor.send({ type: 'POLL.TICK' });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.kind, 'poll');
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'TM'); // first atomic command

  h.calls.forwardResp.length = 0;
  feedDataPoll(h);
  assert.deepEqual(h.value(), { connected: 'idle' });
  assert.equal(acked(h.calls).length, 0); // polls are not acked
  assert.equal(h.calls.forwardResp[0].topic, 'poll_data'); // restored logical topic
  assert.equal(h.calls.forwardResp[0].raw, 'TM;1;PX;2;VX;0;'); // reassembled from atomic parts
});

test('POLL.TICK enqueues an extended poll past statePeriod and records lastExtendedAt', () => {
  const h = makeHarness({ startNow: 2000 }); // >= statePeriodMs since lastExtendedAt=0
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });

  h.actor.send({ type: 'POLL.TICK' });
  assert.equal(h.ctx().inFlight.pollRole, 'data');
  assert.equal(h.ctx().queue.length, 1);
  assert.equal(h.ctx().queue[0].pollRole, 'state');
  assert.deepEqual(h.ctx().queue[0].cmds, ['MO', 'SO', 'SR']);
  assert.equal(h.ctx().lastExtendedAt, 2000);

  feedDataPoll(h);
  // After data poll completes, the state poll's first atomic command is sent.
  const cmd = h.calls.sendCmd[h.calls.sendCmd.length - 1];
  assert.equal(cmd, 'MO');
});

test('fast raw polling uses TM/PX data poll and suppresses periodic state poll', () => {
  const h = makeHarness({
    startNow: 2000,
    pollConfig: {
      isRecording: true,
      isRecordingRaw: true,
      rawDataEnabled: true,
      fastRawPollHz: 30,
    },
  });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });

  h.actor.send({ type: 'POLL.TICK' });
  assert.equal(h.ctx().inFlight.pollRole, 'fast_data');
  assert.deepEqual(h.ctx().inFlight.cmds, ['TM', 'PX']);
  assert.equal(h.ctx().inFlight.priority, 2.5);
  assert.equal(h.ctx().lastFastPollStartedAt, 2000);
  assert.equal(h.ctx().queue.length, 0); // no MO/SO/SR while fast raw poll is healthy
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'TM');

  h.calls.forwardResp.length = 0;
  feedFastDataPoll(h, { tm: 'TM;100;', px: 'PX;-10;' });
  assert.equal(h.calls.forwardResp.length, 1);
  assert.equal(h.calls.forwardResp[0].topic, 'poll_data');
  assert.equal(h.calls.forwardResp[0].raw, 'TM;100;PX;-10;');
});

test('low resolution uses 10 Hz TM/PX poll for derived velocity without raw recording', () => {
  const h = makeHarness({
    startNow: 2000,
    resolution: 'low',
    pollConfig: {
      isRecording: false,
      isRecordingRaw: false,
      rawDataEnabled: false,
      lowVelocityPollHz: 10,
    },
  });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });

  h.actor.send({ type: 'POLL.TICK' });
  assert.equal(h.ctx().fastRawActive, false);
  assert.equal(h.ctx().lowVelocityPollActive, true);
  assert.equal(h.ctx().inFlight.pollRole, 'fast_data');
  assert.deepEqual(h.ctx().inFlight.cmds, ['TM', 'PX']);
  assert.equal(h.ctx().queue.length, 1);
  assert.equal(h.ctx().queue[0].pollRole, 'state');
});

test('full-state low range response activates low velocity poll path', () => {
  const h = makeHarness({ startNow: 2000, initialFullState: true });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'TM;1;' });
  feedFullStatePoll(h, { ol1: 'OL[1];1;' });

  assert.equal(h.ctx().resolution, 'low');
  assert.equal(h.ctx().lowVelocityPollActive, true);

  h.actor.send({ type: 'POLL.TICK' });
  assert.equal(h.ctx().inFlight.pollRole, 'fast_data');
  assert.deepEqual(h.ctx().inFlight.cmds, ['TM', 'PX']);
});

test('fast raw polling stays on TM/PX at 30 Hz', () => {
  const h = makeHarness({
    startNow: 2000,
    pollConfig: {
      isRecording: true,
      isRecordingRaw: true,
      rawDataEnabled: true,
      fastRawPollHz: 30,
      fastStableSamples: 2,
      fastStableToleranceTicks: 0,
    },
  });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });

  h.actor.send({ type: 'POLL.TICK' });
  assert.equal(h.ctx().inFlight.pollRole, 'fast_data');
  assert.deepEqual(h.ctx().inFlight.cmds, ['TM', 'PX']);
  feedFastDataPoll(h, { tm: 'TM;100;', px: 'PX;3;' });
  assert.equal(h.calls.forwardResp.length, 1);
  assert.equal(h.calls.forwardResp[0].topic, 'poll_data');
  assert.equal(h.calls.forwardResp[0].raw, 'TM;100;PX;3;');
});

test('invalid fast poll part emits bad frame and schedules full-state diagnostics', () => {
  const h = makeHarness({
    startNow: 2000,
    pollConfig: {
      isRecording: true,
      isRecordingRaw: true,
      rawDataEnabled: true,
      fastRawPollHz: 30,
    },
  });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });
  h.actor.send({ type: 'POLL.TICK' });
  assert.equal(h.ctx().inFlight.pollRole, 'fast_data');

  // We asked for TM (part 0), got a stale/cross-attributed PX datagram instead.
  h.actor.send({ type: 'ELMO.RESP', raw: 'PX;2;' });
  assert.equal(badPoll(h.calls).length, 1);
  assert.equal(badPoll(h.calls)[0].role, 'fast_data');
  assert.deepEqual(badPoll(h.calls)[0].missing, ['tm']);
  assert.equal(badPoll(h.calls)[0].cmd, 'TM');
  assert.equal(h.ctx().inFlight.pollRole, 'full_state');
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'MS');
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

test('ingests VX/OL[1] from a poll response and enables low-range 10 Hz cadence', () => {
  const { computePollDelayMs } = require('../src/poll');
  const h = makeHarness({ startNow: 500 });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });   // connected.idle
  h.actor.send({ type: 'POLL.TICK' });                  // lean poll in flight (awaiting)
  assert.equal(h.ctx().inFlight.kind, 'poll');

  // High speed (low range, 180 deg/s) — the VX part also carries OL[1] and MS scalars; the
  // reassembled raw includes everything and ingestResp picks it up.
  feedDataPoll(h, { vx: 'VX;-3276800;OL[1]=1;MS=0;' });
  const c = h.ctx();
  assert.equal(c.vx, -3276800);
  assert.equal(c.resolution, 'low');
  assert.equal(c.omegaSource, 'measured');
  assert.equal(computePollDelayMs(c), 100);
});

test('drops invalid data poll frames and emits POLL.BAD_FRAME', () => {
  const h = makeHarness({ startNow: 500 });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });
  h.actor.send({ type: 'POLL.TICK' });
  assert.equal(h.ctx().inFlight.pollRole, 'data');

  // First atomic part is 'TM'; reply with a stale fragment missing TM.
  h.actor.send({ type: 'ELMO.RESP', raw: 'VX;9.000000e+00;\r;' });
  assert.equal(h.calls.forwardResp.length, 0);
  assert.equal(badPoll(h.calls).length, 1);
  assert.deepEqual(badPoll(h.calls)[0].missing, ['tm']);
  assert.equal(badPoll(h.calls)[0].cmd, 'TM');
  assert.equal(h.ctx().tm, undefined);
});

test('forwards valid state poll frames on poll_state topic', () => {
  const h = makeHarness({ startNow: 2000 });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });
  h.actor.send({ type: 'POLL.TICK' });
  feedDataPoll(h);
  assert.equal(h.ctx().inFlight.pollRole, 'state');

  h.calls.forwardResp.length = 0;
  feedStatePoll(h);
  assert.equal(h.calls.forwardResp.length, 1);
  assert.equal(h.calls.forwardResp[0].topic, 'poll_state');
  assert.equal(h.calls.forwardResp[0].raw, 'MO;0;SO;0;SR;100663616;');
  assert.equal(badPoll(h.calls).length, 0);
  assert.equal(h.ctx().mo, 0);
  assert.equal(h.ctx().so, 0);
  assert.equal(h.ctx().sr, 100663616);
});

test('ingests observed ELMO CR-separated scalar response and returns to measured speed', () => {
  const h = makeHarness({ startNow: 500 });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });
  h.actor.send({ type: 'UI.CMD', envelope: { id: 'jv', kind: 'cmd', cmd: 'JV=1', meta: { setpointDegS: 360 } } });
  assert.equal(h.ctx().omegaSource, 'setpoint');

  h.actor.send({ type: 'ELMO.RESP', raw: 'ok' }); // command ack -> dispatch -> poll can run
  h.actor.send({ type: 'POLL.TICK' });
  feedDataPoll(h, { vx: 'VX\r0.000000e+00;OL[1]\r1;MS\r0;SO\r1;SR\r105120016;' });

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

test('MO command ack enqueues a minimal MO/SO/SR confirmation poll', () => {
  const h = connectedWithCmd();
  h.calls.forwardResp.length = 0;

  h.actor.send({ type: 'ELMO.RESP', raw: ';' });
  h.actor.send({ type: 'UI.CMD', envelope: { id: 'mo', kind: 'cmd', cmd: 'MO=1', meta: { topic: 'motor_on' } } });
  h.actor.send({ type: 'ELMO.RESP', raw: 'MO;1;' });
  assert.deepEqual(h.value(), { connected: 'waitingForSoReady' });
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'SO');

  h.actor.send({ type: 'ELMO.RESP', raw: 'SO;1;' });

  assert.equal(h.ctx().inFlight.pollRole, 'state');
  assert.deepEqual(h.ctx().inFlight.cmds, ['MO', 'SO', 'SR']);
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'MO');

  h.calls.forwardResp.length = 0;
  feedStatePoll(h, { mo: 'MO;1;', so: 'SO;1;' });
  assert.equal(h.calls.forwardResp[0].topic, 'poll_state');
  assert.equal(h.calls.forwardResp[0].raw, 'MO;1;SO;1;SR;100663616;');
});

test('OL command ack enqueues full-state confirmation poll', () => {
  const h = connectedWithCmd();
  h.actor.send({ type: 'ELMO.RESP', raw: ';' });
  h.actor.send({ type: 'UI.CMD', envelope: { id: 'brake', kind: 'cmd', cmd: 'OL[2]=0', meta: { topic: 'bun_brake' } } });
  h.actor.send({ type: 'ELMO.RESP', raw: 'OL[2];0;' });

  assert.equal(h.ctx().inFlight.pollRole, 'full_state');
  assert.deepEqual(h.ctx().inFlight.cmds, ['MS', 'MO', 'SO', 'SR', 'AF', 'OL[1]', 'OL[2]']);
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'MS');
});

test('OL command with prior MO=0 still enqueues full-state confirmation poll', () => {
  const h = connectedWithCmd();
  h.actor.send({ type: 'ELMO.RESP', raw: ';' });
  h.actor.send({
    type: 'UI.CMD',
    envelope: { id: 'range', kind: 'cmd', cmd: 'MO=0;OL[1]=1;CA[18]=6553600', meta: { topic: 'set_resolution' } },
  });
  h.actor.send({ type: 'ELMO.RESP', raw: 'MO;0;' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'OL[1];1;' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'CA[18];6553600;' });

  assert.equal(h.ctx().inFlight.pollRole, 'full_state');
  assert.deepEqual(h.ctx().inFlight.cmds, ['MS', 'MO', 'SO', 'SR', 'AF', 'OL[1]', 'OL[2]']);
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'MS');
});

test('startElmoTransport returns a started actor in offline with given resolution', () => {
  const actor = startElmoTransport({ sendCmd: () => {} }, { resolution: 'low' });
  assert.equal(actor.getSnapshot().value, 'offline');
  assert.equal(actor.getSnapshot().context.resolution, 'low');
  actor.stop();
});

test('operator stop aborts an in-flight poll immediately', () => {
  const h = makeHarness({ startNow: 500 });
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' }); // connected.idle

  h.actor.send({ type: 'POLL.TICK' }); // poll in flight (awaiting TM part)
  h.actor.send({ type: 'UI.CMD', envelope: { id: 'cmdX', kind: 'cmd', cmd: 'ST', meta: { topic: 'drive_stop' } } });
  assert.equal(h.ctx().inFlight.id, 'cmdX');
  assert.equal(h.ctx().queue.length, 0);
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'ST');
  assert.equal(failed(h.calls).length, 0);
});

test('LEAN_POLL constant lists the data fields', () => {
  // Vestigial display constant; the transport sends data poll as atomic TM, PX, VX commands.
  assert.equal(LEAN_POLL, 'TM;PX;VX;');
});
