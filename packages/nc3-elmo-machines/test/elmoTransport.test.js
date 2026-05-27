'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createActor } = require('xstate');

const { createElmoTransport, startElmoTransport } = require('../src/elmoTransport');
const { LEAN_POLL } = require('../src/poll');

// All actors created by the harness are stopped after the suite. The UDP machine recovers
// from a timeout back to connected.idle (not a terminal fault), so an un-stopped actor would
// loop on real `after` timers forever and keep the test process alive. The watchdog delays are
// also set far beyond the suite runtime so no timer fires mid-run; the timeout path is exercised
// via the injectable ELMO.TIMEOUT event instead.
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
  const input = { resolution: 'high' };
  if (opts.pollConfig) input.pollConfig = opts.pollConfig;
  const actor = createActor(createElmoTransport(effects), { input }).start();
  createdActors.push(actor);
  return { actor, calls, setClock: (v) => { clock = v; }, value: () => actor.getSnapshot().value, ctx: () => actor.getSnapshot().context };
}

function acked(calls) { return calls.emitEvent.filter((e) => e.type === 'CMD.ACKED'); }
function failed(calls) { return calls.emitEvent.filter((e) => e.type === 'CMD.FAILED'); }
function badPoll(calls) { return calls.emitEvent.filter((e) => e.type === 'POLL.BAD_FRAME'); }

// UDP: one logical poll = one datagram = one reply. Each feed sends a SINGLE ELMO.RESP
// whose raw payload carries the whole batched response (opts.raw overrides the default).
function feedDataPoll(h, opts = {}) {
  const raw = opts.raw != null ? opts.raw : (opts.tm || 'TM;1;') + (opts.px || 'PX;2;') + (opts.vx || 'VX;0;');
  h.actor.send({ type: 'ELMO.RESP', raw });
}

function feedFastSeekPoll(h, opts = {}) {
  const raw = opts.raw != null ? opts.raw : (opts.vx || 'VX;0;') + (opts.px || 'PX;2;');
  h.actor.send({ type: 'ELMO.RESP', raw });
}

function feedFastDataPoll(h, opts = {}) {
  const raw = opts.raw != null ? opts.raw : (opts.vx || 'VX;0;') + (opts.px || 'PX;2;') + (opts.tm || 'TM;1;');
  h.actor.send({ type: 'ELMO.RESP', raw });
}

function feedStatePoll(h, opts = {}) {
  const raw = opts.raw != null ? opts.raw : (opts.mo || 'MO;0;') + (opts.so || 'SO;0;') + (opts.sr || 'SR;100663616;');
  h.actor.send({ type: 'ELMO.RESP', raw });
}

function feedFullStatePoll(h, opts = {}) {
  const raw = opts.raw != null ? opts.raw
    : (opts.ms || 'MS;3;') + (opts.mo || 'MO;0;') + (opts.so || 'SO;0;') + (opts.sr || 'SR;100663616;')
      + (opts.af || 'AF;0;') + (opts.ol1 || 'OL[1];1;') + (opts.ol2 || 'OL[2];1;');
  h.actor.send({ type: 'ELMO.RESP', raw });
}

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
  assert.deepEqual(h.calls.sendCmd, ['TM']); // single-register probe datagram sent on connect

  h.actor.send({ type: 'ELMO.RESP', raw: 'probe-ok' });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.id, 'cmdA');
  assert.deepEqual(h.calls.sendCmd, ['TM', 'JV=100;BG']); // first in-flight dispatched
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
  const sentBefore = h.calls.sendCmd.length;

  h.actor.send({ type: 'UI.CMD', envelope: { id: 'cmdB', kind: 'cmd', cmd: 'ST', meta: { topic: 'drive_stop' } } });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.id, 'cmdA'); // still A
  assert.equal(h.calls.sendCmd.length, sentBefore); // B not sent yet

  h.actor.send({ type: 'ELMO.RESP', raw: 'ok-A' });
  assert.deepEqual(h.value(), { connected: 'awaiting' });
  assert.equal(h.ctx().inFlight.id, 'cmdB'); // now B
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'ST');
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
  const h = makeHarness({ maxMisses: 2, startNow: 500 }); // lean poll only (no trailing state poll)
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
  const h = makeHarness({ maxMisses: 1, startNow: 500 }); // lean poll only
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
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'MS;MO;SO;SR;AF;OL[1];OL[2];');

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
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'TM;PX;VX;'); // one batched datagram

  h.calls.forwardResp.length = 0;
  feedDataPoll(h);
  assert.deepEqual(h.value(), { connected: 'idle' });
  assert.equal(acked(h.calls).length, 0); // polls are not acked
  assert.equal(h.calls.forwardResp[0].topic, 'poll_data'); // restored logical topic
  assert.equal(h.calls.forwardResp[0].raw, 'TM;1;PX;2;VX;0;');
});

test('POLL.TICK enqueues an extended poll past statePeriod and records lastExtendedAt', () => {
  const h = makeHarness({ startNow: 2000 }); // >= statePeriodMs since lastExtendedAt=0
  h.actor.send({ type: 'CONNECT' });
  h.actor.send({ type: 'ELMO.RESP', raw: 'probe' });

  h.actor.send({ type: 'POLL.TICK' });
  assert.equal(h.ctx().inFlight.pollRole, 'data');
  assert.equal(h.ctx().queue.length, 1);
  assert.equal(h.ctx().queue[0].pollRole, 'state');
  assert.equal(h.ctx().queue[0].cmd, 'MO;SO;SR;');
  assert.equal(h.ctx().lastExtendedAt, 2000);

  feedDataPoll(h);
  const cmd = h.calls.sendCmd[h.calls.sendCmd.length - 1];
  assert.equal(cmd, 'MO;SO;SR;');
});

test('fast raw polling uses VX/PX seek poll and suppresses periodic state poll', () => {
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
  assert.equal(h.ctx().inFlight.pollRole, 'fast_seek');
  assert.equal(h.ctx().inFlight.cmd, 'VX;PX;');
  assert.equal(h.ctx().inFlight.priority, 2.5);
  assert.equal(h.ctx().lastFastPollStartedAt, 2000);
  assert.equal(h.ctx().queue.length, 0); // no MO/SO/SR while fast raw poll is healthy
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'VX;PX;');

  h.calls.forwardResp.length = 0;
  feedFastSeekPoll(h, { vx: 'VX;9;', px: 'PX;-10;' });
  assert.equal(h.calls.forwardResp.length, 1);
  assert.equal(h.calls.forwardResp[0].topic, 'poll_fast');
  assert.equal(h.ctx().fastStableCount, 1);
});

test('fast raw polling switches to VX/PX/TM poll_data after stable speed', () => {
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
  feedFastSeekPoll(h, { vx: 'VX;9;', px: 'PX;1;' });
  h.actor.send({ type: 'POLL.TICK' });
  feedFastSeekPoll(h, { vx: 'VX;9;', px: 'PX;2;' });
  assert.equal(h.ctx().fastStable, true);

  h.calls.forwardResp.length = 0;
  h.actor.send({ type: 'POLL.TICK' });
  assert.equal(h.ctx().inFlight.pollRole, 'fast_data');
  assert.equal(h.ctx().inFlight.cmd, 'VX;PX;TM;');
  feedFastDataPoll(h, { vx: 'VX;9;', px: 'PX;3;', tm: 'TM;100;' });
  assert.equal(h.calls.forwardResp.length, 1);
  assert.equal(h.calls.forwardResp[0].topic, 'poll_data');
  assert.equal(h.calls.forwardResp[0].raw, 'VX;9;PX;3;TM;100;');
});

test('invalid fast poll emits bad frame and schedules full-state diagnostics', () => {
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
  assert.equal(h.ctx().inFlight.pollRole, 'fast_seek');

  h.actor.send({ type: 'ELMO.RESP', raw: 'PX;2;' }); // missing VX
  assert.equal(badPoll(h.calls).length, 1);
  assert.equal(badPoll(h.calls)[0].role, 'fast_seek');
  assert.deepEqual(badPoll(h.calls)[0].missing, ['vx']);
  assert.equal(h.ctx().inFlight.pollRole, 'full_state');
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'MS;MO;SO;SR;AF;OL[1];OL[2];');
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
  feedDataPoll(h, { vx: 'VX;-3276800;OL[1]=1;MS=0;' });
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

  h.actor.send({ type: 'ELMO.RESP', raw: 'PX;2;VX;9.000000e+00;' }); // missing TM
  assert.equal(h.calls.forwardResp.length, 0);
  assert.equal(badPoll(h.calls).length, 1);
  assert.deepEqual(badPoll(h.calls)[0].missing, ['tm']);
  assert.equal(badPoll(h.calls)[0].cmd, 'TM;PX;VX;');
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
  h.actor.send({ type: 'UI.CMD', envelope: { id: 'jv', kind: 'cmd', cmd: 'JV=1;BG', meta: { setpointDegS: 360 } } });
  assert.equal(h.ctx().omegaSource, 'setpoint');

  h.actor.send({ type: 'ELMO.RESP', raw: 'ok' }); // command ack -> dispatch -> poll can run
  h.actor.send({ type: 'POLL.TICK' });
  feedDataPoll(h, { raw: 'TM\r1;PX\r2;VX\r0.000000e+00;OL[1]\r1;MS\r0;SO\r1;SR\r105120016;' });

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

  assert.equal(h.ctx().inFlight.pollRole, 'state');
  assert.equal(h.ctx().inFlight.cmd, 'MO;SO;SR;');
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'MO;SO;SR;');

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
  assert.equal(h.ctx().inFlight.cmd, 'MS;MO;SO;SR;AF;OL[1];OL[2];');
  assert.equal(h.calls.sendCmd[h.calls.sendCmd.length - 1], 'MS;MO;SO;SR;AF;OL[1];OL[2];');
});

test('startElmoTransport returns a started actor in offline with given resolution', () => {
  const actor = startElmoTransport({ sendCmd: () => {} }, { resolution: 'low' });
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

test('LEAN_POLL is the batched data datagram', () => {
  assert.equal(LEAN_POLL, 'TM;PX;VX;');
});
