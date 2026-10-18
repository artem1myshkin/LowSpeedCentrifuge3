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
  assert.ok(/started/.test(r.out[1].payload.message));
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
  assert.ok(/completed \(high\)/.test(r.out[1].payload.message), r.out[1].payload.message);
  assert.equal(ctx.global.get('null_mark_state').status, 'found');
});

check('DriveInitState: revolution completed without index capture -> failed "не найдена"', () => {
  const ctx = makeCtx({ settings, current_range: 'high', logs: [] });
  const meta = { topic: 'driveInit', resolution: 'high', waitForMotionDone: true, revolutionTicks: 262144000 };
  runNode('DriveInitState', { topic: 'CMD.STARTED', payload: { topic: 'driveInit', meta } }, ctx);
  runNode('DriveInitState', { topic: 'poll_data', payload: { sr: 128, position: 0, resolution: 'high' } }, ctx);
  const r = runNode('DriveInitState', { topic: 'CMD.COMPLETED', payload: { topic: 'driveInit', meta, raw: 'MS;0;SR;128;' } }, ctx);
  assert.equal(r.out[0].payload.status, 'failed');
  assert.equal(r.out[0].payload.null_mark, 'not_found');
  assert.ok(/не найдена/.test(r.out[0].payload.last_error));
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
  r = runNode('ScenarioManager', { topic: 'CMD.ACKED', payload: { topic: 'set_jv', meta: { topic: 'set_jv' } } }, ctx);
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
  runNode('ScenarioManager', { topic: 'CMD.ACKED', payload: { topic: 'set_jv' } }, ctx);
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
  runNode('ScenarioManager', { topic: 'CMD.ACKED', payload: { topic: 'set_jp' } }, ctx);
  assert.equal(ctx.global.get('scenario_state').ready_criterion, 'software');
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
  assert.ok(/completed/.test(r.out[1].payload.message));
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
  runNode('ScenarioManager', { topic: 'CMD.ACKED', payload: { topic: 'set_jv' } }, ctx);
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
  runNode('ScenarioManager', { topic: 'CMD.ACKED', payload: { topic: 'set_jv' } }, ctx);
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

check('ProtocolManager data file: degrees column, normalized time, encoding fields', () => {
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
  assert.ok(text.includes('Время  Угол  Метки # секунда  градус  тики'), 'header: ' + text.split('\n').find(l => l.startsWith('Время')));
  assert.ok(text.includes('Кодировка          UTF-8'));
  assert.ok(text.includes('Десятичный_разделитель .'));
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
  runNode('ScenarioManager', { topic: 'CMD.ACKED', payload: { topic: 'set_jp', meta: { topic: 'set_jp' } } }, ctx);
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

// ---------------- BEP gap sensors ----------------
const BEP_K = [0.167, 0.184, 0.186, 0.2, 0.017];
function bepSettings(zeroCodes) {
  return { advanced: { BEPcoeffs: BEP_K.slice(), bepBaseMm: 112,
    bepZero: { codes: zeroCodes, samples: [0, 0, 0, 0, 0], calibratedAt: zeroCodes[0] === null ? null : '2026-10-15T10:00:00.000Z' } } };
}

check('BEP Gap: Δi = k(K(ц) − K), pair halves and Δφ in arcsec', () => {
  const ctx = makeCtx({ settings: bepSettings([4000, 4000, 4000, 4000, 4100]) });
  const raw = [3990, 4010, 4020, 3980, 4050];
  let r;
  raw.forEach((v, i) => { r = runNode('BEP Gap', { topic: 'Channel ' + (i + 1), payload: String(v) }, ctx); });
  const p = r.out.payload;
  assert.equal(r.out.topic, 'bep_gap');
  const d = raw.map((v, i) => BEP_K[i] * ([4000, 4000, 4000, 4000, 4100][i] - v));
  p.gapUm.forEach((g, i) => assert.ok(Math.abs(g - d[i]) < 1e-9, 'gap ' + i + ': ' + g));
  const p12 = (d[0] - d[1]) / 2, p34 = (d[2] - d[3]) / 2;
  assert.ok(Math.abs(p.pair12Um - p12) < 1e-9);
  assert.ok(Math.abs(p.pair34Um - p34) < 1e-9);
  // (1.67 − (−1.84))/2 = 1.755; (−3.72 − 4)/2 = −3.86; Δφ = 5.615 µm / 112000 µm · 206264.81 ≈ 10.34″
  assert.ok(Math.abs(p.tiltCorrArcsec - (p12 - p34) / 112000 * 206264.81) < 1e-9);
  assert.ok(Math.abs(p.tiltCorrArcsec - 10.341) < 0.001, 'Δφ=' + p.tiltCorrArcsec);
  assert.deepEqual(ctx.global.get('bep_gap'), p);
});

check('BEP Gap: no zero calibration -> raw only; stale bep_status clears values', () => {
  const ctx = makeCtx({ settings: bepSettings([null, null, null, null, null]) });
  let r = runNode('BEP Gap', { topic: 'Channel 1', payload: '4000' }, ctx);
  assert.equal(r.out.payload.raw[0], 4000);
  assert.equal(r.out.payload.gapUm[0], null);
  assert.ok(Math.abs(r.out.payload.scaledUm[0] - 0.167 * 4000) < 1e-9, 'k·K in µm is shown before the zero calibration');
  assert.equal(r.out.payload.tiltCorrArcsec, null);
  r = runNode('BEP Gap', { topic: 'bep_status', payload: JSON.stringify({ running: true, stale: true }) }, ctx);
  assert.equal(r.out.payload.raw[0], null);
  r = runNode('BEP Gap', { topic: 'reread' }, ctx);
  assert.equal(r.out.topic, 'bep_gap');
});

check('SettingsNormalize: BEP k defaults replace legacy zeros; K(ц) kept against a stale Settings form', () => {
  const zero = { codes: [4001.5, 4002, 4003, 4004, 4100], samples: [290, 290, 290, 290, 290], calibratedAt: '2026-10-15T10:00:00.000Z' };
  const ctx = makeCtx({ settings: { general: {}, advanced: { BEPcoeffs: [0, 0, 0, 0, 0], bepZero: zero } } });
  const s = runNode('SettingsNormalize', { topic: 'settings_aply', payload: { advanced: {
    BEPcoeffs: [0, 0, 0, 0, 0], bepZero: { codes: [null, null, null, null, null] } } } }, ctx).out[0].payload;
  assert.deepEqual(s.advanced.BEPcoeffs, BEP_K);
  assert.equal(s.advanced.bepBaseMm, 112);
  assert.deepEqual(s.advanced.bepZero, zero);
  const s2 = runNode('SettingsNormalize', { topic: 'settings_aply', payload: { advanced: { BEPcoeffs: [0.2, 0.2, 0.2, 0.2, 0.02], bepBaseMm: 110 } } }, ctx).out[0].payload;
  assert.deepEqual(s2.advanced.BEPcoeffs, [0.2, 0.2, 0.2, 0.2, 0.02]);
  assert.equal(s2.advanced.bepBaseMm, 110);
});

function withNow(t, fn) { const real = Date.now; Date.now = () => t; try { return fn(); } finally { Date.now = real; } }
function bepCalCtx() {
  return makeCtx({ settings: bepSettings([null, null, null, null, null]), current_range: 'high',
    drive_limits: { ticks_per_deg: 262144000 / 360 }, drive_state: { mo: 1, so: 1, ms: 0 }, scenario_state: { status: 'idle' } });
}
function feedChannels(ctx, t, codes) {
  withNow(t, () => codes.forEach((v, i) => runNode('BEP ZeroCalibration', { topic: 'Channel ' + (i + 1), payload: String(v) }, ctx)));
}
function tickCal(ctx, t) {
  const iv = ctx.intervals.filter(x => x.active).pop();
  if (!iv) return [];
  const before = iv.sent.length;
  withNow(t, () => iv.fn());
  return iv.sent.slice(before);
}

check('BEP ZeroCalibration: preconditions — tilt confirmation, motor on, fresh data', () => {
  const ctx = bepCalCtx();
  let r = runNode('BEP ZeroCalibration', { topic: 'bep_zero_cal_start', payload: {} }, ctx);
  assert.equal(ctx.context.get('state').status, 'error');
  feedChannels(ctx, 1000, [4000, 4000, 4000, 4000, 4100]);
  ctx.global.set('drive_state', { mo: 0, so: 0, ms: 0 });
  withNow(1500, () => runNode('BEP ZeroCalibration', { topic: 'bep_zero_cal_start', payload: { tiltConfirmed: true } }, ctx));
  assert.ok(/MO=0/.test(ctx.context.get('state').message));
  ctx.global.set('drive_state', { mo: 1, so: 1, ms: 0 });
  r = withNow(9000, () => runNode('BEP ZeroCalibration', { topic: 'bep_zero_cal_start', payload: { tiltConfirmed: true } }, ctx));
  assert.ok(/нет данных/.test(ctx.context.get('state').message), 'stale BEP data must block the start');
  assert.equal(r.out, null);
});

check('BEP ZeroCalibration: one turn at 2.5 °/s, 1 °/s², K(ц) = average, persisted', () => {
  const ctx = bepCalCtx();
  const t0 = 100000;
  feedChannels(ctx, t0 - 100, [1, 1, 1, 1, 1]);
  const r = withNow(t0, () => runNode('BEP ZeroCalibration', { topic: 'bep_zero_cal_start', payload: { tiltConfirmed: true } }, ctx));
  assert.equal(r.out[0].payload.status, 'running');
  assert.deepEqual(r.out[1], { topic: 'set_relative_position', payload: { ticks: 262144000, sp_ticks: 1820444, ac_ticks: 728178, dc_ticks: 728178 } });
  assert.equal(r.out[3].topic, 'journal_event');
  // samples before the drive reports motion are ignored
  feedChannels(ctx, t0 + 200, [9999, 9999, 9999, 9999, 9999]);
  ctx.global.set('drive_state', { mo: 1, so: 1, ms: 2 });
  tickCal(ctx, t0 + 1000);
  for (let k = 0; k < 20; k++) feedChannels(ctx, t0 + 2000 + k * 500, [4000 + (k % 2), 4010, 4020, 4030, k < 5 ? 4100 : 4100]);
  let out = tickCal(ctx, t0 + 60000);
  assert.equal(out[0][0].payload.status, 'running');
  assert.ok(out[0][0].payload.progressPct > 30 && out[0][0].payload.progressPct < 50);
  ctx.global.set('drive_state', { mo: 1, so: 1, ms: 0 });
  out = tickCal(ctx, t0 + 147000);
  const [ui, cmd, persist, jr] = out[0];
  assert.equal(ui.payload.status, 'done');
  assert.equal(cmd, null);
  assert.deepEqual(ui.payload.codes, [4000.5, 4010, 4020, 4030, 4100]);
  assert.equal(persist.topic, 'bep_zero_persist');
  assert.deepEqual(persist.settings.advanced.bepZero.codes, [4000.5, 4010, 4020, 4030, 4100]);
  assert.deepEqual(ctx.global.get('settings').advanced.bepZero.samples, [20, 20, 20, 20, 20]);
  assert.equal(jr.topic, 'journal_event');
  assert.equal(ctx.intervals.filter(x => x.active).length, 0, 'timer stopped');
});

check('BEP ZeroCalibration: abort stops the drive; early stop is an error; K(ц) untouched', () => {
  const ctx = bepCalCtx();
  feedChannels(ctx, 0, [1, 1, 1, 1, 1]);
  withNow(10, () => runNode('BEP ZeroCalibration', { topic: 'bep_zero_cal_start', payload: { tiltConfirmed: true } }, ctx));
  ctx.global.set('drive_state', { mo: 1, so: 1, ms: 2 });
  tickCal(ctx, 1000);
  const ab = ctx.intervals[0].node;
  const r = withNow(2000, () => runNode('BEP ZeroCalibration', { topic: 'bep_zero_cal_abort', payload: true }, ctx));
  assert.equal(r.out, null);
  const last = r.sent[r.sent.length - 1];
  assert.equal(last[0].payload.status, 'aborted');
  assert.equal(last[1].topic, 'drive_stop');
  assert.ok(ab);
  // second run: the drive stops after 30 s (e.g. STOP from another tab)
  feedChannels(ctx, 3000, [1, 1, 1, 1, 1]);
  ctx.global.set('drive_state', { mo: 1, so: 1, ms: 0 });
  withNow(3010, () => runNode('BEP ZeroCalibration', { topic: 'bep_zero_cal_start', payload: { tiltConfirmed: true } }, ctx));
  ctx.global.set('drive_state', { mo: 1, so: 1, ms: 2 });
  tickCal(ctx, 4000);
  ctx.global.set('drive_state', { mo: 1, so: 1, ms: 0 });
  const out = tickCal(ctx, 33000);
  assert.equal(out[0][0].payload.status, 'error');
  assert.ok(/прервано/.test(out[0][0].payload.message));
  assert.deepEqual(ctx.global.get('settings').advanced.bepZero.codes, [null, null, null, null, null]);
});

// ---------------- Appendix A: circlograms ----------------
const REV = 262144000;
function circCtx(extraAdvanced) {
  const st = bepSettings([null, null, null, null, null]);
  st.general = { angleCorrectionMode: 'circlogram' };
  st.advanced.circlogram = { n: 4, turns: 1, speedDegSec: 5, accelDegSec2: 1 };
  Object.assign(st.advanced, extraAdvanced || {});
  return makeCtx({ settings: st, current_range: 'high', drive_limits: { ticks_per_deg: REV / 360 },
    drive_state: { mo: 1, so: 1, ms: 0, position: 0 }, scenario_state: { status: 'idle' },
    drive_init_state: { status: 'done', initialized: true }, bun_angle: 0 });
}
// One trial rotation: rowsByI[i] = codes EP1..EP5 seen at point i (one sample per channel per point).
function runCirc(ctx, kind, rowsByI, t0) {
  feedCircChannels(ctx, t0 - 100, rowsByI[0], 0);
  const r = withNow(t0, () => runNode('BEP Circlogram', { topic: 'bep_circ_start', payload: { kind, tiltConfirmed: true } }, ctx));
  ctx.global.set('drive_state', Object.assign({}, ctx.global.get('drive_state'), { ms: 2 }));
  tickCirc(ctx, t0 + 1000);
  rowsByI.forEach((codes, i) => feedCircChannels(ctx, t0 + 2000 + i * 100, codes, (i * 90 + 45) / 360 * REV + 3 * REV));
  ctx.global.set('drive_state', Object.assign({}, ctx.global.get('drive_state'), { ms: 0 }));
  const out = tickCirc(ctx, t0 + 80000);
  return { start: r, out: out[0] };
}
function feedCircChannels(ctx, t, codes, position) {
  ctx.global.set('drive_state', Object.assign({}, ctx.global.get('drive_state'), { position }));
  withNow(t, () => codes.forEach((v, j) => runNode('BEP Circlogram', { topic: 'Channel ' + (j + 1), payload: String(v) }, ctx)));
}
function tickCirc(ctx, t) {
  const iv = ctx.intervals.filter(x => x.active).pop();
  if (!iv) return [];
  const before = iv.sent.length;
  withNow(t, () => iv.fn());
  return iv.sent.slice(before);
}
// Reference implementation of the Appendix A formulas (EP in µm via k).
function appendixX(rows) {
  const n = rows.length; let up = 0, low = 0;
  rows.forEach((r, i) => {
    const ep = r.map((v, j) => v * BEP_K[j]);
    up += (ep[0] - ep[1]) / 2 * Math.cos(2 * Math.PI * i / n);
    low += (ep[2] - ep[3]) / 2 * Math.cos(2 * Math.PI * i / n);
  });
  return { xUp: up / n, xLow: low / n };
}

check('BEP Circlogram: preconditions (initial first, homing done)', () => {
  let ctx = circCtx();
  feedCircChannels(ctx, 1000, [1, 1, 1, 1, 1], 0);
  withNow(1500, () => runNode('BEP Circlogram', { topic: 'bep_circ_start', payload: { kind: 'current' } }, ctx));
  assert.ok(/начальной/.test(ctx.context.get('state').message));
  ctx = circCtx();
  ctx.global.set('drive_init_state', {});
  feedCircChannels(ctx, 1000, [1, 1, 1, 1, 1], 0);
  withNow(1500, () => runNode('BEP Circlogram', { topic: 'bep_circ_start', payload: { kind: 'initial', tiltConfirmed: true } }, ctx));
  assert.ok(/нулевой метки/.test(ctx.context.get('state').message));
});

check('BEP Circlogram: Appendix A — rows per point i, X by cos(360°·i/n), dφ = ((ΔXup) − (ΔXlow)) / L', () => {
  const ctx = circCtx();
  const initRows = [[1000, 1010, 2000, 2004, 4000], [1002, 1010, 2001, 2004, 4000], [1004, 1008, 2003, 2002, 4000], [1002, 1006, 2001, 2000, 4000]];
  const r0 = runCirc(ctx, 'initial', initRows, 100000);
  assert.deepEqual(r0.start.out[1].payload, { ticks: REV, sp_ticks: 3640889, ac_ticks: 728178, dc_ticks: 728178 });
  const [ui0, , persist0, , file0] = r0.out;
  assert.equal(ui0.payload.status, 'done');
  const init = persist0.settings.advanced.circlogramInitial;
  assert.deepEqual(init.rows, initRows);
  const x0 = appendixX(initRows);
  assert.ok(Math.abs(init.xUp - x0.xUp) < 1e-9 && Math.abs(init.xLow - x0.xLow) < 1e-9);
  assert.ok(/^C:\\NC3\\circlograms\\circlogram_initial_\d{8}_\d{6}\.txt$/.test(file0.filename), file0.filename);
  assert.ok(file0.payload.includes('i\tEP1\tEP2\tEP3\tEP4\tEP5\r\n0\t1000\t1010\t2000\t2004\t4000'));

  ctx.global.set('bun_angle', 36000);
  const curRows = [[1030, 1000, 2010, 2000, 4001], [1002, 1010, 2001, 2004, 4001], [990, 1020, 1995, 2010, 4001], [1002, 1006, 2001, 2000, 4001]];
  const r1 = runCirc(ctx, 'current', curRows, 300000);
  const cur = r1.out[2].settings.advanced.circlogramCurrent;
  const x1 = appendixX(curRows);
  const expected = ((x1.xUp - x0.xUp) - (x1.xLow - x0.xLow)) / 112000 * 206264.81;
  assert.ok(Math.abs(cur.dphiArcsec - expected) < 1e-9, cur.dphiArcsec + ' vs ' + expected);
  assert.equal(cur.tiltArcsec, 36000);
  assert.equal(ctx.global.get('bep_motion_busy'), null);
});

check('BEP Circlogram: an empty point i is an error, not a guess', () => {
  const ctx = circCtx();
  feedCircChannels(ctx, 99900, [1, 1, 1, 1, 1], 0);
  withNow(100000, () => runNode('BEP Circlogram', { topic: 'bep_circ_start', payload: { kind: 'initial', tiltConfirmed: true } }, ctx));
  ctx.global.set('drive_state', Object.assign({}, ctx.global.get('drive_state'), { ms: 2 }));
  tickCirc(ctx, 101000);
  feedCircChannels(ctx, 102000, [1, 1, 1, 1, 1], 0.1 * REV);   // only point 0
  ctx.global.set('drive_state', Object.assign({}, ctx.global.get('drive_state'), { ms: 0 }));
  const out = tickCirc(ctx, 180000);
  assert.equal(out[0][0].payload.status, 'error');
  assert.ok(/i=1/.test(out[0][0].payload.message));
});

check('Tilt correction variants: displayed angle = БУН + dφ; AutoTilt keeps the raw angle', () => {
  const ctx = circCtx({ circlogramInitial: { xUp: 0, xLow: 0 }, circlogramCurrent: { xUp: 1, xLow: 0, dphiArcsec: 12.5 } });
  let r = runNode(' BUN Calibration'.trim(), { topic: 'bun_angle', payload: 3600 }, ctx);
  assert.equal(r.out.payload, 3612.5);
  assert.equal(r.out.raw_angle, 3600);
  assert.equal(ctx.global.get('bun_angle'), 3600);
  assert.equal(ctx.global.get('bun_angle_corrected'), 3612.5);
  ctx.global.get('settings').general.angleCorrectionMode = 'bep';
  ctx.global.set('bep_gap', { tiltCorrArcsec: -3.8, ts: Date.now() });
  r = runNode('BUN Calibration', { topic: 'bun_angle', payload: 3600 }, ctx);
  assert.ok(Math.abs(r.out.payload - 3596.2) < 1e-9);
  ctx.global.get('settings').general.angleCorrectionMode = 'off';
  r = runNode('BUN Calibration', { topic: 'bun_angle', payload: 3600 }, ctx);
  assert.equal(r.out.payload, 3600);
  // AutoTilt: target 3600, corrected angle 3612.5 but raw 3600 -> reached
  ctx.global.get('settings').general.angleCorrectionMode = 'circlogram';
  runNode('BUN AutoTilt', { topic: 'bun_cmd_setpoint', payload: 3600, mode: 'Авто' }, ctx, { runTimers: true });
  for (let i = 0; i < 3; i++) runNode('BUN AutoTilt', runNode('BUN Calibration', { topic: 'bun_angle', payload: 3600 }, ctx).out, ctx);
  assert.equal(ctx.flow.get('bun_auto_state').status, 'complete');
});

console.log(failures ? ('\n' + failures + ' FAILED') : '\nall harness checks passed');
process.exit(failures ? 1 : 0);
