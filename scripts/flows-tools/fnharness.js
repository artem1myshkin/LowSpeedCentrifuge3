// Offline harness for Node-RED function nodes extracted from flows.json.
// Usage: node fnharness.js <flows.json> <pkgDir>
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const FLOWS = process.argv[2];
const PKG = process.argv[3];
const flows = JSON.parse(fs.readFileSync(path.resolve(FLOWS), 'utf8'));
const byName = {}; flows.filter(n => n.type === 'function').forEach(n => byName[n.name.trim()] = n);
const nc3 = require(path.resolve(PKG));

function makeCtx(initialGlobal) {
  const store = { global: Object.assign({}, initialGlobal || {}), flow: {}, context: {} };
  const api = (bucket) => ({ get: (k) => store[bucket][k], set: (k, v) => { store[bucket][k] = v; }, keys: () => Object.keys(store[bucket]) });
  return { store, global: api('global'), flow: api('flow'), context: api('context') };
}

function runNode(name, msg, ctx, opts) {
  const n = byName[name]; if (!n) throw new Error('no node ' + name);
  const sent = []; const logs = [];
  const node = {
    send: (m) => sent.push(m), log: (m) => logs.push(['log', m]), warn: (m) => logs.push(['warn', m]),
    error: (m) => logs.push(['error', m]), status: () => {}, id: n.id, name: n.name,
  };
  const timers = [];
  const fakeTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  // Intervals are never fired automatically: tests call ctx.intervals[i].fn() themselves.
  ctx.intervals = ctx.intervals || [];
  const fakeInterval = (fn, ms) => { ctx.intervals.push({ fn, ms, node, sent, active: true }); return ctx.intervals.length; };
  const fakeClearInterval = (h) => { if (ctx.intervals[h - 1]) ctx.intervals[h - 1].active = false; };
  const fn = new Function('msg', 'node', 'global', 'flow', 'context', 'setTimeout', 'clearTimeout', 'RED', 'env', 'setInterval', 'clearInterval', n.func);
  const out = fn(msg, node, ctx.global, ctx.flow, ctx.context, fakeTimeout, () => {}, {}, { get: () => undefined }, fakeInterval, fakeClearInterval);
  // runTimers fires the SHORT timers only (sequencing delays), never long watchdogs such as
  // the 60 s tilt timeout — otherwise every automatic sequence would look like a timeout.
  if (opts && opts.runTimers) {
    const maxMs = opts.maxTimerMs == null ? 2000 : opts.maxTimerMs;
    timers.filter(t => t.ms <= maxMs).sort((a, b) => a.ms - b.ms).forEach(t => t.fn());
  }
  return { out, sent, logs, timers };
}

const CYR = /[А-Яа-яЁё]/;
let failures = 0;
function check(label, fn) { try { fn(); console.log('ok  ', label); } catch (e) { failures++; console.log('FAIL', label, '\n     ', e.message); } }

const settings = {
  general: { language: 'Russian', speedReadyTolerancePercent: 5 },
  advanced: {
    speedReadyCriterion: 'ms', rotationCommandMode: 'JV', speedReachTimeoutMs: 10000, speedStableTimeMs: 1000,
    homingSpeedDegSec: 5, homingAccelDegSec2: 1, homingSrBit: 7, speedRangeToleranceDegSec: 5,
    trWindows: { high: { positionWindowDeg: 0.02, positionTimeMs: 120, speedWindowDegSec: 0.5, speedTimeMs: 100 }, low: { positionWindowDeg: 0.01, positionTimeMs: 100, speedWindowDegSec: 0.5, speedTimeMs: 100 } },
    encoderSwitchHysteresisDegSec: 5,
  },
};

// ---------------- CommandHandler ----------------
check('CommandHandler motor_on clears pending motion with ST before MO=1', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high' });
  const r = runNode('CommandHandler', { topic: 'motor_on', payload: null }, ctx);
  assert.equal(r.out.payload, 'ST;MO=1;MO;SO;SR\r');
});

check('motor readbacks reach both dashboards and the state cache without a data poll or restart', () => {
  const byId = id => flows.find(n => n.id === id);
  const route = byId(byName.ResponseParser.wires[0][0]);
  const liveOutput = route.wires[route.rules.findIndex(r => r.v === 'poll_data')][0];
  const links = byId(liveOutput).links.flatMap(id => byId(id).wires[0]);
  const cache = byId('57266dd52d61d4de');
  const speedId = 'f0893e7d43d9e2b8', monitorId = 'cd1902e1e473a48c';
  assert.ok(links.includes(cache.id) && cache.wires[0].includes(speedId) && links.includes(monitorId));
  const views = [speedId, monitorId].map(id => {
    const script = byId(id).format.match(/<script>([\s\S]*?)<\/script>/)[1];
    const options = new Function(script.replace('export default', 'return'))();
    const view = Object.assign(options.data(), options.methods);
    for (const [key, get] of Object.entries(options.computed)) {
      Object.defineProperty(view, key, typeof get === 'function' ? { get } : get);
    }
    return view;
  });
  const ctx = makeCtx({ settings, nc3 });
  const commands = [];
  const frames = [];
  const assertMotor = (state, enabled, source) => {
    assert.equal(state.mo, enabled, source + ' MO');
    assert.equal(state.so, enabled, source + ' SO');
  };
  const actor = nc3.startElmoTransport({
    initialFullState: false,
    sendCmd: cmd => commands.push(cmd),
    forwardResp: (payload, topic) => frames.push({ topic, payload }),
  });
  try {
    actor.send({ type: 'CONNECT' });
    assert.equal(commands.shift(), 'TM');
    actor.send({ type: 'ELMO.RESP', raw: 'TM;0;' });
    for (const resolution of ['low', 'high']) {
      for (const topic of ['motor_on', 'motor_off']) {
        const request = runNode('CommandHandler', { topic, payload: null }, ctx).out;
        actor.send({ type: 'UI.CMD', envelope: { cmd: request.payload, meta: { topic } } });
        const enabled = topic === 'motor_on';
        const fields = { MO: +enabled, SO: +enabled, SR: 0, MS: 0, 'OL[1]': +(resolution === 'low'), 'VH[2]': 100 };
        while (commands.length) {
          const cmd = commands.shift();
          const raw = cmd in fields ? (resolution === 'low' ? cmd + ';' + fields[cmd] + ';' : cmd + '=' + fields[cmd]) : cmd + ';';
          actor.send({ type: 'ELMO.RESP', raw });
        }
        assert.ok(frames.some(f => f.topic === topic) && frames.some(f => f.topic === 'poll_state'));
        const responses = frames.splice(0);
        for (const [index, frame] of responses.entries()) {
          const msg = runNode('ResponseParser', frame, ctx).out;
          if (!msg) continue;
          const output = route.rules.findIndex(r => r.v === msg.topic);
          assert.ok(output >= 0 && route.wires[output].includes(liveOutput), 'missing live route for ' + msg.topic);
          ctx.global.set(cache.rules[0].p, msg.payload);
          for (const view of views) view.handleIncoming(msg);
          // The completed motor command and the independent confirmation poll each carry MO/SO.
          // An early, partial echo before the SO wait has no confirmed MO yet.
          if (index === responses.findLastIndex(f => f.topic === topic) || frame.topic === 'poll_state') {
            for (const view of views) assertMotor(view.current, enabled, frame.topic + ' (' + resolution + ')');
          }
        }
        assertMotor(ctx.global.get('drive_state'), enabled, 'drive_state');
      }
    }
    // A write echo alone must leave the display OFF. A subsequent read-only
    // health frame must update it even if no motor ACK or data poll arrives.
    for (const frame of [{ topic: 'motor_on', payload: 'MO=1;' }, { topic: 'poll_state', payload: 'MO=1;SO=1;SR=0;' }]) {
      const msg = runNode('ResponseParser', frame, ctx).out;
      for (const view of views) {
        view.handleIncoming(msg);
        assertMotor(view.current, frame.topic === 'poll_state', frame.topic);
      }
    }
  } finally { actor.stop(); }
});

check('CommandHandler manual driveInit: HM reset + one revolution, MS completion, no PX target', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', drive_state: { position: 1000, resolution: 'high' } });
  const r = runNode('CommandHandler', { topic: 'driveInit', payload: null }, ctx);
  const cmds = r.out.payload.split(/;\r/).map(s => s.replace(/\r$/, ''));
  assert.deepEqual(cmds.slice(0, 6), ['HM[3]=3', 'HM[4]=2', 'HM[5]=0', 'HM[1]=0', 'HM[1]=1', 'SR']);
  assert.ok(cmds.includes('PR=262144000'), 'PR one revolution: ' + cmds.join(' '));
  assert.equal(cmds[cmds.length - 1], 'BG');
  assert.equal(cmds.find(c => c.startsWith('SP=')), 'SP=3640889');
  assert.equal(cmds.find(c => c.startsWith('AC=')), 'AC=728178');
  const m = r.out.elmo_meta;
  assert.equal(m.waitForMotionDone, true);
  assert.equal(m.motionDoneBy, 'MS');
  assert.equal(m.targetPosition, undefined);
  assert.ok(m.minMotionMs >= 6000 && m.minMotionMs <= 6001, 'minMotionMs=' + m.minMotionMs);
  assert.ok(m.motionDoneTimeoutMs >= 60000 && m.motionDoneTimeoutMs < 200000, 'timeout=' + m.motionDoneTimeoutMs);
  assert.equal(m.revolutionTicks, 262144000);
});

check('CommandHandler full driveInit: stage 3 writes TR from settings and PX=0; stage 5 has HM reset', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high' });
  const r = runNode('CommandHandler', { topic: 'driveInit', payload: { resolution: 'low', mode: 'full' } }, ctx, { runTimers: true, maxTimerMs: Infinity });
  assert.equal(r.out, null);
  assert.equal(r.sent.length, 5);
  const stage3 = r.sent[2][0].payload;
  assert.ok(stage3.includes('OL[1]=1'), stage3);
  assert.ok(stage3.includes('TR[1]=182;'), stage3);
  assert.ok(stage3.includes('TR[2]=100;'), stage3);
  assert.ok(stage3.includes('TR[3]=9102;'), stage3);
  assert.ok(/PX=0\r$/.test(stage3), 'PX=0 must be last in stage 3: ' + JSON.stringify(stage3.slice(-20)));
  const stage5 = r.sent[4][0].payload;
  assert.ok(stage5.includes('MO=1;\rOL[1];'), stage5);
  assert.ok(stage5.includes('HM[1]=0;\rHM[1]=1;\rSR;\r'), stage5);
  assert.ok(/BG\r$/.test(stage5));
  assert.equal(r.sent[4][0].elmo_meta.waitForMotionDone, true);
  assert.equal(r.sent[4][0].elmo_meta.resolution, 'low');
});

check('CommandHandler set_resolution: PX=0 after range params, TR/VH2 read back, buffers cleared', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', velocity_sample_buffer: [{ a: 1 }] });
  ctx.flow.set('poll_buffer', { position: 555, vh2: 10922655, vh2_resolution: 'high' });
  const r = runNode('CommandHandler', { topic: 'set_resolution', payload: { resolution: 'low' } }, ctx);
  const cmds = r.out.payload.split(/;\r/).map(s => s.replace(/\r$/, ''));
  assert.equal(cmds[0], 'MO=0');
  const iTr4 = cmds.indexOf('TR[4]=100'); const iPx = cmds.indexOf('PX=0');
  assert.ok(iTr4 > 0 && iPx === iTr4 + 1, cmds.join(' '));
  assert.ok(cmds.includes('TR[1]=182') && cmds.includes('TR[3]=9102'));
  assert.ok(cmds.includes('VH[2]') && cmds.includes('TR[2]') && cmds.includes('PX'));
  assert.deepEqual(ctx.global.get('velocity_sample_buffer'), []);
  assert.equal(ctx.flow.get('poll_buffer').position, undefined);
  assert.equal(ctx.flow.get('poll_buffer').vh2, undefined);
});

check('CommandHandler set_resolution high: KP[2] in decimal form, no exponent in any command (stand 2026-11-12)', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'low' });
  const r = runNode('CommandHandler', { topic: 'set_resolution', payload: { resolution: 'high' } }, ctx);
  const cmds = r.out.payload.split(/;\r/).map(s => s.replace(/\r$/, ''));
  assert.ok(cmds.includes('KP[2]=0.0000005'), cmds.join(' '));
  assert.ok(!cmds.some(c => /=\-?[\d.]+e[+-]?\d/i.test(c)), cmds.join(' '));
  const r2 = runNode('CommandHandler', { topic: 'set_kp2', payload: { kp2: 5e-7 } }, ctx);
  assert.equal(r2.out.payload.replace(/\r$/, ''), 'KP[2]=0.0000005');
});

check('DriveInitState: failed motor_on and dropped motion starts go to the journal', () => {
  const ctx = makeCtx({ settings, current_range: 'high', logs: [] });
  let r = runNode('DriveInitState', { topic: 'CMD.FAILED', payload: { type: 'CMD.FAILED', topic: 'motor_on', reason: 'drive_fault', sr: 5, code: 5, meta: { topic: 'motor_on' } } }, ctx);
  assert.equal(r.out[0], null);
  assert.equal(r.out[1].payload.type, 'error');
  assert.ok(/двигатель не включён/.test(r.out[1].payload.message) && /SR=5, код 5/.test(r.out[1].payload.message), r.out[1].payload.message);
  assert.ok(/did not come on/.test(r.out[1].payload.message_en), r.out[1].payload.message_en);
  r = runNode('DriveInitState', { topic: 'CMD.FAILED', payload: { topic: 'motor_on', reason: 'motor_on_rejected', meta: { topic: 'motor_on' } } }, ctx);
  assert.ok(/отклонил MO=1/.test(r.out[1].payload.message), r.out[1].payload.message);
  r = runNode('DriveInitState', { topic: 'CMD.FAILED', payload: { topic: 'set_jv', reason: 'motor_not_on', meta: { topic: 'set_jv' } } }, ctx);
  assert.equal(r.out[1].payload.type, 'warning');
  assert.ok(/отменена: двигатель не включился \(set_jv\)/.test(r.out[1].payload.message), r.out[1].payload.message);
});

check('CommandHandler high TR windows from settings (0.02° -> 14564 ticks, 120 ms)', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high' });
  const r = runNode('CommandHandler', { topic: 'apply_tr_windows', payload: settings }, ctx);
  assert.equal(r.out.payload, 'TR[1]=14564;TR[2]=120;TR[3]=364089;TR[4]=100;TR[1];TR[2];TR[3];TR[4]\r');
});

check('CommandHandler: the only speed limit is |v| <= VH[2] of the pair', () => {
  // VH[2] read back from the drive for the high pair: 7281778 ticks/s = 10 deg/s
  const ctx = makeCtx({ settings, nc3, current_range: 'high', drive_vh2_ticks: { high: 7281778 } });
  const r = runNode('CommandHandler', { topic: 'set_jv', payload: { ticks: 8000000 } }, ctx); // 11 deg/s
  assert.equal(r.out, null, 'above VH[2] must be rejected');
  assert.ok(r.logs.some(l => /exceeds VH\[2\]/.test(String(l[1]))), JSON.stringify(r.logs));
  assert.equal(ctx.global.get('drive_limits').speed_max_ticks, 7281778);
  assert.equal(ctx.global.get('drive_limits').speed_min_ticks, 0, 'no lower limit any more');
  const ok = runNode('CommandHandler', { topic: 'set_jv', payload: { ticks: 7000000 } }, ctx);
  assert.ok(ok.out && /^TR\[3\]=\d+;\s*AC=/.test(ok.out.payload), 'below VH[2] accepted: ' + (ok.out && ok.out.payload));
  // reverse rotation is compared by magnitude
  assert.equal(runNode('CommandHandler', { topic: 'set_jv', payload: { ticks: -8000000 } }, ctx).out, null);
  const back = runNode('CommandHandler', { topic: 'set_jv', payload: { ticks: -7000000 } }, ctx);
  assert.ok(back.out && back.out.payload.indexOf('JV=-7000000') >= 0, back.out && back.out.payload);
  // a tiny speed that the old custom range would have rejected is now valid
  const slow = runNode('CommandHandler', { topic: 'set_jv', payload: { ticks: 20 } }, ctx);
  assert.ok(slow.out && slow.out.payload.indexOf('JV=20') >= 0);
  // without a drive value the nominal VH[2] of the pair is used
  const ctx2 = makeCtx({ settings, nc3, current_range: 'high' });
  runNode('CommandHandler', { topic: 'reread', payload: null }, ctx2);
  assert.equal(ctx2.global.get('drive_limits').speed_max_ticks, 34952533);
});

// ---------------- ResponseParser ----------------
function parse(ctx, raw, topic) { return runNode('ResponseParser', { topic: topic || 'poll_data', payload: raw }, ctx).out; }

check('ResponseParser brake: OL[2]=0 -> engaged (bun_brake true), OL[2]=1 -> released', () => {
  const ctx = makeCtx({ settings });
  assert.equal(parse(ctx, 'OL[2];0;').payload.bun_brake, true);
  assert.equal(parse(ctx, 'OL[2];1;').payload.bun_brake, false);
  assert.equal(ctx.global.get('bun_brake'), false);
});

check('ResponseParser: MS null until read, SR bit 7 -> homing_active, TR[2]/TR[4], no torque', () => {
  const ctx = makeCtx({ settings });
  const p0 = parse(ctx, 'MO;0;').payload;
  assert.equal(p0.ms, null);
  assert.equal('torque' in p0, false);
  const p1 = parse(ctx, 'SR;128;MS;2;TR[2];120;TR[4];150;').payload;
  assert.equal(p1.sr_status.homing_active, true);
  assert.equal(p1.sr_status.ok, true);
  assert.equal(p1.ms, 2);
  assert.equal(p1.tr2, 120); assert.equal(p1.tr4, 150);
  const p2 = parse(ctx, 'SR;0;').payload;
  assert.equal(p2.sr_status.homing_active, false);
});

check('ResponseParser: VH[2] is remembered per head pair and drives the limits', () => {
  const ctx = makeCtx({ settings });
  const p = parse(ctx, 'OL[1];0;VH[2];7281778;').payload;
  assert.equal(p.drive_limits.speed_max_ticks, 7281778);
  assert.equal(p.drive_limits.speed_min_ticks, 0);
  assert.equal(ctx.global.get('drive_vh2_ticks').high, 7281778);
  // switched to the low pair: its own VH[2] is not known yet -> nominal, never the high value
  const q = parse(ctx, 'OL[1];1;').payload;
  assert.equal(q.drive_limits.speed_max_ticks, 6553600);
  const r = parse(ctx, 'VH[2];3276800;').payload; // low pair reports its own limit
  assert.equal(r.drive_limits.speed_max_ticks, 3276800);
  assert.equal(ctx.global.get('drive_vh2_ticks').low, 3276800);
  // back to the high pair: the value read earlier is reused
  const t = parse(ctx, 'OL[1];0;').payload;
  assert.equal(t.drive_limits.speed_max_ticks, 7281778);
});

// ---------------- Tilt ----------------
check('Tilt node inverts OL[2]: engage(1) -> OL[2]=0, release(0) -> OL[2]=1', () => {
  const ctx = makeCtx({});
  assert.equal(runNode('Tilt', { topic: 'tilt_brake', payload: 1 }, ctx).out.payload, 'OL[2]=0;');
  assert.equal(runNode('Tilt', { topic: 'tilt_brake', payload: 0 }, ctx).out.payload, 'OL[2]=1;');
});

// ---------------- DriveInitState ----------------
check('DriveInitState: homing lifecycle with SR bit 7, angle progress and completion', () => {
  const ctx = makeCtx({ settings, current_range: 'high', logs: [] });
  const meta = { topic: 'driveInit', resolution: 'high', initMode: 'manual', waitForMotionDone: true, revolutionTicks: 262144000, motionDoneTimeoutMs: 120000, homingSpeedDegSec: 5 };
  let r = runNode('DriveInitState', { topic: 'CMD.STARTED', payload: { type: 'CMD.STARTED', topic: 'driveInit', meta } }, ctx);
  assert.equal(r.out[0].payload.status, 'initializing');
  assert.equal(r.out[0].payload.null_mark, 'searching');
  assert.ok(/запущен/.test(r.out[1].payload.message) && /started/.test(r.out[1].payload.message_en), JSON.stringify(r.out[1].payload));
  // batch echo forwarded before the wait: SR with bit 7 set -> armed
  r = runNode('DriveInitState', { topic: 'driveInit', payload: { sr: 128, sr_status: { homing_active: true, amplifier_code: 0 }, position: 0, resolution: 'high' } }, ctx);
  assert.equal(ctx.global.get('drive_init_state').homing_armed, true);
  // quarter revolution travelled in 5-degree samples (5 deg/s, 1 s polls)
  for (let k = 1; k <= 18; k++) runNode('DriveInitState', { topic: 'poll_data', payload: { sr: 128, sr_status: { homing_active: true, amplifier_code: 0 }, position: k * 3640889, ms: 2, resolution: 'high' } }, ctx);
  assert.equal(ctx.global.get('drive_init_state').progress_pct, 25, 'got ' + ctx.global.get('drive_init_state').progress_pct);
  // index captured: counter reset (jump) + bit 7 -> 0
  r = runNode('DriveInitState', { topic: 'poll_data', payload: { sr: 0, sr_status: { homing_active: false, amplifier_code: 0 }, position: 500, ms: 2, resolution: 'high' } }, ctx);
  const st = ctx.global.get('drive_init_state');
  assert.equal(st.null_mark, 'found');
  assert.equal(st.progress_pct, 25, 'jump must not count as travel');
  assert.ok([].concat(r.out[1] || []).some(m => m && /метка найдена/.test(m.payload.message)), JSON.stringify(r.out[1]));
  for (let k = 1; k <= 60; k++) runNode('DriveInitState', { topic: 'poll_data', payload: { sr: 0, position: 500 + k * 3640889, ms: 2, resolution: 'high' } }, ctx);
  assert.equal(ctx.global.get('drive_init_state').progress_pct, 99);
  r = runNode('DriveInitState', { topic: 'CMD.COMPLETED', payload: { type: 'CMD.COMPLETED', topic: 'driveInit', meta, raw: 'MS;0;TM;1;PX;2;VX;0;SR;0;' } }, ctx);
  const done = r.out[0].payload;
  assert.equal(done.status, 'done'); assert.equal(done.initialized, true); assert.equal(done.progress_pct, 100);
  assert.ok(/завершён \(high\)/.test(r.out[1].payload.message) && /completed \(high\)/.test(r.out[1].payload.message_en), r.out[1].payload.message);
  assert.equal(ctx.global.get('null_mark_state').status, 'found');
});

check('DriveInitState: revolution completed without index capture -> failed "не найдена" with travel and PX', () => {
  // Stand 2026-11-11 (low pair): PX 0 -> 6553625 after a full turn, the counter never jumped.
  const ctx = makeCtx({ settings, current_range: 'low', logs: [] });
  const meta = { topic: 'driveInit', resolution: 'low', waitForMotionDone: true, revolutionTicks: 6553600, homingSpeedDegSec: 5 };
  runNode('DriveInitState', { topic: 'CMD.STARTED', payload: { topic: 'driveInit', meta } }, ctx);
  for (let k = 0; k <= 72; k++) runNode('DriveInitState', { topic: 'poll_data', payload: { sr: 128, position: k * 91022, resolution: 'low' } }, ctx);
  const r = runNode('DriveInitState', { topic: 'CMD.COMPLETED', payload: { topic: 'driveInit', meta, raw: 'MS;1;TM;1;PX;6553625;VX;0;SR;128;' } }, ctx);
  assert.equal(r.out[0].payload.status, 'failed');
  assert.equal(r.out[0].payload.null_mark, 'not_found');
  assert.ok(/не найдена/.test(r.out[0].payload.last_error) && /Index/.test(r.out[0].payload.last_error), r.out[0].payload.last_error);
  assert.ok(/пройдено 360°, PX=6553625/.test(r.out[1].payload.message), r.out[1].payload.message);
  assert.ok(/travelled 360°, PX=6553625/.test(r.out[1].payload.message_en), r.out[1].payload.message_en);
});

check('DriveInitState: no travel after BG -> "оборот не выполнен", not "метка не найдена"', () => {
  const ctx = makeCtx({ settings, current_range: 'high', logs: [] });
  const meta = { topic: 'driveInit', resolution: 'high', waitForMotionDone: true, revolutionTicks: 262144000 };
  runNode('DriveInitState', { topic: 'CMD.STARTED', payload: { topic: 'driveInit', meta } }, ctx);
  runNode('DriveInitState', { topic: 'poll_data', payload: { sr: 128, position: 0, resolution: 'high' } }, ctx);
  const r = runNode('DriveInitState', { topic: 'CMD.COMPLETED', payload: { topic: 'driveInit', meta, raw: 'MS;0;SR;128;' } }, ctx);
  assert.equal(r.out[0].payload.status, 'failed');
  assert.equal(r.out[0].payload.null_mark, 'not_found');
  assert.ok(/Оборот не выполнен/.test(r.out[0].payload.last_error) && /пройдено 0°/.test(r.out[0].payload.last_error), r.out[0].payload.last_error);
});

check('DriveInitState: CMD.PART_LOST from the transport goes to the journal (re-send / motion wait)', () => {
  const ctx = makeCtx({ settings, current_range: 'low', logs: [] });
  let r = runNode('DriveInitState', { topic: 'CMD.PART_LOST', payload: { type: 'CMD.PART_LOST', cmd: 'HM[1]=1', action: 'resend', topic: 'driveInit', meta: {} } }, ctx);
  assert.equal(r.out[0], null);
  assert.equal(r.out[1].payload.type, 'warning');
  assert.ok(/«HM\[1\]=1»/.test(r.out[1].payload.message) && /отправлена повторно/.test(r.out[1].payload.message), r.out[1].payload.message);
  r = runNode('DriveInitState', { topic: 'CMD.PART_LOST', payload: { cmd: 'BG', action: 'motion_wait', topic: 'driveInit', meta: {} } }, ctx);
  assert.ok(/«BG»/.test(r.out[1].payload.message) && /опросу MS\/PX\/SR/.test(r.out[1].payload.message), r.out[1].payload.message);
  assert.ok(/No ELMO reply to "BG"/.test(r.out[1].payload.message_en), r.out[1].payload.message_en);
});

check('DriveInitState: resolution switch resets the null-mark status; old journal wording still recognised', () => {
  const ctx = makeCtx({ settings, current_range: 'high', logs: [{ message: 'Drive Init: completed (high)' }], drive_init_state: { status: 'done', initialized: true, null_mark: 'found', resolution: 'high' } });
  let r = runNode('DriveInitState', { topic: 'CMD.ACKED', payload: { topic: 'set_resolution', meta: { resolution: 'low' } } }, ctx);
  assert.equal(r.out[0].payload.null_mark, 'unknown');
  assert.equal(r.out[0].payload.status, 'not_done');
  const ctx2 = makeCtx({ settings, current_range: 'high', logs: [{ message: 'Drive Init: completed (high)' }] });
  r = runNode('DriveInitState', { topic: 'reread', payload: { resolution: 'high' } }, ctx2);
  assert.equal(ctx2.global.get('drive_init_state').status, 'done');
  assert.equal(ctx2.global.get('drive_init_state').null_mark, 'found');
});

// ---------------- ScenarioManager ----------------
function ackScenarioSpeed(ctx, topic) {
  const speedRequestId = ctx.global.get('scenario_state').speed_request_id;
  return runNode('ScenarioManager', { topic: 'CMD.ACKED', payload: { topic, meta: { topic, verifyMotionStart: true, speedRequestId } } }, ctx);
}

check('ScenarioManager: full homing before first step, JV command, MS criterion ramp -> ready -> hold', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', logs: [], scenario_files: ['t.scn'], drive_state: { mo: false, so: false } });
  ctx.flow.set('motion_params', { sp: 728178, ac: 364088, dc: 364088 }); // 0.5 deg/s^2
  let r = runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 't.scn' } }, ctx);
  assert.equal(r.out[3].topic, 'scenario_file_loaded');
  r = runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n5 10\n' }, ctx);
  assert.equal(r.out[0][0].topic, 'driveInit');
  assert.equal(r.out[0][0].payload.mode, 'full');
  assert.equal(ctx.global.get('scenario_state').status, 'drive_init_pending');
  ctx.global.set('drive_init_state', { status: 'done', initialized: true, resolution: 'high', null_mark: 'found' });
  ctx.global.set('drive_state', { mo: true, so: true });
  r = runNode('ScenarioManager', { topic: 'CMD.COMPLETED', payload: { topic: 'driveInit', meta: { topic: 'driveInit' } } }, ctx);
  assert.equal(r.out[0][0].topic, 'set_jv', 'JV by default: ' + JSON.stringify(r.out[0]));
  assert.equal(r.out[0][0].payload.ticks, 3640889);
  r = ackScenarioSpeed(ctx, 'set_jv');
  let st = ctx.global.get('scenario_state');
  assert.equal(st.status, 'waiting_ready');
  assert.equal(st.ready_criterion, 'ms');
  assert.ok(st.speed_reach_ramp_ms >= 10000 && st.speed_reach_ramp_ms <= 10010, 'ramp 5/0.5 = 10 s, got ' + st.speed_reach_ramp_ms);
  // MS=0 inside the ramp must be ignored
  r = runNode('ScenarioManager', { topic: 'poll_state', payload: { ms: 0, velocity_deg_per_sec: 5, resolution: 'high' } }, ctx);
  st = ctx.global.get('scenario_state');
  assert.equal(st.ready, false); assert.equal(st.ready_phase, 'ramp');
  // simulate the ramp elapsed
  st.ready_eval.startedAt -= 11000; st.speed_reach_started_at -= 11000; ctx.global.set('scenario_state', st);
  r = runNode('ScenarioManager', { topic: 'poll_state', payload: { ms: 2, velocity_deg_per_sec: 4.9, resolution: 'high' } }, ctx);
  st = ctx.global.get('scenario_state');
  assert.equal(st.ready, false); assert.equal(st.ready_phase, 'ms_wait');
  // in the TR[3] window: ready after the TR[4] dwell even though MS stays 2 (continuous JV)
  st.ready_eval.inWindowSince -= 200; ctx.global.set('scenario_state', st);
  r = runNode('ScenarioManager', { topic: 'poll_state', payload: { ms: 2, velocity_deg_per_sec: 5, resolution: 'high' } }, ctx);
  st = ctx.global.get('scenario_state');
  assert.equal(st.status, 'holding'); assert.equal(st.ready, true);
  assert.ok(r.out[1].some(m => m.topic === 'start_recording'));
});

check('ScenarioManager: MS timeout after the ramp fails the scenario with a journal entry', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', logs: [], drive_state: { mo: true, so: true }, drive_init_state: { status: 'done', initialized: true, resolution: 'high' } });
  ctx.flow.set('motion_params', { sp: 728178, ac: 364088, dc: 364088 });
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 'high_resolution.scn' } }, ctx);
  runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n5 10\n' }, ctx);
  ackScenarioSpeed(ctx, 'set_jv');
  let st = ctx.global.get('scenario_state');
  st.ready_eval.startedAt -= 25000; ctx.global.set('scenario_state', st);
  const r = runNode('ScenarioManager', { topic: 'poll_state', payload: { ms: 1, velocity_deg_per_sec: 4, resolution: 'high' } }, ctx);
  st = ctx.global.get('scenario_state');
  assert.equal(st.status, 'error');
  assert.ok(/MS/.test(st.last_error), st.last_error);
  assert.ok(r.out[1].some(m => m.topic === 'journal_event' && /ошибка/.test(m.payload.message)));
});

check('ScenarioManager: JP mode falls back to the software criterion', () => {
  const s2 = JSON.parse(JSON.stringify(settings)); s2.advanced.rotationCommandMode = 'JP';
  const ctx = makeCtx({ settings: s2, nc3, current_range: 'high', logs: [], drive_state: { mo: true, so: true }, drive_init_state: { status: 'done', initialized: true, resolution: 'high' } });
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 'high_resolution.scn' } }, ctx);
  const r = runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n5 10\n' }, ctx);
  assert.equal(r.out[0][0].topic, 'set_jp');
  ackScenarioSpeed(ctx, 'set_jp');
  assert.equal(ctx.global.get('scenario_state').ready_criterion, 'software');
});

check('Scenario startup verifies BG for homing, JV and JP; pre-ACK polls cannot start a recording', () => {
  for (const mode of ['JV', 'JP']) {
    const cfg = { ...settings, advanced: { ...settings.advanced, rotationCommandMode: mode } };
    const ctx = makeCtx({ settings: cfg, nc3, current_range: 'high', logs: [] });
    runNode('ScenarioManager', { topic: 'scenario_start' }, ctx);
    const init = runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n-2 10\n' }, ctx).out[0][0];
    assert.equal(init.payload.verifyMotionStart, true);
    const staged = runNode('CommandHandler', init, ctx);
    staged.timers.forEach(t => t.fn());
    assert.match(staged.sent.at(-1)[0].payload, /PR=\d+;\rPX;\rVX;\rBG\r$/);
    assert.equal(staged.sent.at(-1)[0].elmo_meta.verifyMotionStart, true);
    const cancelled = runNode('CommandHandler', init, ctx);
    runNode('CommandHandler', { topic: 'drive_stop' }, ctx);
    cancelled.timers.forEach(t => t.fn());
    assert.equal(cancelled.sent.length, 1, 'only the initial ST was sent');

    const speed = runNode('ScenarioManager', { topic: 'CMD.COMPLETED', payload: { topic: 'driveInit' } }, ctx).out[0][0];
    assert.equal(speed.topic, 'set_' + mode.toLowerCase());
    const targetTicks = speed.payload.ticks;
    const cmd = runNode('CommandHandler', speed, ctx).out;
    assert.ok(cmd.payload.includes(mode + '=' + targetTicks + ';PX;VX;BG;'));
    assert.equal(cmd.elmo_meta.targetVelocity, targetTicks);
    assert.equal(cmd.elmo_meta.speedRequestId, ctx.global.get('scenario_state').speed_request_id);
    assert.equal(cmd.elmo_meta.verifyMotionStart, true);
    runNode('ScenarioManager', { topic: 'poll_data', payload: { velocity_deg_per_sec: -2, ms: 0 } }, ctx);
    runNode('ScenarioManager', { topic: 'CMD.ACKED', payload: { topic: cmd.topic } }, ctx);
    assert.equal(ctx.global.get('scenario_state').status, 'commanding');
    runNode('ScenarioManager', { topic: 'scenario_pause' }, ctx);
    runNode('ScenarioManager', { topic: 'CMD.FAILED', payload: { topic: speed.topic, reason: 'operator_aborted' } }, ctx);
    assert.equal(ctx.global.get('scenario_state').status, 'paused');
    assert.equal(ctx.global.get('scenario_state').can_resume, true);
  }
});

check('a silent speed command times out; an ACK or watchdog from before resume cannot affect the new attempt', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', drive_state: { mo: true, so: true },
    drive_init_state: { status: 'done', initialized: true, resolution: 'high' } });
  runNode('ScenarioManager', { topic: 'scenario_start' }, ctx);
  const first = runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n1 10\n' }, ctx);
  runNode('ScenarioManager', { topic: 'scenario_pause' }, ctx);
  const resumed = runNode('ScenarioManager', { topic: 'scenario_resume' }, ctx);
  const oldMeta = first.out[0][0].payload;
  runNode('ScenarioManager', { topic: 'CMD.ACKED', payload: { topic: 'set_jv', meta: oldMeta } }, ctx);
  first.timers.find(t => t.ms === 60000).fn();
  assert.equal(ctx.global.get('scenario_state').status, 'commanding');
  resumed.timers.find(t => t.ms === 60000).fn();
  assert.equal(ctx.global.get('scenario_state').status, 'error');
  assert.equal(resumed.sent.at(-1)[0][0].topic, 'drive_stop');
});

// ---------------- SettingsNormalize ----------------
check('SettingsNormalize: defaults, TR[2]=0 rejected, legacy range keys dropped, TR apply only on change', () => {
  const ctx = makeCtx({ drive_vh2_ticks: { high: 7281778 } });
  let r = runNode('SettingsNormalize', { topic: 'settings_aply', payload: { advanced: {
    trWindows: { high: { positionTimeMs: 0 } },
    encoderSwitchSpeed: { decimalDeg: 30 },
    rotationSpeedRanges: { high: { min: { decimalDeg: 1 }, max: { decimalDeg: 20 } } },
    speedRangeToleranceDegSec: 5,
    encoderSwitchHysteresisDegSec: 7,
  } } }, ctx);
  const s = r.out[0].payload;
  assert.equal(s.advanced.speedReadyCriterion, 'ms');
  assert.equal(s.advanced.rotationCommandMode, 'JV');
  assert.equal(s.advanced.trWindows.high.positionTimeMs, 100);
  // custom ranges and the hand-entered boundary are gone; limits come from VH[2]
  assert.equal(s.advanced.rotationSpeedRanges, undefined);
  assert.equal(s.advanced.encoderSwitchSpeed, undefined);
  assert.equal(s.advanced.speedRangeToleranceDegSec, undefined);
  assert.equal(s.advanced.encoderSwitchHysteresisDegSec, 7, 'hysteresis stays configurable');
  assert.deepEqual(s.advanced.driveVh2Ticks, { high: 7281778 });
  assert.equal(r.out[1].topic, 'apply_tr_windows');
  r = runNode('SettingsNormalize', { topic: 'settings_aply', payload: { general: { recordingSaveRawData: true } } }, ctx);
  assert.equal(r.out[1], null, 'no TR change -> no apply');
});

check('Scenario range switching follows VH[2] of the high pair', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', logs: [], drive_state: { mo: true, so: true }, drive_init_state: { status: 'done', initialized: true, resolution: 'high' } });
  // 30 deg/s fits the high pair (VH[2] ~48), so the scenario must not switch pairs
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 'high_resolution.scn' } }, ctx);
  let r = runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n30 10\n' }, ctx);
  assert.equal(r.out[0][0].topic, 'set_jv', JSON.stringify(r.out[0]));
  assert.equal(ctx.global.get('scenario_state').steps[0].resolution, 'high');
  // above the high-pair VH[2] the scenario asks for the low pair
  const ctx2 = makeCtx({ settings, nc3, current_range: 'high', logs: [], drive_state: { mo: true, so: true }, drive_init_state: { status: 'done', initialized: true, resolution: 'high' } });
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 'high_resolution.scn' } }, ctx2);
  r = runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n120 10\n' }, ctx2);
  assert.equal(ctx2.global.get('scenario_state').steps[0].resolution, 'low');
  assert.equal(ctx2.global.get('scenario_state').status, 'range_switch_pending');
});


// ---------------- homing stop on index capture (Recommendations 6, step 6) ----------------
check('DriveInitState: index capture emits homing_stop; the resulting abort completes the search', () => {
  const ctx = makeCtx({ settings, current_range: 'high', logs: [] });
  const meta = { topic: 'driveInit', resolution: 'high', waitForMotionDone: true, revolutionTicks: 262144000, homingSpeedDegSec: 5 };
  runNode('DriveInitState', { topic: 'CMD.STARTED', payload: { topic: 'driveInit', meta } }, ctx);
  runNode('DriveInitState', { topic: 'driveInit', payload: { sr: 128, sr_status: { homing_active: true, amplifier_code: 0 }, position: 0, resolution: 'high' } }, ctx);
  let r = runNode('DriveInitState', { topic: 'poll_data', payload: { sr: 0, sr_status: { homing_active: false, amplifier_code: 0 }, position: 3640889, ms: 2, resolution: 'high' } }, ctx);
  assert.ok(r.out[2] && r.out[2].topic === 'homing_stop', 'homing_stop must be emitted on output 3: ' + JSON.stringify(r.out[2]));
  assert.equal(ctx.global.get('drive_init_state').stop_requested, true);
  // a second poll must not emit the stop again
  r = runNode('DriveInitState', { topic: 'poll_data', payload: { sr: 0, position: 3640889 * 2, ms: 2, resolution: 'high' } }, ctx);
  assert.ok(!r || !r.out || !r.out[2], 'no duplicate homing_stop');
  // transport aborts the revolution because of our ST -> success, not an error
  r = runNode('DriveInitState', { topic: 'CMD.FAILED', payload: { topic: 'driveInit', reason: 'operator_aborted', meta } }, ctx);
  assert.equal(r.out[0].payload.status, 'done');
  assert.equal(r.out[0].payload.null_mark, 'found');
  assert.ok(/завершён/.test(r.out[1].payload.message) && /completed/.test(r.out[1].payload.message_en), JSON.stringify(r.out[1].payload));
  // ST;HM[7];PX echo -> HM[7] offset journaled
  r = runNode('DriveInitState', { topic: 'CMD.ACKED', payload: { topic: 'homing_stop', raw: 'ST;;HM[7];123456;PX;789;MS;0;' } }, ctx);
  assert.equal(r.out[0].payload.hm7_offset, 123456);
  assert.ok(/HM\[7\]=123456, PX=789/.test(r.out[1].payload.message), r.out[1].payload.message);
});

check('DriveInitState: operator STOP without index capture is still a failure', () => {
  const ctx = makeCtx({ settings, current_range: 'high', logs: [] });
  const meta = { topic: 'driveInit', resolution: 'high', waitForMotionDone: true };
  runNode('DriveInitState', { topic: 'CMD.STARTED', payload: { topic: 'driveInit', meta } }, ctx);
  const r = runNode('DriveInitState', { topic: 'CMD.FAILED', payload: { topic: 'driveInit', reason: 'operator_aborted', meta } }, ctx);
  assert.equal(r.out[0].payload.status, 'failed');
});

check('CommandHandler homing_stop -> ST;HM[7];PX;MS', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high' });
  const r = runNode('CommandHandler', { topic: 'homing_stop', payload: {} }, ctx);
  assert.equal(r.out.payload, 'ST;HM[7];PX;MS\r');
});

check('ScenarioManager: homing aborted by homing_stop (index found) continues to the step', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', logs: [], scenario_files: ['t.scn'], drive_state: { mo: false, so: false } });
  ctx.flow.set('motion_params', { sp: 728178, ac: 364088, dc: 364088 });
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 't.scn' } }, ctx);
  runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n2 10\n' }, ctx);
  assert.equal(ctx.global.get('scenario_state').status, 'drive_init_pending');
  ctx.global.set('drive_init_state', { status: 'done', initialized: true, resolution: 'high', null_mark: 'found', stop_requested: true });
  ctx.global.set('drive_state', { mo: true, so: true });
  const r = runNode('ScenarioManager', { topic: 'CMD.FAILED', payload: { topic: 'driveInit', reason: 'operator_aborted', meta: { topic: 'driveInit' } } }, ctx);
  assert.equal(r.out[0][0].topic, 'set_jv', JSON.stringify(r.out[0]));
  assert.equal(ctx.global.get('scenario_state').status, 'commanding');
});

check('ScenarioManager: MS=2 at steady JV -> ready by TR[3]/TR[4] window after the ramp', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', logs: [], drive_state: { mo: true, so: true }, drive_init_state: { status: 'done', initialized: true, resolution: 'high' } });
  ctx.flow.set('motion_params', { sp: 728178, ac: 364088, dc: 364088 });
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 'high_resolution.scn' } }, ctx);
  runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n2 10\n' }, ctx);
  ackScenarioSpeed(ctx, 'set_jv');
  let st = ctx.global.get('scenario_state');
  st.ready_eval.startedAt -= 5000; ctx.global.set('scenario_state', st);
  runNode('ScenarioManager', { topic: 'poll_state', payload: { ms: 2, velocity_deg_per_sec: 2.0047, resolution: 'high' } }, ctx);
  st = ctx.global.get('scenario_state');
  assert.equal(st.ready, false, 'dwell TR[4]=100 ms not elapsed yet');
  st.ready_eval.inWindowSince -= 200; ctx.global.set('scenario_state', st);
  const r = runNode('ScenarioManager', { topic: 'poll_state', payload: { ms: 2, velocity_deg_per_sec: 2.0047, resolution: 'high' } }, ctx);
  st = ctx.global.get('scenario_state');
  assert.equal(st.status, 'holding');
  assert.ok(r.out[1].some(m => m.topic === 'journal_event' && /окну TR\[3\]/.test(m.payload.message)), JSON.stringify(r.out[1].map(m => m.payload && m.payload.message)));
});

// ---------------- BUN AutoTilt: mode recognition from both tabs ----------------
check('BUN AutoTilt: "Авто" from Monitoring runs the automatic sequence (brake release, GO, brake engage)', () => {
  for (const mode of ['Авто', 'Автоматический', 'Automatic', 'Auto']) {
    const ctx = makeCtx({ settings, bun: {} });
    const r = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 3600, mode }, ctx, { runTimers: true });
    assert.equal(r.out, null);
    assert.equal(ctx.flow.get('bun_auto_state').status, 'moving', mode);
    const brakeRelease = r.sent.find(m => m[2] && m[2].topic === 'tilt_brake');
    assert.ok(brakeRelease && brakeRelease[2].payload === 0, 'brake released first for mode ' + mode);
    assert.ok(r.sent.some(m => m[1] && m[1].topic === 'bun_cmd' && m[1].payload === 'go'), 'GO sent for ' + mode);
    // target reached 3 samples in a row -> brake engaged, then release of drivers
    for (let i = 0; i < 3; i++) runNode('BUN AutoTilt', { topic: 'bun_angle', payload: 3600 }, ctx);
    assert.equal(ctx.flow.get('bun_auto_state').status, 'complete', mode);
  }
});

check('BUN AutoTilt gets bun_angle in the real flow and engages the brake within 4″ of the target', () => {
  // The MQTT bun_angle path (" BUN Calibration") must reach AutoTilt, otherwise arrival is never seen.
  const cal = flows.find(n => n.id === '94eeeeb32753f795');
  assert.ok(cal.wires[0].includes(byName['BUN AutoTilt'].id), 'BUN Calibration -> BUN AutoTilt wire');
  const ctx = makeCtx({ settings, bun: {} });
  runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 0, mode: 'Авто' }, ctx, { runTimers: true });
  // 0°0′4″ at target 0 counts as reached (default tolerance 5″)
  let last;
  for (let i = 0; i < 3; i++) last = runNode('BUN AutoTilt', { topic: 'bun_angle', payload: i === 1 ? -4 : 4 }, ctx);
  assert.equal(ctx.flow.get('bun_auto_state').status, 'complete');
  assert.ok(last.sent.some(m => m[2] && m[2].topic === 'tilt_brake' && m[2].payload === 1), 'brake engaged');
  // 8″ off is not reached
  const ctx2 = makeCtx({ settings, bun: {} });
  runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 0, mode: 'Авто' }, ctx2, { runTimers: true });
  for (let i = 0; i < 5; i++) runNode('BUN AutoTilt', { topic: 'bun_angle', payload: 8 }, ctx2);
  assert.equal(ctx2.flow.get('bun_auto_state').status, 'moving');
});

check('BUN AutoTilt: manual mode and missing msg.mode fall back to the stored mode', () => {
  const ctx = makeCtx({ settings, bun: {} });
  runNode('BUN AutoTilt', { topic: 'tilt_mode', payload: 'Ручной' }, ctx);
  let r = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 1800 }, ctx, { runTimers: true });
  assert.equal(ctx.flow.get('bun_auto_state').status, 'manual_go');
  assert.ok(!r.sent.some(m => m[2] && m[2].topic === 'tilt_brake'), 'manual: no automatic brake');
  runNode('BUN AutoTilt', { topic: 'tilt_mode', payload: 'Автоматический' }, ctx);
  r = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 1800 }, ctx, { runTimers: true });
  assert.equal(ctx.flow.get('bun_auto_state').status, 'moving', 'stored auto mode used when msg.mode is absent');
});

check('ScenarioManager: ramp after homing/pause is computed from zero speed, not the previous step', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', logs: [], scenario_files: ['t.scn'], drive_state: { mo: true, so: true }, drive_init_state: { status: 'done', initialized: true, resolution: 'high', null_mark: 'found' } });
  ctx.flow.set('motion_params', { sp: 728178, ac: 364088, dc: 364088 }); // 0.5 deg/s^2
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 't.scn' } }, ctx);
  runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n5 10\n' }, ctx);
  // stale "current speed" 25 deg/s measured long ago must not shorten the ramp
  let st = ctx.global.get('scenario_state');
  st.current_speed_deg_per_sec = 25; st.current_speed_updated_at = Date.now() - 20000; ctx.global.set('scenario_state', st);
  ackScenarioSpeed(ctx, 'set_jv');
  st = ctx.global.get('scenario_state');
  assert.equal(st.speed_reach_from_deg_per_sec, 0);
  assert.ok(st.speed_reach_ramp_ms >= 10000, 'ramp from zero: ' + st.speed_reach_ramp_ms);
  // pause resets the current speed (ST stops the axis)
  runNode('ScenarioManager', { topic: 'scenario_pause', payload: {} }, ctx);
  assert.equal(ctx.global.get('scenario_state').current_speed_deg_per_sec, 0);
});

// ---------------- journal refresh must not clobber a running null-mark search ----------------
check('EventLogService: event_log_refresh keeps the DriveInitState-owned state (progress bar regression)', () => {
  const ctx = makeCtx({ settings, current_range: 'high', logs: [], drive_init_state: { status: 'initializing', in_progress: true, null_mark: 'searching', homing_armed: true, progress_pct: 37, travel_ticks: 5, last_position: 123, stop_requested: false, resolution: 'high', started_at: Date.now() } });
  const lines = [JSON.stringify({ time: '10:00:00', type: 'info', message: 'Drive Init: completed (high)', source: 'drive_init' })].join('\n') + '\n';
  const r = runNode('EventLogService', { topic: 'event_log_refresh', journalAction: 'event_log_result', payload: lines }, ctx);
  const st = ctx.global.get('drive_init_state');
  assert.equal(st.in_progress, true);
  assert.equal(st.progress_pct, 37);
  assert.equal(st.homing_armed, true);
  const emitted = (r.out[0] || []).find(m => m && m.topic === 'drive_init_state');
  assert.ok(emitted && emitted.payload.in_progress === true, 'UI gets the live state, not a journal-derived one');
  // after a restart (no state in global) the journal still restores the last known status
  const ctx2 = makeCtx({ settings, current_range: 'high', logs: [] });
  runNode('EventLogService', { topic: 'event_log_refresh', journalAction: 'event_log_result', payload: lines }, ctx2);
  assert.equal(ctx2.global.get('drive_init_state').status, 'done');
});

check('DriveInitState: progress keeps accumulating between polls when the visible state is unchanged', () => {
  const ctx = makeCtx({ settings, current_range: 'high', logs: [] });
  const meta = { topic: 'driveInit', resolution: 'high', waitForMotionDone: true, revolutionTicks: 262144000, homingSpeedDegSec: 5 };
  runNode('DriveInitState', { topic: 'CMD.STARTED', payload: { topic: 'driveInit', meta } }, ctx);
  // 0.5 deg per poll: pct stays 0 for the first samples, but travel/last_position must persist
  for (let k = 1; k <= 8; k++) runNode('DriveInitState', { topic: 'poll_data', payload: { sr: 128, position: Math.round(k * 0.5 * 728177.78), ms: 2, resolution: 'high' } }, ctx);
  const st = ctx.global.get('drive_init_state');
  assert.ok(Math.abs(st.travel_ticks / 728177.78 - 3.5) < 0.01, 'travel 3.5 deg, got ' + st.travel_ticks / 728177.78);
  assert.equal(st.progress_pct, 1);
});

// ---------------- iteration 2: safety, data file, pressure, journal depth ----------------
check('CommandGate: stop commands pass in every remote-mode combination', () => {
  const remote = { remoteEnabled: true, ownerSocketId: 'sock-remote', ownerIp: '10.0.0.5' };
  for (const topic of ['emergency_stop', 'drive_stop', 'motor_off', 'scenario_emergency_stop', 'scenario_stop']) {
    const ctx = makeCtx({ remoteSession: remote });
    const local = runNode('CommandGate', { topic, payload: {}, _client: { socketIp: '127.0.0.1', socketId: 'loc' } }, ctx);
    assert.ok(local.out[0], 'local ' + topic + ' must pass while the remote owns control');
    const ctx2 = makeCtx({ remoteSession: remote });
    const other = runNode('CommandGate', { topic, payload: {}, _client: { socketIp: '10.0.0.9', socketId: 'other' } }, ctx2);
    assert.ok(other.out[0], 'non-owner ' + topic + ' must pass (stopping is fail-safe)');
  }
  // a control command from the local client is still blocked while the remote owns control
  const ctx3 = makeCtx({ remoteSession: remote });
  const blocked = runNode('CommandGate', { topic: 'set_jv', payload: {}, _client: { socketIp: '127.0.0.1', socketId: 'loc' } }, ctx3);
  assert.equal(blocked.out[0], null);
  assert.ok(blocked.out[1]);
});

check('angle_buffer: TM overflow (~71.6 min) is compensated', () => {
  const ctx = makeCtx({ is_recording: true, current_range: 'high', recording_duration_sec: 100000 });
  const feed = (tm, px) => runNode('angle_buffer', { topic: 'poll_data', payload: { position: px, tm_us: tm, resolution: 'high' } }, ctx);
  feed(4294900000, 1000);
  feed(4294960000, 2000);
  feed(30000, 3000); // wrapped
  feed(90000, 4000);
  const buf = ctx.global.get('angle_buffer');
  assert.equal(buf.length, 4);
  const t = buf.map(p => p.t);
  for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1], 'time must increase across the wrap: ' + JSON.stringify(t));
  assert.ok(Math.abs((t[3] - t[0]) - 0.157296) < 0.001, 'span 0.157296 s, got ' + (t[3] - t[0]));
});

check('ProtocolManager data file (English): degrees column, normalized time, encoding fields', () => {
  const s2 = JSON.parse(JSON.stringify(settings)); s2.general.recordingSaveRawData = true;
  const ctx = makeCtx({ current_range: 'high', recording_duration_sec: 60, velocity_setpoint_ticks: 728178, protocol_open: true, protocol_filename: 'C:\\NC3\\protocols\\protocol_x.txt', is_recording: true, is_recording_raw: true, recording_save_raw_data: true, settings: s2 });
  const base = 4000.0;
  const buf = [];
  for (let i = 0; i < 20; i++) buf.push({ t: base + i * 0.1, tm_us: (base + i * 0.1) * 1e6, ticks: Math.round(i * 0.1 * 728177.78), angle: i * 0.1, resolution: 'high' });
  ctx.global.set('angle_buffer', buf);
  const r = runNode('ProtocolManager', { topic: 'close_protocol', payload: {} }, ctx);
  const msgs = [].concat(r.out[0] || [], r.out[1] || [], r.out[2] || []).filter(Boolean);
  const dataMsg = msgs.find(m => m && typeof m.filename === 'string' && m.filename.indexOf('\\data\\') >= 0);
  assert.ok(dataMsg, 'data file written: ' + JSON.stringify(msgs.map(m => m && m.filename)));
  const text = String(dataMsg.payload);
  assert.ok(text.includes('Time  Angle  Counts # second  degree  ticks'), 'header: ' + text.split('\n').find(l => l.startsWith('Time')));
  assert.ok(text.includes('Encoding             UTF-8'));
  assert.ok(text.includes('Decimal_separator    .'));
  assert.ok(!/[А-Яа-яЁё]/.test(text), 'new data files are in English');
  const rows = text.split('\n').filter(l => /^\d/.test(l));
  assert.equal(rows[0].split(/\s+/)[0], '0.0000', 'time normalized from zero: ' + rows[0]);
  const parts = rows[1].split(/\s+/);
  assert.ok(Math.abs(Number(parts[1]) - 0.1) < 1e-4, 'angle in degrees: ' + rows[1]);
  assert.ok(Number(parts[2]) > 1000, 'ticks kept as the third column: ' + rows[1]);
});

check('ResponseParser: AN[1] -> pressure by settings, STO flag from SR code 7', () => {
  const s2 = JSON.parse(JSON.stringify(settings));
  s2.advanced.pressure = { enabled: true, scalePerVolt: 2, offset: 0.5, unit: 'атм', warnBelow: 4 };
  const ctx = makeCtx({ settings: s2 });
  let p = runNode('ResponseParser', { topic: 'poll_state', payload: 'AN[1];3.0;' }, ctx).out.payload;
  assert.equal(p.pressure_volts, 3);
  assert.equal(p.pressure_value, 6.5);
  assert.equal(p.pressure_low, false);
  assert.equal(ctx.global.get('pressure_state').value, 6.5);
  p = runNode('ResponseParser', { topic: 'poll_state', payload: 'AN[1];1.0;' }, ctx).out.payload;
  assert.equal(p.pressure_value, 2.5);
  assert.equal(p.pressure_low, true, 'below the warning threshold');
  const sr = runNode('ResponseParser', { topic: 'poll_state', payload: 'SR;7;' }, ctx).out.payload;
  assert.equal(sr.sr_status.sto_active, true);
  assert.equal(sr.sr_status.amplifier_code, 7);
});

check('DriveInitState journals pressure/STO transitions once per change', () => {
  const ctx = makeCtx({ settings, current_range: 'high', logs: [] });
  const poll = (d) => runNode('DriveInitState', { topic: 'poll_state', payload: Object.assign({ resolution: 'high' }, d) }, ctx);
  let r = poll({ pressure_value: 6, pressure_unit: 'атм', pressure_low: false, sr_status: { amplifier_code: 0, sto_active: false } });
  r = poll({ pressure_value: 2, pressure_unit: 'атм', pressure_low: true, sr_status: { amplifier_code: 0, sto_active: false } });
  const lowMsgs = [].concat(r.out[1] || []).filter(Boolean);
  assert.ok(lowMsgs.some(m => /Низкое давление/.test(m.payload.message)), JSON.stringify(lowMsgs));
  r = poll({ pressure_value: 2, pressure_unit: 'атм', pressure_low: true, sr_status: { amplifier_code: 0, sto_active: false } });
  assert.ok(!r || !r.out || !r.out[1] || [].concat(r.out[1]).filter(Boolean).length === 0, 'no repeat while the state is unchanged');
  r = poll({ pressure_value: 2, pressure_unit: 'атм', pressure_low: true, sr_status: { amplifier_code: 7, sto_active: true } });
  const stoMsgs = [].concat(r.out[1] || []).filter(Boolean);
  assert.ok(stoMsgs.some(m => /STO/.test(m.payload.message)), JSON.stringify(stoMsgs));
});

check('EventLogService: journal depth filters what reaches the file, not the UI', () => {
  const logs = [
    { time: '10:00:00', type: 'info', message: 'i1', source: 's' },
    { time: '10:00:01', type: 'warning', message: 'w1', source: 's' },
    { time: '10:00:02', type: 'error', message: 'e1', source: 's' },
  ];
  const lvl = (level) => {
    const s2 = JSON.parse(JSON.stringify(settings)); s2.advanced.journalLevel = level;
    const ctx = makeCtx({ settings: s2, logs: [] });
    const r = runNode('EventLogService', { topic: 'logs_update', payload: { logs } }, ctx);
    const appended = r.out[1] ? String(r.out[1].payload).trim().split('\n') : [];
    return { ui: r.out[0].payload.logs.length, file: appended.length };
  };
  assert.deepEqual(lvl('all'), { ui: 3, file: 3 });
  assert.deepEqual(lvl('warnings'), { ui: 3, file: 2 });
  assert.deepEqual(lvl('errors'), { ui: 3, file: 1 });
});

check('ScenarioManager uses the live drive VH[2] and publishes the step speed limit', () => {
  // low pair VH[2] read from the drive: 3276800 ticks/s = 180 deg/s
  const base = { settings, nc3, current_range: 'high', logs: [], drive_vh2_ticks: { low: 3276800 },
    drive_state: { mo: true, so: true }, drive_init_state: { status: 'done', initialized: true, resolution: 'high' } };
  const ctx = makeCtx(base);
  let r = runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 'a.scn' } }, ctx);
  r = runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n200 10\n' }, ctx);
  assert.equal(ctx.global.get('scenario_state').status, 'error', '200 deg/s is above the drive VH[2] of the low pair');
  const ui = [].concat(r.out[2] || []).find(m => m && m.topic === 'scenario_state');
  assert.ok(ui && Math.abs(ui.payload.speed_limit_deg_per_sec - 180) < 1e-6, JSON.stringify(ui && ui.payload.speed_limit_deg_per_sec));
  const ctx2 = makeCtx(base);
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 'a.scn' } }, ctx2);
  runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n-170 10\n' }, ctx2);
  assert.notEqual(ctx2.global.get('scenario_state').status, 'error', 'reverse speed within VH[2] is valid');
});

check('CommandHandler rejects PA/PR targets outside the int32 drive range', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high' });
  const body = { sp_ticks: 100000, ac_ticks: 100000, dc_ticks: 100000 };
  assert.equal(runNode('CommandHandler', { topic: 'set_absolute_position', payload: Object.assign({ ticks: 2147483648 }, body) }, ctx).out, null);
  assert.equal(runNode('CommandHandler', { topic: 'set_relative_position', payload: Object.assign({ ticks: -2147483648 }, body) }, ctx).out, null);
  const ok = runNode('CommandHandler', { topic: 'set_relative_position', payload: Object.assign({ ticks: -728178 }, body) }, ctx);
  assert.ok(ok.out && ok.out.payload.indexOf('PR=-728178') >= 0, ok.out && ok.out.payload);
});

check('Scenario and manual JV use the absolute TR[3] of the pair from the settings', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', logs: [], drive_state: { mo: true, so: true }, drive_init_state: { status: 'done', initialized: true, resolution: 'high' } });
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 'a.scn' } }, ctx);
  const r = runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n0.5 10\n' }, ctx);
  const cmd = r.out[0][0];
  assert.equal(cmd.topic, 'set_jv');
  assert.equal(cmd.payload.tr3_ticks, undefined, 'no per-step window any more');
  // high pair, TR[3] 0.5 deg/s from the fixture -> 364089 counts/s, also for a 0.5 deg/s step
  const out = runNode('CommandHandler', cmd, makeCtx({ settings, nc3, current_range: 'high' })).out;
  assert.ok(out && out.payload.indexOf('TR[3]=364089;') === 0, out && out.payload);
  const s2 = runNode('SettingsNormalize', { topic: 'settings_aply', payload: { advanced: { scenarioSpeedWindowPercent: 3 } } }, makeCtx({})).out[0].payload;
  assert.equal(s2.advanced.scenarioSpeedWindowPercent, undefined, 'percent setting removed');
});

check('ResponseParser remembers VH[2] of the active pair and persists only on change', () => {
  const ctx = makeCtx({ settings });
  let r = runNode('ResponseParser', { topic: 'poll_state', payload: 'MO;1;SO;1;SR;0;MS;2;OL[1];1;VH[2];3276800;' }, ctx);
  assert.deepEqual(ctx.global.get('drive_vh2_ticks'), { low: 3276800 }, 'attributed to the pair from OL[1] of the same frame');
  const persist = r.sent.filter(m => Array.isArray(m) && m[1] && m[1].topic === 'vh2_persist');
  assert.equal(persist.length, 1);
  assert.deepEqual(persist[0][1].payload.advanced.driveVh2Ticks, { low: 3276800 });
  r = runNode('ResponseParser', { topic: 'poll_state', payload: 'MO;1;SO;1;SR;0;MS;2;OL[1];1;VH[2];3276800;' }, ctx);
  assert.equal(r.sent.filter(m => Array.isArray(m) && m[1]).length, 0, 'same value -> no file write');
  // SettingsPersist writes the file but does not reload the settings form
  const sp = runNode('SettingsPersist', persist[0][1], makeCtx({}));
  assert.ok(sp.out[0] && sp.out[0].filename);
  assert.equal(sp.out[1], null);
});

check('Saved VH[2] survives a restart: SettingsNormalize merges settings.json values with live reads', () => {
  const saved = JSON.parse(JSON.stringify(settings));
  saved.advanced.driveVh2Ticks = { high: 30000000, low: 3276800 };
  const ctx = makeCtx({ settings: saved, drive_vh2_ticks: { high: 31000000 } });
  const s = runNode('SettingsNormalize', { topic: 'settings_aply', payload: { general: {} } }, ctx).out[0].payload;
  assert.deepEqual(s.advanced.driveVh2Ticks, { high: 31000000, low: 3276800 }, 'live value wins, saved one fills the gap');
  assert.deepEqual(ctx.global.get('drive_vh2_ticks'), { high: 31000000, low: 3276800 });
  assert.equal(s.general.speedReadyTolerancePercent, undefined, 'tolerance setting removed');
  assert.equal(s.advanced.speedStableTimeMs, undefined, 'stable-time setting removed');
});

check('Operator-entered VH[2]: active pair written to the drive at once, inactive pair saved for the switch', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', drive_vh2_ticks: { high: 34952530, low: 6553600 } });
  // active (high) pair: 30 deg/s = 21845333 counts/s
  let r = runNode('SettingsNormalize', { topic: 'settings_aply', payload: { advanced: { driveVh2Override: { high: 21845333 } } } }, ctx);
  let s = r.out[0].payload;
  assert.deepEqual(s.advanced.driveVh2Ticks, { high: 21845333, low: 6553600 }, 'entered value wins over the read one');
  assert.equal(s.advanced.driveVh2Override, undefined, 'override is not stored');
  const apply = [].concat(r.out[1] || []).find(m => m.topic === 'apply_vh2');
  assert.ok(apply, 'active pair -> apply_vh2');
  const out = runNode('CommandHandler', apply, makeCtx({ settings, nc3, current_range: 'high', drive_vh2_ticks: ctx.global.get('drive_vh2_ticks') })).out;
  assert.equal(out && out.payload.trim(), 'VH[2]=21845333;VH[2]');
  // the speed limit follows at once
  assert.equal(ctx.global.get('drive_vh2_ticks').high, 21845333);
  // inactive (low) pair: saved only, no drive command; above nominal is capped
  r = runNode('SettingsNormalize', { topic: 'settings_aply', payload: { advanced: { driveVh2Override: { low: 9999999 } } } }, ctx);
  s = r.out[0].payload;
  assert.equal(s.advanced.driveVh2Ticks.low, 6553600, 'capped at the nominal 360 deg/s');
  assert.ok(![].concat(r.out[1] || []).some(m => m && m.topic === 'apply_vh2'));
});

check('JP scenario step: readiness by the TR[3]/TR[4] window on VX (no tolerance setting)', () => {
  const st0 = JSON.parse(JSON.stringify(settings));
  st0.advanced.rotationCommandMode = 'JP';
  const ctx = makeCtx({ settings: st0, nc3, current_range: 'high', logs: [], drive_state: { mo: true, so: true }, drive_init_state: { status: 'done', initialized: true, resolution: 'high' } });
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 'a.scn' } }, ctx);
  let r = runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n10 10\n' }, ctx);
  assert.equal(r.out[0][0].topic, 'set_jp');
  ackScenarioSpeed(ctx, 'set_jp');
  let st = ctx.global.get('scenario_state');
  assert.equal(st.ready_criterion, 'software');
  // 9.3 deg/s: outside TR[3] = 0.5 deg/s -> not ready even with MS=0 (MS is ignored for JP)
  runNode('ScenarioManager', { topic: 'poll_data', payload: { ms: 0, velocity_deg_per_sec: 9.3, resolution: 'high' } }, ctx);
  assert.equal(ctx.global.get('scenario_state').ready, false);
  runNode('ScenarioManager', { topic: 'poll_data', payload: { velocity_deg_per_sec: 10.05, resolution: 'high' } }, ctx);
  st = ctx.global.get('scenario_state'); st.ready_eval.inWindowSince -= 200; ctx.global.set('scenario_state', st);
  runNode('ScenarioManager', { topic: 'poll_data', payload: { velocity_deg_per_sec: 10.02, resolution: 'high' } }, ctx);
  assert.equal(ctx.global.get('scenario_state').status, 'holding');
});

function withNow(t, fn) { const real = Date.now; Date.now = () => t; try { return fn(); } finally { Date.now = real; } }

// ---------------- 2026-10-29: auto tilt journal/UI, brake at every end (D4) ----------------
function autoTiltStart(ctx, target, startAngle) {
  if (startAngle !== undefined) ctx.global.set('bun_angle', startAngle);
  const r = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: target, mode: 'Автоматический' }, ctx);
  const go = r.timers.find(t => t.ms === 300);
  go.fn();
  return r;
}
check('BUN AutoTilt: start and completion go to the journal (RU+EN) and to the UI; brake engaged', () => {
  const ctx = makeCtx({ settings, bun: {}, bun_dev_state: { code: 3, ts: Date.now() } });
  const r = autoTiltStart(ctx, 36000, 0);
  const startSent = r.sent[0];
  assert.equal(startSent[2].payload, 0, 'brake released first');
  assert.equal(startSent[3].payload.type, 'info');
  assert.ok(/тормоз отпущен/.test(startSent[3].payload.message) && /brake released/.test(startSent[3].payload.message_en));
  assert.equal(startSent[4].topic, 'bun_auto_state');
  let last;
  for (let i = 0; i < 3; i++) last = runNode('BUN AutoTilt', { topic: 'bun_angle', payload: 36000 }, ctx, { runTimers: true });
  assert.equal(ctx.flow.get('bun_auto_state').status, 'complete');
  const journal = last.sent.find(m => m[3]);
  assert.ok(journal && /достигнут/.test(journal[3].payload.message) && /reached/.test(journal[3].payload.message_en), JSON.stringify(last.sent));
  assert.equal(journal[4].payload.status, 'complete');
  assert.ok(last.sent.some(m => m[2] && m[2].topic === 'tilt_brake' && m[2].payload === 1), 'brake engaged');
  assert.ok(last.sent.some(m => m[1] && m[1].payload === 'release'), 'BUN drive off after the brake');
});

check('BUN AutoTilt: the BUN state register ends the movement off the tolerance -> "not_reached", brake, warning', () => {
  const ctx = makeCtx({ settings, bun: {}, bun_dev_state: { code: 3, ts: Date.now() } });
  autoTiltStart(ctx, 36000, 0);
  const all = [];
  const feed = (topic, payload) => { const r = runNode('BUN AutoTilt', { topic, payload }, ctx, { runTimers: true }); all.push(...r.sent); if (r.out) all.push(r.out); return r; };
  feed('bun_state', JSON.stringify({ state: 7, gpio: 3128 }));
  [10000, 25000, 35970].forEach(a => { feed('bun_angle', a); feed('bun_state', { state: 7 }); });
  // the BUN stands at 35970 (30″ off) but still reports "moving to the setpoint": the sequence waits
  for (let i = 0; i < 30; i++) { feed('bun_angle', 35970); feed('bun_state', { state: 7 }); }
  assert.equal(ctx.flow.get('bun_auto_state').status, 'moving', 'no timer ends the movement while the BUN is moving to the setpoint');
  assert.ok(!all.some(m => m[2] && m[2].payload === 1), 'no brake while the BUN reports the motion');
  feed('bun_state', { state: 3 });
  assert.equal(ctx.flow.get('bun_auto_state').status, 'moving', 'the decision waits for the angle of the same poll');
  feed('bun_angle', 35971);
  const st = ctx.flow.get('bun_auto_state');
  assert.equal(st.status, 'not_reached');
  const journal = all.filter(m => m[3]).pop();
  assert.equal(journal[3].payload.type, 'warning');
  assert.ok(/уставка не достигнута/.test(journal[3].payload.message) && /«остановлен» \(3\)/.test(journal[3].payload.message), journal[3].payload.message);
  assert.ok(/setpoint not reached/.test(journal[3].payload.message_en) && !CYR.test(journal[3].payload.message_en), journal[3].payload.message_en);
  assert.ok(all.some(m => m[2] && m[2].payload === 1), 'brake engaged');
  const ui = all.filter(m => m[4]).map(m => [].concat(m[4])).flat();
  assert.ok(ui.some(u => u.topic === 'bun_dev_state' && u.payload.code === 3 && u.payload.gpio === undefined), 'the state goes to the Tilt page');
});
check('BUN AutoTilt: GO not executed (state register) / no data -> stop BUN, then brake, error in journal and UI', () => {
  for (const kind of ['no_motion', 'no_data']) {
    const ctx = makeCtx({ settings, bun: {}, bun_dev_state: { code: 3, ts: Date.now() } });
    const r = autoTiltStart(ctx, 36000, 0);
    const before = r.sent.length;
    let after; const runs = [];
    if (kind === 'no_motion') {
      const outs = [];
      for (let i = 0; i < 3; i++) { const x = runNode('BUN AutoTilt', { topic: 'bun_state', payload: { state: 3 } }, ctx); runs.push(x); outs.push(...x.sent); r.timers.push(...x.timers); }
      after = outs;
      const j = after.find(m => m[3]);
      assert.ok(/не выполнил команду GO — состояние «остановлен» \(3\) в 3 опросах/.test(j[3].payload.message), j[3].payload.message);
    } else {
      const st = ctx.flow.get('bun_auto_state');
      st.go_at -= 6000; st.last_sample_at -= 6000;
      ctx.flow.set('bun_auto_state', st);
      r.timers.find(t => t.ms === 1000).fn();
      after = r.sent.slice(before);
    }
    assert.equal(ctx.flow.get('bun_auto_state').status, kind);
    assert.ok(after[0][1] && after[0][1].payload === 'stop', kind + ': BUN stop first');
    const j = after.find(m => m[3]);
    assert.equal(j[3].payload.type, 'error');
    assert.ok(j[3].payload.message_en.length > 0 && !CYR.test(j[3].payload.message_en), j[3].payload.message_en);
    r.timers.filter(t => t.ms === 300).forEach(t => t.fn());
    r.timers.filter(t => t.ms === 300).forEach(t => t.fn());
    const sentAll = r.sent.concat(...runs.map(x => x.sent));
    assert.ok(sentAll.some(m => m[2] && m[2].topic === 'tilt_brake' && m[2].payload === 1), kind + ': brake engaged');
  }
});
check('BUN AutoTilt: operator stop during the sequence engages the brake and journals it', () => {
  const ctx = makeCtx({ settings, bun: {} });
  autoTiltStart(ctx, 36000, 0);
  const r = runNode('BUN AutoTilt', { topic: 'bun_cmd', payload: 'stop' }, ctx, { runTimers: true });
  assert.equal(r.out[1].payload, 'stop');
  assert.equal(r.out[3].payload.type, 'warning');
  assert.equal(r.out[4].payload.status, 'cancelled');
  assert.ok(r.sent.some(m => m[2] && m[2].topic === 'tilt_brake' && m[2].payload === 1), 'brake engaged after stop');
  // jog command cancels the sequence but leaves the brake to the operator
  const ctx2 = makeCtx({ settings, bun: {} });
  autoTiltStart(ctx2, 36000, 0);
  const r2 = runNode('BUN AutoTilt', { topic: 'bun_cmd', payload: 'slowup' }, ctx2, { runTimers: true });
  assert.equal(r2.out[4].payload.status, 'cancelled');
  assert.ok(!r2.sent.some(m => m[2] && m[2].topic === 'tilt_brake'), 'no brake on jog');
});

check('BUN AutoTilt has 5 outputs wired: journal -> ProtocolManager, state -> БУН and Мониторинг', () => {
  const at = byName['BUN AutoTilt'];
  assert.equal(at.outputs, 5);
  const lo = flows.find(n => n.id === at.wires[3][0]);
  assert.ok(lo.type === 'link out' && lo.links.includes('2c89895f1113b5b7'));
  assert.ok(at.wires[4].includes('0c3c6139972245b3'));
  const mon = flows.find(n => at.wires[4].includes(n.id) && n.type === 'link out');
  assert.ok(mon && mon.links.includes('5818e895b4a23928'));
});

// ---------------- 2026-10-29: ELMO link journal and null-mark reset (D3, D9) ----------------
function runInit(name, ctx, nc3Fake, nodeSent) {
  const n = byName[name];
  const timers = [];
  const node = { send: (m) => nodeSent.push(m), log: () => {}, warn: () => {}, error: () => {}, status: () => {}, id: n.id };
  const fn = new Function('node', 'global', 'flow', 'context', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', n.initialize);
  ctx.global.set('nc3', nc3Fake);
  fn(node, ctx.global, ctx.flow, ctx.context, (f, ms) => { timers.push({ fn: f, ms }); return timers.length; }, () => {}, () => 1, () => {});
  return timers;
}
check('ElmoTransport On Start: ELMO.LINK on established, lost and restored link (not on every reconnect try)', () => {
  const ctx = makeCtx({ settings });
  const sent = [];
  let sub = null;
  const fakeActor = { subscribe: (cb) => { sub = cb; }, send: () => {}, stop: () => {} };
  const timers = runInit('ElmoTransport', ctx, { startElmoTransport: () => fakeActor }, sent);
  const snap = (value) => sub({ value, context: { resolution: 'high' } });
  const links = () => sent.filter(m => m[2] && m[2].topic === 'ELMO.LINK').map(m => m[2].payload);
  snap('connecting'); snap('offline');
  assert.equal(links().length, 0, 'no event before the first connection');
  snap({ connected: 'idle' }); snap({ connected: 'sending' });
  assert.deepEqual(links().map(p => [p.online, p.restored]), [[true, false]]);
  snap('offline'); snap('connecting'); snap('offline');
  assert.deepEqual(links().map(p => [p.online, p.restored]), [[true, false], [false, false]]);
  snap('connecting'); snap({ connected: 'idle' });
  assert.deepEqual(links().map(p => [p.online, p.restored]), [[true, false], [false, false], [true, true]]);
  // startup timer: no event because the link was up
  timers.filter(t => t.ms === 10000).forEach(t => t.fn());
  assert.equal(links().length, 3);
  // no link at all within 10 s -> one "initial" offline event
  const sent2 = [];
  const t2 = runInit('ElmoTransport', makeCtx({ settings }), { startElmoTransport: () => ({ subscribe: () => {}, send: () => {}, stop: () => {} }) }, sent2);
  t2.filter(t => t.ms === 10000).forEach(t => t.fn());
  const l2 = sent2.filter(m => m[2] && m[2].topic === 'ELMO.LINK').map(m => m[2].payload);
  assert.equal(l2.length, 1);
  assert.equal(l2[0].initial, true);
});

check('DriveInitState: ELMO link loss journals and resets the null mark; scenario then homes again', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', logs: [{ message: 'Поиск нулевой метки: завершён (high): метка найдена', type: 'info' }],
    drive_init_state: { status: 'done', initialized: true, resolution: 'high', null_mark: 'found' }, drive_state: { mo: true, so: true } });
  let r = runNode('DriveInitState', { topic: 'ELMO.LINK', payload: { online: true, restored: false } }, ctx);
  assert.ok(/установлена/.test(r.out[1].payload.message) && /established/.test(r.out[1].payload.message_en));
  r = runNode('DriveInitState', { topic: 'ELMO.LINK', payload: { online: false } }, ctx);
  assert.equal(r.out[0].payload.status, 'not_done');
  assert.equal(r.out[0].payload.null_mark, 'unknown');
  const msgs = r.out[1].map(m => m.payload.message);
  assert.ok(/Связь с ELMO потеряна/.test(msgs[0]), msgs.join(' | '));
  assert.ok(/требуется после потери связи с ELMO \(high\)/.test(msgs[1]), msgs.join(' | '));
  // the journal now says "required": ScenarioManager must home even with the motor on
  ctx.global.get('logs').push({ message: msgs[1], type: 'warning' });
  ctx.global.set('scenario_files', ['t.scn']);
  ctx.flow.set('motion_params', { sp: 728178, ac: 364088, dc: 364088 });
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 't.scn' } }, ctx);
  runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n2 10\n' }, ctx);
  assert.equal(ctx.global.get('scenario_state').status, 'drive_init_pending');
  // restored link: journal only, the mark stays unknown
  r = runNode('DriveInitState', { topic: 'ELMO.LINK', payload: { online: true, restored: true } }, ctx);
  assert.ok(/восстановлена/.test(r.out[1].payload.message));
  assert.equal(ctx.global.get('drive_init_state').null_mark, 'unknown');
});

check('Journal parsers accept new Russian status words and old English ones', () => {
  for (const [text, status] of [
    ['Поиск нулевой метки: завершён (high): метка найдена', 'done'],
    ['Поиск нулевой метки: completed (high): метка найдена', 'done'],
    ['Поиск нулевой метки: не выполнен (high): x', 'failed'],
    ['Поиск нулевой метки: failed (high): x', 'failed'],
    ['Поиск нулевой метки: требуется после смены пары головок (high)', 'required'],
    ['Поиск нулевой метки: required after resolution switch (high)', 'required'],
  ]) {
    const ctx = makeCtx({ settings, nc3, current_range: 'high', logs: [{ message: text }], drive_state: { mo: true, so: true } });
    const r = runNode('DriveInitState', { topic: 'reread', payload: { resolution: 'high' } }, ctx);
    const st = ctx.global.get('drive_init_state') || { status: 'not_done' };
    const expected = status === 'done' ? 'done' : (status === 'failed' ? 'failed' : 'not_done');
    assert.equal(st.status, expected, text + ' -> ' + JSON.stringify(r && r.out && r.out[0]));
  }
});

check('Journal entries keep the English text: ProtocolManager -> EventLogService', () => {
  const ctx = makeCtx({ settings, logs: [] });
  runNode('ProtocolManager', { topic: 'journal_event', payload: { source: 'tilt', message: 'Привет', message_en: 'Hello', type: 'info' } }, ctx);
  const entry = ctx.global.get('logs').slice(-1)[0];
  assert.equal(entry.message_en, 'Hello');
  const r = runNode('EventLogService', { topic: 'logs_update', payload: { logs: ctx.global.get('logs') } }, ctx);
  assert.ok(/"message_en":"Hello"/.test(r.out[1].payload), r.out[1].payload);
});

// ---------------- 2026-10-29: protocol closed by the server at the scenario end (D14) ----------------
check('ScenarioManager: "close at the end of the scenario" is stored on the server and closes the protocol', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', logs: [], drive_state: { mo: true, so: true },
    drive_init_state: { status: 'done', initialized: true, resolution: 'high' }, protocol_open: true, is_recording: true });
  let r = runNode('ScenarioManager', { topic: 'scenario_auto_close', payload: true }, ctx);
  assert.equal(r.out[2].payload.auto_close_protocol, true);
  ctx.flow.set('motion_params', { sp: 728178, ac: 364088, dc: 364088 });
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 'high_resolution.scn' } }, ctx);
  runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n2 10\n' }, ctx);
  const st = ctx.global.get('scenario_state');
  st.status = 'holding'; st.hold_ends_at = Date.now() - 1; ctx.global.set('scenario_state', st);
  r = runNode('ScenarioManager', { topic: 'poll_data', payload: { velocity_deg_per_sec: 2, resolution: 'high' } }, ctx);
  const topics = r.out[1].map(m => m.topic);
  assert.ok(topics.indexOf('record_measurement') >= 0 && topics.indexOf('close_protocol') > topics.indexOf('record_measurement'), topics.join(','));
  // flag off -> the protocol stays open
  runNode('ScenarioManager', { topic: 'scenario_auto_close', payload: false }, ctx);
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 'high_resolution.scn' } }, ctx);
  runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\n2 10\n' }, ctx);
  const st2 = ctx.global.get('scenario_state');
  st2.status = 'holding'; st2.hold_ends_at = Date.now() - 1; ctx.global.set('scenario_state', st2);
  r = runNode('ScenarioManager', { topic: 'poll_data', payload: { velocity_deg_per_sec: 2, resolution: 'high' } }, ctx);
  assert.ok(!r.out[1].some(m => m.topic === 'close_protocol'));
});

// ---------------- 2026-10-29: English texts of operator messages (D7) ----------------
check('Scenario errors and notices carry English text', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high', logs: [], scenario_files: ['t.scn'] });
  runNode('ScenarioManager', { topic: 'scenario_start', payload: { file: 't.scn' } }, ctx);
  const r = runNode('ScenarioManager', { topic: 'scenario_file_loaded', payload: '-----\nabc 10\n' }, ctx);
  const st = ctx.global.get('scenario_state');
  assert.equal(st.status, 'error');
  assert.ok(st.last_error_en && !CYR.test(st.last_error_en), st.last_error_en);
  assert.ok(st.notice_text_en && !CYR.test(st.notice_text_en), st.notice_text_en);
  const j = r.out[1].find(m => m.topic === 'journal_event');
  assert.ok(j.payload.message_en && !CYR.test(j.payload.message_en), j.payload.message_en);
});

check('Nav i18n: UI-scoped template gets the init snapshot through the "to UI" link', () => {
  const t = flows.find(n => n.id === 'nc3-nav-i18n');
  assert.ok(t && t.type === 'ui-template' && t.templateScope === 'widget:ui');
  const li = flows.find(n => n.id === 'nc3-nav-i18n-in');
  assert.deepEqual(li.wires, [['nc3-nav-i18n']]);
  assert.ok(flows.find(n => n.id === 'defeba9f1c3e6b14').links.includes('nc3-nav-i18n-in'));
  const names = flows.filter(n => n.type === 'ui-page').map(p => p.name);
  for (const name of names) assert.ok(t.format.includes("'" + name + "'"), 'page name in the map: ' + name);
});

check('D12: the unreachable legacy BEP chain and the empty "RC blocked debug out" are gone', () => {
  for (const id of ['3bc1add39936eec4', 'f590eeadf44ae45d', '237e5e4647d42f14']) assert.ok(!flows.find(n => n.id === id), id);
  for (const n of flows) for (const p of (n.wires || [])) for (const t of (p || [])) assert.ok(flows.find(x => x.id === t), 'dangling wire ' + n.id + ' -> ' + t);
});

// ---------------- 2026-11-04: slow BUN, manual tilt journal, setpoint across tabs, BEP motion check ----------------
function fireWatch(run, t) {
  const watch = run.timers.filter(x => x.ms === 1000).pop();
  withNow(t, () => watch.fn());
}
function brakeEngaged(sent) { return sent.some(m => m[2] && m[2].topic === 'tilt_brake' && m[2].payload === 1); }

check('BUN AutoTilt: a slow BUN (0.6 °/s over 101°, stand journal) is not "no motion"; brake only at the end', () => {
  const ctx = makeCtx({ settings, bun: {} });
  const t0 = 1000000, start = Math.round(10.9767 * 3600), target = -90 * 3600;
  const run = withNow(t0, () => autoTiltStart(ctx, target, start));
  let last, t = 0;
  while (ctx.flow.get('bun_auto_state').status === 'moving' && t < 400) {
    t += 1;
    const angle = Math.max(target, start - 2160 * t);
    last = withNow(t0 + t * 1000, () => runNode('BUN AutoTilt', { topic: 'bun_angle', payload: angle }, ctx));
    if (ctx.flow.get('bun_auto_state').status === 'moving') {
      assert.ok(!brakeEngaged(last.sent), 'brake during the motion at t=' + t);
      fireWatch(run, t0 + t * 1000);
    }
  }
  assert.equal(ctx.flow.get('bun_auto_state').status, 'complete');
  assert.ok(t > 160, 'the whole path was travelled, t=' + t);
  assert.ok(!brakeEngaged(run.sent), 'no brake from the watchdog');
  assert.ok(brakeEngaged(last.sent), 'brake engaged at the end');
});

check('BUN AutoTilt: stand case -165.95° → -180°: no timer ends the movement; the watch timer only checks the data', () => {
  const ctx = makeCtx({ settings, bun: {}, bun_dev_state: { code: 3, ts: 2000000 } });
  const t0 = 2000000, target = -180 * 3600, stuck = Math.round(-165.9469 * 3600);
  const run = withNow(t0, () => autoTiltStart(ctx, target, -150 * 3600));
  let t = 0;
  for (; t < 120; t++) {
    withNow(t0 + t * 1000, () => runNode('BUN AutoTilt', { topic: 'bun_angle', payload: t < 10 ? -150 * 3600 - 6000 * t : stuck }, ctx));
    withNow(t0 + t * 1000, () => runNode('BUN AutoTilt', { topic: 'bun_state', payload: { state: 7 } }, ctx));
    fireWatch(run, t0 + t * 1000);
  }
  assert.equal(ctx.flow.get('bun_auto_state').status, 'moving', 'two minutes without motion, the BUN still reports the GO motion (state 7)');
  assert.ok(!brakeEngaged(run.sent), 'no brake');
  assert.ok(!run.sent.some(m => m[1] && m[1].payload === 'stop'), 'no stop');
});

check('BUN state register: a zero pass waits for the BUN to leave the jog after stop, a jog that ends early is "stalled"', () => {
  const ctx = makeCtx({ settings, bun: {}, bun_dev_state: { code: 3, ts: Date.now() } });
  ctx.global.set('bun_angle', 170 * 3600);
  const run = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: -170 * 3600, mode: 'Автоматический' }, ctx);
  run.timers.find(t => t.ms === 300).fn();
  runNode('BUN AutoTilt', { topic: 'bun_state', payload: { state: 13 } }, ctx);
  const r = runNode('BUN AutoTilt', { topic: 'bun_angle', payload: 7 * 3600 }, ctx);
  assert.equal(ctx.flow.get('bun_auto_state').phase, 'zero_pass_stop');
  assert.ok(!r.timers.some(t => t.ms === 1000), 'no pause timer with the state register');
  runNode('BUN AutoTilt', { topic: 'bun_state', payload: { state: 13 } }, ctx);
  assert.equal(ctx.flow.get('bun_auto_state').phase, 'zero_pass_stop', 'still in the jog');
  const go = runNode('BUN AutoTilt', { topic: 'bun_state', payload: { state: 2 } }, ctx);
  assert.deepEqual(go.sent[0][0], { topic: 'bun_cmd_setpoint', payload: -170 * 3600 });
  assert.equal(ctx.flow.get('bun_auto_state').phase, '');
  // a jog that the BUN ends by itself before the zone
  const c2 = makeCtx({ settings, bun: {}, bun_dev_state: { code: 3, ts: Date.now() } });
  c2.global.set('bun_angle', 170 * 3600);
  const r2 = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: -170 * 3600, mode: 'Автоматический' }, c2);
  r2.timers.find(t => t.ms === 300).fn();
  runNode('BUN AutoTilt', { topic: 'bun_state', payload: { state: 13 } }, c2);
  const end = runNode('BUN AutoTilt', { topic: 'bun_state', payload: { state: 3 } }, c2, { runTimers: true });
  assert.equal(c2.flow.get('bun_auto_state').status, 'stalled');
  assert.ok(/«остановлен» \(3\)/.test(c2.flow.get('bun_auto_state').message), c2.flow.get('bun_auto_state').message);
  assert.ok(brakeEngaged(end.sent));
});

check('After an auto tilt fault the operator commands still reach the BUN (Slow Up, Set Zero, Stop)', () => {
  const ctx = makeCtx({ settings, bun: {}, bun_dev_state: { code: 3, ts: Date.now() } });
  ctx.global.set('bun_angle', Math.round(-165.9 * 3600));
  const run = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 180 * 3600, mode: 'Автоматический' }, ctx);
  run.timers.find(t => t.ms === 300).fn();
  for (let i = 0; i < 3; i++) runNode('BUN AutoTilt', { topic: 'bun_state', payload: { state: 3 } }, ctx, { runTimers: true });
  assert.equal(ctx.flow.get('bun_auto_state').status, 'no_motion');
  runNode('BUN AutoTilt', { topic: 'tilt_mode', payload: 'Ручной' }, ctx);
  for (const cmd of ['slowup', 'slowdown', 'zero', 'stop']) {
    const r = runNode('BUN AutoTilt', { topic: 'bun_cmd', payload: cmd }, ctx);
    assert.deepEqual(r.out[1], { topic: 'bun_cmd', payload: cmd }, cmd);
  }
  const sw = flows.find(n => n.id === '481ce8eefd66dde7');
  const mq = flows.find(n => n.id === 'ea3912f1c70c27b0');
  assert.equal(mq.type, 'mqtt out');
  assert.ok(flows.find(n => n.id === '6a4a0b267f9da9d9').wires[1].includes(mq.id), 'AutoTilt output 2 -> MQTT bun_cmd');
  assert.ok(sw.wires[sw.rules.findIndex(r => r.v === 'bun_cmd')].includes('6a4a0b267f9da9d9'));
  const inState = flows.find(n => n.type === 'mqtt in' && n.topic === 'bun_state');
  assert.ok(inState && inState.datatype === 'json' && inState.wires[0].includes('6a4a0b267f9da9d9'), 'bun_state -> AutoTilt');
});
check('Manual tilt: setpoint and result go to the journal; no automatic brake or stop', () => {
  const ctx = makeCtx({ settings, bun: {} });
  ctx.global.set('bun_angle', 0);
  const t0 = 3000000;
  const r = withNow(t0, () => runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 7200, mode: 'Ручной' }, ctx, { runTimers: true }));
  const j = r.sent.find(m => m[3]);
  assert.equal(j[3].topic, 'journal_event');
  assert.equal(j[3].payload.source, 'tilt');
  assert.ok(/Ручной наклон: уставка 2\.0000°/.test(j[3].payload.message), j[3].payload.message);
  assert.ok(/Manual tilt: setpoint 2\.0000°/.test(j[3].payload.message_en));
  // an unknown angle is shown as unknown, not as 0°
  const noAngle = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 7200, mode: 'Ручной' }, makeCtx({ settings, bun: {} }));
  assert.ok(/текущий угол —°/.test(noAngle.sent.find(m => m[3])[3].payload.message));
  assert.ok(r.sent.some(m => m[1] && m[1].payload === 'go'), 'GO after the setpoint');
  assert.ok(!r.sent.some(m => m[2]), 'no brake command');
  const all = [];
  [1800, 3600, 5400, 7198, 7199, 7200, 7199, 7200, 7199, 7200, 7199, 7200].forEach((a, i) => {
    const x = withNow(t0 + (i + 1) * 1000, () => runNode('BUN AutoTilt', { topic: 'bun_angle', payload: a }, ctx));
    if (x.out) all.push(x.out);
    all.push(...x.sent);
  });
  const st = ctx.flow.get('bun_auto_state');
  assert.equal(st.status, 'manual_done');
  const done = all.filter(m => m[3]);
  assert.equal(done.length, 1, 'one result entry');
  assert.ok(/остановился на (1\.9997|2\.0000)°/.test(done[0][3].payload.message), done[0][3].payload.message);
  assert.equal(done[0][3].payload.type, 'info');
  assert.ok(!all.some(m => m[2] || (m[1] && m[1].payload === 'stop')), 'operator keeps the control');
});

check('Manual tilt: jog commands, brake and mode changes go to the journal; no motion is a warning', () => {
  const ctx = makeCtx({ settings, bun: {} });
  ctx.global.set('bun_angle', 3600);
  const t0 = 4000000;
  let r = withNow(t0, () => runNode('BUN AutoTilt', { topic: 'bun_cmd', payload: 'slowup' }, ctx));
  assert.equal(r.out[1].payload, 'slowup');
  assert.ok(/«Больше»/.test(r.out[3].payload.message) && /Slow Up/.test(r.out[3].payload.message_en));
  assert.equal(ctx.flow.get('bun_auto_state').status, 'manual_jog');
  r = withNow(t0 + 16000, () => runNode('BUN AutoTilt', { topic: 'bun_angle', payload: 3600 }, ctx));
  assert.equal(r.out[3].payload.type, 'warning');
  assert.ok(/не начал движение/.test(r.out[3].payload.message) && /тормоз/.test(r.out[3].payload.message));
  for (const cmd of ['stop', 'release', 'zero']) {
    r = runNode('BUN AutoTilt', { topic: 'bun_cmd', payload: cmd }, ctx);
    assert.equal(r.out[1].payload, cmd);
    assert.ok(r.out[3] && !CYR.test(r.out[3].payload.message_en), cmd);
  }
  r = runNode('BUN AutoTilt', { topic: 'tilt_brake', payload: 0 }, ctx);
  assert.deepEqual([r.out[0], r.out[1], r.out[2]], [null, null, null], 'the journal only: Tilt gets the command itself');
  assert.ok(/отпущен оператором/.test(r.out[3].payload.message));
  r = runNode('BUN AutoTilt', { topic: 'tilt_brake', payload: 1 }, ctx);
  assert.ok(/зажат оператором/.test(r.out[3].payload.message));
  r = runNode('BUN AutoTilt', { topic: 'tilt_mode', payload: 'Автоматический' }, ctx);
  assert.ok(/автоматический/.test(r.out[3].payload.message) && /automatic/.test(r.out[3].payload.message_en));
  assert.equal(runNode('BUN AutoTilt', { topic: 'tilt_mode', payload: 'Автоматический' }, ctx).out, null, 'same mode: no entry');
  const sw = flows.find(n => n.id === '481ce8eefd66dde7');
  const idx = v => sw.rules.findIndex(x => x.v === v);
  assert.ok(sw.wires[idx('tilt_brake')].includes('4550c6a1aee78822') && sw.wires[idx('tilt_brake')].includes(byName['BUN AutoTilt'].id));
  assert.deepEqual(sw.wires[idx('tilt_target')], [byName['BUN AutoTilt'].id]);
  assert.equal(sw.outputs, sw.rules.length);
});

check('Tilt setpoint and mode survive a tab change: stored in Node-RED and sent with both init paths', () => {
  const ctx = makeCtx({ settings, bun: {} });
  runNode('BUN AutoTilt', { topic: 'tilt_target', payload: 1234.4 }, ctx);
  assert.equal(ctx.global.get('bun_target_seconds'), 1234);
  runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: -324000, mode: 'Автоматический' }, ctx);
  assert.equal(ctx.global.get('bun_target_seconds'), -324000);
  assert.equal(ctx.global.get('bun').mode, 'Автоматический');
  const change = flows.find(n => n.id === '4edb9a18ba25ec61');
  for (const key of ['bun_target_seconds', 'bun_auto_state', 'mode']) assert.ok(change.rules.some(x => x.p === key), key);
  const gsr = byName.GlobalStateReader.func;
  assert.ok(gsr.includes('bun_target_seconds:') && gsr.includes('bun_mode:'));
  const page = flows.find(n => n.id === '0c3c6139972245b3').format;
  assert.ok(page.includes('d.bun_target_seconds') && page.includes('Object.is(d, -0)'));
  const mon = flows.find(n => n.id === 'cd1902e1e473a48c').format;
  assert.ok(mon.includes('d.bun_target_seconds') && mon.includes("topic: 'tilt_target'"));
});

// ---------------- 2026-11-11: BUN ±180°, tilt correction by "BEP calibration", speed lag, English protocols ----------------
const TPD = 262144000 / 360;
function sentFlat(r) { return [].concat(r.sent || [], r.out ? [r.out] : []); }
function autoState(ctx) { return ctx.flow.get('bun_auto_state'); }

check('BUN AutoTilt: a short path across the ±180° stop goes through 0 by jog, then stop, setpoint and GO', () => {
  const ctx = makeCtx({ settings, bun: {} });
  const t0 = 2000000, start = 170 * 3600, target = -170 * 3600;
  ctx.global.set('bun_angle', start);
  const run = withNow(t0, () => runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: target, mode: 'Автоматический' }, ctx));
  const first = run.sent[0];
  assert.equal(first[0], null, 'no setpoint before the pass through 0');
  assert.deepEqual(first[2], { topic: 'tilt_brake', payload: 0 });
  assert.ok(/упор ±180°/.test(first[3].payload.message) && /«Меньше»/.test(first[3].payload.message), first[3].payload.message);
  assert.ok(/±180° stop/.test(first[3].payload.message_en) && !CYR.test(first[3].payload.message_en), first[3].payload.message_en);
  assert.equal(autoState(ctx).phase, 'zero_pass');
  withNow(t0 + 300, () => run.timers.find(t => t.ms === 300).fn());
  assert.deepEqual(run.sent[1][1], { topic: 'bun_cmd', payload: 'slowdown' });
  let angle = start, t = t0 + 300, res = null, stopAt = null;
  for (let i = 0; i < 400; i++) {
    t += 1000; angle -= Math.round(0.6 * 3600);
    res = withNow(t, () => runNode('BUN AutoTilt', { topic: 'bun_angle', payload: angle }, ctx));
    if (autoState(ctx).phase === 'zero_pass_stop') { stopAt = angle; break; }
  }
  assert.ok(stopAt !== null, 'the pass ends');
  // |−170° − a| ≤ 180° − 2° → a ≤ 8°: the BUN is stopped as soon as the short path goes through 0.
  assert.ok(stopAt / 3600 <= 8 && stopAt / 3600 > 7, 'stopped at ' + stopAt / 3600);
  const stopMsg = res.sent.find(m => m[1]);
  assert.deepEqual(stopMsg[1], { topic: 'bun_cmd', payload: 'stop' });
  withNow(t + 1000, () => res.timers.find(x => x.ms === 1000).fn());
  const goStart = res.sent[res.sent.length - 1];
  assert.deepEqual(goStart[0], { topic: 'bun_cmd_setpoint', payload: target });
  assert.equal(goStart[2], null, 'the brake stays released after the pass');
  assert.ok(/проход через 0 выполнен/.test(goStart[3].payload.message), goStart[3].payload.message);
  withNow(t + 1300, () => res.timers.filter(x => x.ms === 300).pop().fn());
  assert.deepEqual(res.sent[res.sent.length - 1][1], { topic: 'bun_cmd', payload: 'go' });
  let last;
  for (let i = 0; i < 3; i++) last = withNow(t + 2000 + i * 1000, () => runNode('BUN AutoTilt', { topic: 'bun_angle', payload: target }, ctx, { runTimers: true }));
  assert.equal(autoState(ctx).status, 'complete');
  assert.ok(brakeEngaged(last.sent), 'brake engaged at the end');
});

check('BUN AutoTilt: a jog that moves away from the setpoint stops the pass: stop, brake, error (RU+EN)', () => {
  const ctx = makeCtx({ settings, bun: {} });
  const t0 = 3000000, start = 170 * 3600, target = -170 * 3600;
  ctx.global.set('bun_angle', start);
  const run = withNow(t0, () => runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: target, mode: 'Автоматический' }, ctx));
  withNow(t0 + 300, () => run.timers.find(t => t.ms === 300).fn());
  let r;
  for (let i = 1; i <= 3 && autoState(ctx).status === 'moving'; i++) {
    r = withNow(t0 + 300 + i * 1000, () => runNode('BUN AutoTilt', { topic: 'bun_angle', payload: start + i * Math.round(0.6 * 3600) }, ctx, { runTimers: true }));
  }
  const st = autoState(ctx);
  assert.equal(st.status, 'wrong_direction');
  assert.ok(/не в ту сторону/.test(st.message) && /tiltJogUpIncreases/.test(st.message), st.message);
  assert.ok(!CYR.test(st.message_en), st.message_en);
  assert.ok(r.sent.some(m => m[1] && m[1].payload === 'stop'), 'BUN stopped');
  assert.ok(brakeEngaged(r.sent), 'brake engaged');
});

check('Manual tilt: the pass through 0 also runs in the manual mode (no brake); an operator command cancels it', () => {
  const ctx = makeCtx({ settings, bun: {} });
  const t0 = 4000000, start = -175 * 3600, target = 175 * 3600;
  ctx.global.set('bun_angle', start);
  const run = withNow(t0, () => runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: target, mode: 'Ручной' }, ctx));
  const first = run.sent[0];
  assert.equal(first[0], null);
  assert.equal(first[2], null, 'the operator controls the brake');
  assert.ok(/Ручной наклон/.test(first[3].payload.message) && /«Больше»/.test(first[3].payload.message), first[3].payload.message);
  assert.equal(autoState(ctx).status, 'manual_go');
  assert.equal(autoState(ctx).phase, 'zero_pass');
  const cancel = runNode('BUN AutoTilt', { topic: 'bun_cmd', payload: 'stop' }, ctx);
  assert.deepEqual(cancel.out[1], { topic: 'bun_cmd', payload: 'stop' });
  assert.ok(/проход через 0 прерван/.test(cancel.out[3].payload.message), cancel.out[3].payload.message);
  assert.equal(autoState(ctx).status, 'manual_done');
  const before = run.sent.length;
  run.timers.find(t => t.ms === 300).fn();
  assert.equal(run.sent.length, before, 'the jog is not sent after the cancel');
});

check('BUN AutoTilt: a short path needs no pass; a setpoint outside ±180° is not sent', () => {
  const ctx = makeCtx({ settings, bun: {} });
  ctx.global.set('bun_angle', 100 * 3600);
  let r = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 80 * 3600, mode: 'Автоматический' }, ctx);
  assert.deepEqual(r.sent[0][0], { topic: 'bun_cmd_setpoint', payload: 80 * 3600 });
  assert.equal(autoState(ctx).phase, '');
  const ctx2 = makeCtx({ settings, bun: {} });
  ctx2.global.set('bun_angle', 0);
  r = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 181 * 3600, mode: 'Автоматический' }, ctx2);
  assert.equal(r.sent.length, 0);
  assert.ok(r.out && /вне диапазона ±180°/.test(r.out[3].payload.message), JSON.stringify(r.out));
  const ctx3 = makeCtx({ settings, bun: {} });
  ctx3.global.set('bun_angle', 90 * 3600);
  runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: -89 * 3600, mode: 'Автоматический' }, ctx3);
  assert.equal(autoState(ctx3).phase, 'zero_pass', '179° apart: the short path may cross ±180°');
});

const BEP_K = [0.167, 0.184, 0.186, 0.2, 0.017];
function corrSettings(tc) {
  const s = JSON.parse(JSON.stringify(settings));
  s.advanced.BEPcoeffs = BEP_K.slice();
  s.advanced.bepBaseMm = 112;
  if (tc) s.advanced.tiltCorr = tc;
  return s;
}
const CORR = { k: 2, apply: true, base: { xUp: 1, xLow: -1, at: '2026-11-11T08:00:00.000Z', phiSec: 0 },
  meas: { xUp: 3, xLow: -2, at: '2026-11-11T09:00:00.000Z', phiSec: 36000 } };
// ((3 − 1) − (−2 − (−1))) / 112000 · 206264.81 · 2 = 11.05″
const CORR_ARCSEC = 3 / 112000 * 206264.81 * 2;

check('Tilt correction: Δφ is added to the SET angle when the box is on and the setpoint is near φ', () => {
  const ctx = makeCtx({ settings: corrSettings(CORR), bun: {} });
  ctx.global.set('bun_angle', 0);
  let r = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 36000, mode: 'Автоматический' }, ctx);
  assert.deepEqual(r.sent[0][0], { topic: 'bun_cmd_setpoint', payload: 36000 + Math.round(CORR_ARCSEC) });
  assert.ok(/поправка Δφ \+11″/.test(r.sent[0][3].payload.message), r.sent[0][3].payload.message);
  assert.ok(/correction Δφ \+11″/.test(r.sent[0][3].payload.message_en));
  assert.equal(autoState(ctx).operator_target_seconds, 36000);
  assert.equal(autoState(ctx).correction_arcsec, 11);
  assert.equal(ctx.global.get('bun_target_seconds'), 36000, 'the tabs restore the operator setpoint');
  ctx.global.set('bun_auto_state', autoState(ctx));
  const cal = runNode('BUN Calibration', { topic: 'bun_angle', payload: 1234 }, ctx).out;
  assert.equal(cal.payload, 1234, 'the measured angle is shown without the correction');
  assert.equal(cal.raw_angle, 1234);
  assert.ok(Math.abs(cal.tilt_correction.arcsec - Math.round(CORR_ARCSEC * 10) / 10) < 1e-9, JSON.stringify(cal.tilt_correction));
  assert.equal(cal.tilt_correction.appliedToSetpointArcsec, 11);
  // far from φ: not applied, warning
  const ctx2 = makeCtx({ settings: corrSettings(CORR), bun: {} });
  ctx2.global.set('bun_angle', 0);
  r = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 72000, mode: 'Автоматический' }, ctx2);
  assert.deepEqual(r.sent[0][0], { topic: 'bun_cmd_setpoint', payload: 72000 });
  assert.equal(r.sent[0][3].payload.type, 'warning');
  assert.ok(/не применена: определена при 10\.0000°/.test(r.sent[0][3].payload.message), r.sent[0][3].payload.message);
  // box off: plain setpoint, no note
  const ctx3 = makeCtx({ settings: corrSettings(Object.assign({}, CORR, { apply: false })), bun: {} });
  ctx3.global.set('bun_angle', 0);
  r = runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 36000, mode: 'Ручной' }, ctx3);
  assert.deepEqual(r.sent[0][0], { topic: 'bun_cmd_setpoint', payload: 36000 });
  assert.ok(!/поправк/.test(r.sent[0][3].payload.message), r.sent[0][3].payload.message);
});

function tcCtx(extra) {
  return makeCtx(Object.assign({ settings: corrSettings(), current_range: 'high', drive_limits: { ticks_per_deg: TPD },
    drive_state: { mo: 1, so: 1, ms: 0, position: 0, velocity_deg_per_sec: 0 }, scenario_state: { status: 'idle' },
    null_mark_state: { status: 'found' }, drive_init_state: { status: 'done', initialized: true }, bun_angle: 0 }, extra || {}));
}
function feedTc(ctx, t, codes) {
  withNow(t, () => codes.forEach((v, i) => runNode('BEP TiltCorrection', { topic: 'Channel ' + (i + 1), payload: String(v) }, ctx)));
}
function tickTc(ctx, t) {
  const iv = ctx.intervals.filter(x => x.active).pop();
  if (!iv) return [];
  const before = iv.sent.length;
  withNow(t, () => iv.fn());
  return iv.sent.slice(before);
}
function sample30s(ctx, t0, codes) {
  for (let ms = 0; ms < 30000; ms += 500) feedTc(ctx, t0 + ms, codes);
  return tickTc(ctx, t0 + 30000);
}

check('BEP TiltCorrection: refusals — confirmation, null mark, vertical axis, calibration first, fresh data; English text', () => {
  const ctx = tcCtx({ null_mark_state: { status: 'unknown' }, drive_init_state: { status: 'not_done' } });
  const state = () => ctx.context.get('state');
  runNode('BEP TiltCorrection', { topic: 'bep_tc_start', payload: { kind: 'calibrate' } }, ctx);
  assert.ok(/не подтверждено/.test(state().message));
  feedTc(ctx, 1000, [4000, 4000, 4000, 4000, 4100]);
  let r = withNow(1500, () => runNode('BEP TiltCorrection', { topic: 'bep_tc_start', payload: { kind: 'calibrate', confirmed: true } }, ctx));
  assert.ok(/поиск нулевой метки/.test(state().message), state().message);
  const jr = r.sent.map(m => m[3]).filter(Boolean).pop();
  assert.ok(jr.payload.message_en && !CYR.test(jr.payload.message_en), jr.payload.message_en);
  ctx.global.set('null_mark_state', { status: 'found' });
  ctx.global.set('bun_angle', 3600);
  r = withNow(1500, () => runNode('BEP TiltCorrection', { topic: 'bep_tc_start', payload: { kind: 'calibrate', confirmed: true } }, ctx));
  assert.ok(/не вертикальна \(угол 1\.0000°\)/.test(state().message), state().message);
  const en = r.sent[0][0].payload.message_en;
  assert.ok(/not vertical \(angle 1\.0000°\)/.test(en) && !CYR.test(en), en);
  assert.ok(!CYR.test(r.sent[0][3].payload.message_en), r.sent[0][3].payload.message_en);
  withNow(1500, () => runNode('BEP TiltCorrection', { topic: 'bep_tc_start', payload: { kind: 'measure', confirmed: true } }, ctx));
  assert.ok(/нет калибровки/.test(state().message), state().message);
  ctx.global.set('bun_angle', 0);
  withNow(9000, () => runNode('BEP TiltCorrection', { topic: 'bep_tc_start', payload: { kind: 'calibrate', confirmed: true } }, ctx));
  assert.ok(/нет данных датчика 1/.test(state().message), 'stale BEP data must block the start: ' + state().message);
  ctx.global.set('drive_state', { mo: 1, so: 1, ms: 2, position: 0, velocity_deg_per_sec: 3 });
  feedTc(ctx, 9000, [4000, 4000, 4000, 4000, 4100]);
  withNow(9100, () => runNode('BEP TiltCorrection', { topic: 'bep_tc_start', payload: { kind: 'calibrate', confirmed: true } }, ctx));
  assert.ok(/ось вращается/.test(state().message), state().message);
});

check('BEP TiltCorrection: calibration turns the axis to 0 the short way, averages 30 s, persists Xup(0)/Xlow(0)', () => {
  // the axis stands at 350° → turn +10°
  const ctx = tcCtx({ drive_state: { mo: 1, so: 1, ms: 0, position: Math.round(350 * TPD), velocity_deg_per_sec: 0 } });
  const t0 = 100000;
  feedTc(ctx, t0 - 100, [4000, 4010, 4020, 3980, 4100]);
  const r = withNow(t0, () => runNode('BEP TiltCorrection', { topic: 'bep_tc_start', payload: { kind: 'calibrate', confirmed: true } }, ctx));
  assert.equal(r.out[0].payload.status, 'running');
  assert.equal(r.out[0].payload.phase, 'positioning');
  assert.deepEqual(r.out[1], { topic: 'set_relative_position', payload: { ticks: Math.round(10 * TPD), sp_ticks: Math.round(2.5 * TPD), ac_ticks: Math.round(TPD), dc_ticks: Math.round(TPD) } });
  ctx.global.set('drive_state', { mo: 1, so: 1, ms: 2, position: Math.round(355 * TPD), velocity_deg_per_sec: 2.5 });
  tickTc(ctx, t0 + 2000);
  ctx.global.set('drive_state', { mo: 1, so: 1, ms: 0, position: Math.round(360 * TPD), velocity_deg_per_sec: 0 });
  tickTc(ctx, t0 + 6000);
  assert.equal(ctx.context.get('state').phase, 'sampling');
  const done = sample30s(ctx, t0 + 6000, [4000, 4010, 4020, 3980, 4100]);
  const st = done.find(m => m[0]) [0].payload;
  assert.equal(st.status, 'done', st.message);
  const x = [4000 * BEP_K[0], 4010 * BEP_K[1], 4020 * BEP_K[2], 3980 * BEP_K[3]];
  const base = ctx.global.get('settings').advanced.tiltCorr.base;
  assert.ok(Math.abs(base.xUp - (x[0] - x[1]) / 2) < 0.002, 'Xup(0) ' + base.xUp);
  assert.ok(Math.abs(base.xLow - (x[2] - x[3]) / 2) < 0.002, 'Xlow(0) ' + base.xLow);
  assert.ok(base.samples.every(n => n >= 59), JSON.stringify(base.samples));
  const persist = done.find(m => m[2]);
  assert.equal(persist[2].topic, 'bep_tc_persist');
  assert.equal(persist[2].payload.advanced.tiltCorr.base.xUp, base.xUp);
  const jr = done.find(m => m[3])[3].payload;
  assert.ok(/Калибровка поправки к углу наклона: выполнена/.test(jr.message) && !CYR.test(jr.message_en), jr.message_en);
  assert.equal(ctx.global.get('bep_motion_busy'), null);
});

check('BEP TiltCorrection: measurement gives Δφ = ((ΔXup) − (ΔXlow)) / L · K; K and the box are saved', () => {
  const ctx = tcCtx();
  ctx.global.set('settings', corrSettings({ k: 1, apply: false, base: { xUp: 1, xLow: -1, at: 'x', phiSec: 0 }, meas: null }));
  ctx.global.set('bun_angle', 36000);
  const t0 = 200000;
  // X1−X2 = 2·3 → Xup = 3; X3−X4 = 2·(−2) → Xlow = −2 (k = 1 for these channels)
  ctx.global.get('settings').advanced.BEPcoeffs = [1, 1, 1, 1, 0.017];
  feedTc(ctx, t0 - 100, [106, 100, 96, 100, 4100]);
  const r = withNow(t0, () => runNode('BEP TiltCorrection', { topic: 'bep_tc_start', payload: { kind: 'measure', confirmed: true } }, ctx));
  assert.equal(r.out, null, 'the axis is at 0: sampling starts at once');
  assert.equal(ctx.context.get('state').phase, 'sampling');
  const done = sample30s(ctx, t0, [106, 100, 96, 100, 4100]);
  const st = done.find(m => m[0])[0].payload;
  assert.equal(st.status, 'done', st.message);
  const dphi1 = 3 / 112000 * 206264.81;
  assert.ok(Math.abs(st.corr.dphiArcsec - Math.round(dphi1 * 10) / 10) < 1e-9, 'Δφ ' + st.corr.dphiArcsec);
  assert.equal(st.corr.meas.phiSec, 36000);
  let s = runNode('BEP TiltCorrection', { topic: 'bep_tc_set', payload: { k: 2 } }, ctx).out;
  assert.equal(s[2].topic, 'bep_tc_persist');
  assert.equal(s[2].payload.advanced.tiltCorr.k, 2);
  assert.ok(Math.abs(s[0].payload.corr.dphiArcsec - Math.round(dphi1 * 2 * 10) / 10) < 1e-9);
  assert.ok(/масштабный коэффициент K = 2/.test(s[3].payload.message) && /scale factor K = 2/.test(s[3].payload.message_en));
  s = runNode('BEP TiltCorrection', { topic: 'bep_tc_set', payload: { apply: true } }, ctx).out;
  assert.equal(ctx.global.get('settings').advanced.tiltCorr.apply, true);
  assert.ok(/включено/.test(s[3].payload.message));
  s = runNode('BEP TiltCorrection', { topic: 'bep_tc_set', payload: { apply: true } }, ctx).out;
  assert.equal(s[2], null, 'no change - no write');
  // a new calibration clears the measurement made against the old zero
  ctx.global.set('bun_angle', 0);
  feedTc(ctx, 300000 - 100, [100, 100, 100, 100, 4100]);
  withNow(300000, () => runNode('BEP TiltCorrection', { topic: 'bep_tc_start', payload: { kind: 'calibrate', confirmed: true } }, ctx));
  sample30s(ctx, 300000, [100, 100, 100, 100, 4100]);
  assert.equal(ctx.global.get('settings').advanced.tiltCorr.meas, null);
  assert.equal(ctx.global.get('settings').advanced.tiltCorr.k, 2, 'K survives the calibration');
});

check('BEP TiltCorrection: axis motion while sampling is an error; abort while turning stops the drive', () => {
  const ctx = tcCtx();
  feedTc(ctx, 99900, [100, 100, 100, 100, 4100]);
  withNow(100000, () => runNode('BEP TiltCorrection', { topic: 'bep_tc_start', payload: { kind: 'calibrate', confirmed: true } }, ctx));
  ctx.global.set('drive_state', { mo: 1, so: 1, ms: 2, position: 0, velocity_deg_per_sec: 1 });
  const sent = tickTc(ctx, 101000);
  assert.equal(ctx.context.get('state').status, 'error');
  assert.ok(/сдвинулась/.test(ctx.context.get('state').message));
  assert.ok(sent.some(m => m[3] && m[3].payload.type === 'error'));
  const c2 = tcCtx({ drive_state: { mo: 1, so: 1, ms: 0, position: Math.round(90 * TPD), velocity_deg_per_sec: 0 } });
  feedTc(c2, 99900, [100, 100, 100, 100, 4100]);
  const r = withNow(100000, () => runNode('BEP TiltCorrection', { topic: 'bep_tc_start', payload: { kind: 'calibrate', confirmed: true } }, c2));
  assert.equal(r.out[1].payload.ticks, -Math.round(90 * TPD), '90° → turn −90°');
  const ab = runNode('BEP TiltCorrection', { topic: 'bep_tc_abort', payload: true }, c2);
  assert.equal(ab.sent[0][1].topic, 'drive_stop');
  assert.equal(c2.context.get('state').status, 'aborted');
});

check('BEP Gap: X = k·K in µm and the live Xup/Xlow; stale bep_status clears values', () => {
  const ctx = makeCtx({ settings: corrSettings() });
  const raw = [3990, 4010, 4020, 3980, 4050];
  let r;
  raw.forEach((v, i) => { r = runNode('BEP Gap', { topic: 'Channel ' + (i + 1), payload: String(v) }, ctx); });
  const p = r.out.payload;
  const x = raw.map((v, i) => BEP_K[i] * v);
  p.scaledUm.forEach((g, i) => assert.ok(Math.abs(g - x[i]) < 1e-9, 'X' + i + ': ' + g));
  assert.ok(Math.abs(p.xUpUm - (x[0] - x[1]) / 2) < 1e-9);
  assert.ok(Math.abs(p.xLowUm - (x[2] - x[3]) / 2) < 1e-9);
  assert.equal('tiltCorrArcsec' in p, false, 'no instantaneous Δφ any more');
  r = runNode('BEP Gap', { topic: 'bep_status', payload: JSON.stringify({ running: true, stale: true }) }, ctx);
  assert.equal(r.out.payload.raw[0], null);
  assert.equal(r.out.payload.xUpUm, null);
});

check('SettingsNormalize: old correction keys removed; tiltCorr kept against a stale Settings form; poll defaults', () => {
  const tc = { k: 1.5, apply: true, base: { xUp: 1, xLow: 2, means: [1, 2, 3, 4], samples: [60, 60, 60, 60], at: 'a', phiSec: 0 },
    meas: { xUp: 3, xLow: 4, means: [1, 2, 3, 4], samples: [60, 60, 60, 60], at: 'b', phiSec: 36000 } };
  const ctx = makeCtx({ settings: { general: { angleCorrectionMode: 'circlogram', angleCorrectionEnabled: true },
    advanced: { BEPcoeffs: [0, 0, 0, 0, 0], tiltCorr: tc, circlogram: { n: 36 }, circlogramInitial: {}, bepZero: { codes: [1] } } } });
  const s = runNode('SettingsNormalize', { topic: 'settings_aply', payload: { advanced: { BEPcoeffs: [0, 0, 0, 0, 0], tiltCorr: { k: 9, apply: false, base: null, meas: null } } } }, ctx).out[0].payload;
  assert.deepEqual(s.advanced.BEPcoeffs, BEP_K);
  assert.deepEqual(s.advanced.tiltCorr, tc, 'the BEP tab owns tiltCorr');
  ['circlogram', 'circlogramInitial', 'circlogramCurrent', 'bepZero'].forEach(k => assert.equal(k in s.advanced, false, k));
  assert.equal('angleCorrectionMode' in s.general, false);
  assert.equal('angleCorrectionEnabled' in s.general, false);
  assert.equal(s.advanced.normalPollHz, 5);
  assert.equal(s.advanced.velocityWindowMs, 1000);
  const ctx2 = makeCtx({});
  const s2 = runNode('SettingsNormalize', { topic: 'settings_aply', payload: { advanced: { tiltCorr: { k: 'x', base: { xUp: 1, xLow: null }, meas: { xUp: 1, xLow: 1 } } } } }, ctx2).out[0].payload;
  assert.deepEqual(s2.advanced.tiltCorr, { k: 1, apply: false, base: null, meas: null }, 'a broken calibration is dropped with its measurement');
});

check('Speed display: velocity over a 1 s TM/PX window (was 3 s), normal ELMO poll 5 Hz', () => {
  const ctx = makeCtx({ settings });
  // 10 °/s for 3 s, then 20 °/s for 1.2 s, samples every 200 ms
  let px = 0, p;
  for (let i = 0; i <= 21; i++) {
    const tm = i * 200000;
    if (i > 0) px += Math.round((i <= 15 ? 10 : 20) * 0.2 * TPD);
    p = parse(ctx, 'TM;' + tm + ';PX;' + px + ';VX;0;').payload;
  }
  assert.equal(p.velocity_source, 'tm_px_buffer');
  assert.ok(Math.abs(p.velocity_deg_per_sec - 20) < 0.01, 'the last second only: ' + p.velocity_deg_per_sec);
  const slow = JSON.parse(JSON.stringify(settings)); slow.advanced.velocityWindowMs = 3000;
  const ctx2 = makeCtx({ settings: slow });
  px = 0;
  for (let i = 0; i <= 21; i++) {
    if (i > 0) px += Math.round((i <= 15 ? 10 : 20) * 0.2 * TPD);
    p = parse(ctx2, 'TM;' + (i * 200000) + ';PX;' + px + ';VX;0;').payload;
  }
  assert.ok(p.velocity_deg_per_sec < 15, 'the old 3 s window lags: ' + p.velocity_deg_per_sec);
  const tr = flows.find(n => n.id === 'elmoxs-transport');
  for (const code of [tr.func, tr.initialize]) assert.ok(/normalPollHz: clamp\(finiteNumber\(advanced\.normalPollHz, 5\), 1, 10\)/.test(code));
});

check('ProtocolManager: a new protocol file is in English with the BUN angle and the tilt correction', () => {
  const s2 = JSON.parse(JSON.stringify(settings)); s2.general.angleSavingMode = 'header';
  const ctx = makeCtx({ settings: s2, current_range: 'high', bun_angle: 36011,
    tilt_correction: { apply: true, arcsec: 11.1, k: 2, appliedToSetpointArcsec: 11 } });
  const r = runNode('ProtocolManager', { topic: 'open_protocol', payload: {} }, ctx);
  const text = String(r.out[0].payload);
  assert.ok(!CYR.test(text), text);
  assert.ok(/^# Protocol file ID \d{8}_\d{6}$/m.test(text), text);
  assert.ok(/^Rotation_axis_tilt_angle\s+10\.003056 # degree, BUN angle$/m.test(text), text);
  assert.ok(/^Tilt_angle_correction\s+11 # arcsec, added to the tilt setpoint, measured dphi 11\.1 arcsec, K 2$/m.test(text), text);
  assert.ok(/^Speed_value Error Data_file # degree\/s %$/m.test(text), text);
  assert.ok(/^Date\s+\d{4}-\d{2}-\d{2}$/m.test(text) && /^Time\s+\d{2}:\d{2}:\d{2}$/m.test(text), text);
});

check('Protocols opens legacy and current data files, plots both units and returns to the protocol', () => {
  const src = flows.find(n => n.id === 'prot-tmpl-nc3-0001').format.match(/<script>([\s\S]*?)<\/script>/)[1];
  const component = new Function(src.replace('export default', 'return'))();
  const view = Object.assign(component.data(), component.methods, { $nextTick: cb => cb() });
  for (const [name, get] of Object.entries(component.computed)) Object.defineProperty(view, name, { get });
  const ctx = makeCtx({});
  const protocol = 'C:\\NC3\\protocols\\test.txt';
  function open(rows, file, kind) {
    const msg = { topic: 'journal_open_file', payload: { filename: file, selectedProtocol: protocol, kind } };
    const read = runNode('ProtocolManager', msg, ctx).out[4];
    const state = runNode('ProtocolManager', { ...read, payload: rows.join('\n') }, ctx).out[2];
    view.handleIncoming(state);
  }
  for (const [header, sample, angle] of [
    ['Time  Angle  Counts', '1  12.5  8192', 12.5],
    ['Время  Угол  Метки', '1  12.5  8192', 12.5],
    ['Время  Значение', '1  8192', 8192 / 262144000 * 360],
  ]) {
    open(['-------------------', '1 0 data_test.txt'], protocol, 'protocol');
    const link = view.rows.find(row => row.kind === 'protocol-link');
    view.send = msg => assert.equal(msg.payload.selectedProtocol, protocol);
    view.openDataFile(link.dataFilePath);
    open(['Speed_measured 2.5', '-------------------', header, sample, sample.replace(/^1/, '2')], link.dataFilePath, 'data');
    view.chartUnit = 'ticks';
    assert.equal(view.chartStats.count, 2);
    assert.equal(view.chartStats.measuredSpeed, 2.5);
    assert.equal(view.chartPoints[0].y, 8192);
    view.chartUnit = 'decimal_angle';
    assert.equal(view.chartPoints[0].y, angle);
    view.buildChart();
    assert.ok(view.chartReady && view.chartPolyline);
    assert.ok(view.dataText.includes(sample));
    view.openProtocolByPath(view.selectedProtocol);
    open(['-------------------', '1 0 data_test.txt'], protocol, 'protocol');
    assert.equal(view.chartStats.count, 0);
    assert.equal(view.selectedKind, 'protocol');
  }
});

check('BEP flow: circlogram nodes are gone; cmd? routes bep_tc_start/abort/set to BEP TiltCorrection', () => {
  assert.equal(JSON.stringify(flows).indexOf('bep-circlogram'), -1);
  const sw = flows.find(n => n.id === '68c290d96d3569d2');
  const tcId = flows.find(n => n.name === 'BEP TiltCorrection').id;
  ['bep_tc_start', 'bep_tc_abort', 'bep_tc_set'].forEach(topic => {
    const i = sw.rules.findIndex(r => r.v === topic);
    assert.ok(i >= 0 && sw.wires[i].includes(tcId), topic);
  });
  assert.equal(sw.outputs, sw.rules.length);
  const page = flows.find(n => n.id === 'f249f99f21f4d1a7').format;
  ['bep_tc_start', 'bep_tc_abort', 'bep_tc_set', 'bep_tc_state'].forEach(t => assert.ok(page.includes(t), t));
  assert.ok(!/bep_circ_|bep_zero_cal_/.test(page));
  const persist = flows.find(n => n.name === 'SettingsPersist').func;
  assert.ok(persist.includes("msg.topic === 'bep_tc_persist'"));
  for (const id of ['0c3c6139972245b3', 'cd1902e1e473a48c']) {
    const f = flows.find(n => n.id === id).format;
    assert.ok(f.includes('{ min: -180, max: 180 }'), id + ' accepts ±180°');
  }
});

console.log(failures ? ('\n' + failures + ' FAILED') : '\nall harness checks passed');
process.exit(failures ? 1 : 0);
