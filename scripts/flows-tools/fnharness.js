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
  const fn = new Function('msg', 'node', 'global', 'flow', 'context', 'setTimeout', 'clearTimeout', 'RED', 'env', n.func);
  const out = fn(msg, node, ctx.global, ctx.flow, ctx.context, fakeTimeout, () => {}, {}, { get: () => undefined });
  if (opts && opts.runTimers) timers.sort((a, b) => a.ms - b.ms).forEach(t => t.fn());
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
    rotationSpeedRanges: { high: { min: { decimalDeg: 0.000277778 }, max: { decimalDeg: 20 } }, low: { min: { decimalDeg: 10 }, max: { decimalDeg: 360 } } },
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
  const r = runNode('CommandHandler', { topic: 'driveInit', payload: { resolution: 'low', mode: 'full' } }, ctx, { runTimers: true });
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

check('CommandHandler speed limit uses drive VH[2] when known for this pair', () => {
  const ctx = makeCtx({ settings, nc3, current_range: 'high' });
  ctx.flow.set('poll_buffer', { vh2: 7281778, vh2_resolution: 'high' }); // 10 deg/s from the drive
  const r = runNode('CommandHandler', { topic: 'set_jv', payload: { ticks: 8000000 } }, ctx); // 11 deg/s
  assert.equal(r.out, null, 'above VH[2] must be rejected');
  assert.ok(r.logs.some(l => /outside allowed range/.test(String(l[1]))));
  assert.equal(ctx.global.get('drive_limits').speed_max_ticks, 7281778);
  assert.equal(ctx.global.get('drive_limits').drive_vh2_ticks, 7281778);
  const ok = runNode('CommandHandler', { topic: 'set_jv', payload: { ticks: 7000000 } }, ctx);
  assert.ok(ok.out && ok.out.payload.startsWith('AC='), 'below VH[2] accepted');
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

check('ResponseParser: VH[2] from the drive caps drive_limits for the same pair only', () => {
  const ctx = makeCtx({ settings });
  const p = parse(ctx, 'OL[1];0;VH[2];7281778;').payload;
  assert.equal(p.drive_limits.speed_max_ticks, 7281778);
  assert.equal(p.drive_limits.drive_vh2_ticks, 7281778);
  const q = parse(ctx, 'OL[1];1;').payload; // switched to low: stale high VH[2] must not cap
  assert.equal(q.drive_limits.drive_vh2_ticks, null);
  assert.equal(q.drive_limits.speed_max_ticks, 6553600);
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
  assert.ok(r.out[1] && /метка найдена/.test(r.out[1].payload.message), JSON.stringify(r.out[1]));
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
check('SettingsNormalize: defaults, TR[2]=0 rejected, switch boundary clamped, TR apply only on change', () => {
  const ctx = makeCtx({});
  let r = runNode('SettingsNormalize', { topic: 'settings_aply', payload: { advanced: { trWindows: { high: { positionTimeMs: 0 } }, encoderSwitchSpeed: { decimalDeg: 30 } } } }, ctx);
  const s = r.out[0].payload;
  assert.equal(s.advanced.speedReadyCriterion, 'ms');
  assert.equal(s.advanced.rotationCommandMode, 'JV');
  assert.equal(s.advanced.trWindows.high.positionTimeMs, 100);
  assert.equal(s.advanced.encoderSwitchSpeed.decimalDeg, 20, 'clamped to high max');
  assert.equal(r.out[1].topic, 'apply_tr_windows');
  r = runNode('SettingsNormalize', { topic: 'settings_aply', payload: { general: { recordingSaveRawData: true } } }, ctx);
  assert.equal(r.out[1], null, 'no TR change -> no apply');
});

console.log(failures ? ('\n' + failures + ' FAILED') : '\nall harness checks passed');
process.exit(failures ? 1 : 0);

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
