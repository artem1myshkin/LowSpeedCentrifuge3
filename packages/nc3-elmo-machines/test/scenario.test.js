'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  speedAllowedInRange,
  scenarioOptions,
  selectResolutionForSpeed,
  computeSpeedReachTimeoutMs,
  normalizeScenarioFileName,
  listScenarioFiles,
  parseScenarioText,
  normalizeScenario,
  evaluateSpeedReady,
} = require('../src/scenario');

test('scenarioOptions takes speed limits from VH[2], not from custom ranges', () => {
  const opts = scenarioOptions({ general: { speedReadyTolerancePercent: 7 } });
  // nominal VH[2] of the head pairs: 34952533 ticks (~48 deg/s) and 6553600 ticks (360 deg/s)
  assert.ok(Math.abs(opts.vh2DegSec.high - 48) < 0.01, 'high ' + opts.vh2DegSec.high);
  assert.equal(opts.vh2DegSec.low, 360);
  assert.equal(opts.switchBoundaryDegSec, opts.vh2DegSec.high, 'boundary is the high-pair VH[2]');
  assert.equal(opts.switchHysteresisDegSec, 5);
  assert.equal(opts.speedReadyTolerancePercent, 7);
  assert.equal(opts.ranges, undefined, 'custom ranges are gone');
  // VH[2] actually read from the drive wins over the nominal table
  const live = scenarioOptions({ advanced: { driveVh2Ticks: { high: 7281778 } } });
  assert.ok(Math.abs(live.vh2DegSec.high - 10) < 0.001, 'high ' + live.vh2DegSec.high);
  assert.ok(Math.abs(live.switchBoundaryDegSec - 10) < 0.001);
});

test('selectResolutionForSpeed switches at the high-pair VH[2] with hysteresis, by absolute speed', () => {
  // VH[2] high ~48 deg/s, hysteresis 5 deg/s: high pair up to 48, back from low below 43.
  assert.equal(selectResolutionForSpeed(30, 'high').resolution, 'high');
  assert.equal(selectResolutionForSpeed(-30, 'high').resolution, 'high', 'sign is direction only');
  assert.equal(selectResolutionForSpeed(60, 'high').resolution, 'low');
  assert.equal(selectResolutionForSpeed(-60, 'high').resolution, 'low');
  assert.equal(selectResolutionForSpeed(45, 'low').resolution, 'low', 'inside the hysteresis band stays low');
  assert.equal(selectResolutionForSpeed(40, 'low').resolution, 'high');
  assert.equal(selectResolutionForSpeed(-40, 'low').resolution, 'high');
  // a drive VH[2] read back for the high pair moves the boundary with it
  const override = { driveVh2Ticks: { high: 7281778 } }; // 10 deg/s
  assert.equal(selectResolutionForSpeed(12, 'high', null, override).resolution, 'low');
  assert.equal(selectResolutionForSpeed(8, 'high', null, override).resolution, 'high');
});

test('selectResolutionForSpeed rejects speeds above the low-pair VH[2]', () => {
  const selected = selectResolutionForSpeed(361, 'low');
  assert.equal(selected.ok, false);
  assert.equal(selected.reason, 'above_vh2');
  assert.equal(selected.maxDeg, 360);
  assert.equal(selectResolutionForSpeed(-361, 'low').ok, false);
  // there is no lower limit any more: any small speed is valid on the high pair
  assert.equal(selectResolutionForSpeed(0.0001, 'high').resolution, 'high');
  assert.equal(speedAllowedInRange(0.0001, 'high').ok, true);
  assert.equal(speedAllowedInRange(-48.5, 'high').ok, false, 'above the high-pair VH[2]');
});

test('computeSpeedReachTimeoutMs uses target speed, acceleration and reserve', () => {
  assert.equal(computeSpeedReachTimeoutMs(8, 0.5), 26000);
  assert.equal(computeSpeedReachTimeoutMs(-8, 0.5), 26000);
  assert.equal(computeSpeedReachTimeoutMs(0, 0.5), 10000);
  assert.equal(computeSpeedReachTimeoutMs(8, 0.5, 5000), 21000);
});

test('computeSpeedReachTimeoutMs budgets deceleration from the current speed', () => {
  // Slow-down 10 -> 0.1 deg/s at DC=0.5: ramp 19.8 s + 10 s reserve.
  assert.equal(computeSpeedReachTimeoutMs(0.1, 0.5, 10000, 10, 0.5), 29800);
  // Speed-up 2 -> 8 deg/s uses AC, not DC.
  assert.equal(computeSpeedReachTimeoutMs(8, 0.5, 10000, 2, 0.25), 22000);
  // Reversal -10 -> +5: 10/DC(0.5)=20 s through zero, then 5/AC(0.5)=10 s.
  assert.equal(computeSpeedReachTimeoutMs(5, 0.5, 10000, -10, 0.5), 40000);
  // Stop step 10 -> 0 decelerates at DC.
  assert.equal(computeSpeedReachTimeoutMs(0, 0.5, 10000, 10, 0.25), 50000);
  // Missing deceleration falls back to the acceleration rate.
  assert.equal(computeSpeedReachTimeoutMs(0.1, 0.5, 10000, 10), 29800);
});

test('listScenarioFiles returns defaults plus .scn files from directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc3-scenarios-'));
  fs.writeFileSync(path.join(dir, 'custom.scn'), 'Name custom\n-------------------\n1 1\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore');

  const files = listScenarioFiles(dir, ['high_resolution.scn']);
  assert.deepEqual(files, ['high_resolution.scn', 'custom.scn']);
  assert.equal(normalizeScenarioFileName('..\\Тестовый сценарий'), 'Тестовый сценарий.scn');
});

test('parseScenarioText reads metadata and speed/hold steps', () => {
  const parsed = parseScenarioText(`
=====
# comment
Name low_test
-------------------
5 30 # deg/s sec
-10.5 120
=====
`);
  assert.equal(parsed.meta.Name, 'low_test');
  assert.deepEqual(parsed.steps, [
    { speed_deg_per_sec: 5, hold_sec: 30 },
    { speed_deg_per_sec: -10.5, hold_sec: 120 },
  ]);
});

test('normalizeScenario assigns resolution, switch markers and ticks', () => {
  const normalized = normalizeScenario(`
=====
Name switch_test
-------------------
5 30
30 60
18 45
=====
`, 'high');

  assert.equal(normalized.steps[0].resolution, 'high');
  assert.equal(normalized.steps[0].range_switch_required, false);
  // 30 deg/s still fits the high pair (VH[2] ~48), so no switch happens any more
  assert.equal(normalized.steps[1].resolution, 'high');
  assert.equal(normalized.steps[1].range_switch_required, false);
  assert.equal(normalized.steps[2].resolution, 'high');
  assert.equal(normalized.steps[2].range_switch_required, false);
});

test('normalizeScenario switches pairs above the high-pair VH[2]', () => {
  const normalized = normalizeScenario('-----\n5 30\n120 60\n30 45\n', 'high');
  assert.equal(normalized.steps[0].resolution, 'high');
  assert.equal(normalized.steps[1].resolution, 'low');
  assert.equal(normalized.steps[1].range_switch_required, true);
  // 30 deg/s is below the hysteresis band bottom (48-5=43) -> back to the high pair
  assert.equal(normalized.steps[2].resolution, 'high');
  assert.equal(normalized.steps[2].range_switch_required, true);
  assert.throws(() => normalizeScenario('-----\n400 10\n', 'high'), /outside/);
});

test('evaluateSpeedReady requires stable time and reports timeout', () => {
  let state = evaluateSpeedReady(null, 9.6, 10, 1000, null, {
    speedReadyTolerancePercent: 5,
    speedStableTimeMs: 1000,
    speedReachTimeoutMs: 3000,
  });
  assert.equal(state.withinTolerance, true);
  assert.equal(state.ready, false);

  state = evaluateSpeedReady(state, 10.2, 10, 1999, null, {
    speedReadyTolerancePercent: 5,
    speedStableTimeMs: 1000,
    speedReachTimeoutMs: 3000,
  });
  assert.equal(state.ready, false);

  state = evaluateSpeedReady(state, 10.1, 10, 2000, null, {
    speedReadyTolerancePercent: 5,
    speedStableTimeMs: 1000,
    speedReachTimeoutMs: 3000,
  });
  assert.equal(state.ready, true);
  assert.equal(state.toleranceDegSec, 0.5);
  assert.ok(state.errorPercent <= 5);

  const timeoutState = evaluateSpeedReady({ startedAt: 1000 }, 8, 10, 4000, null, {
    speedReadyTolerancePercent: 5,
    speedStableTimeMs: 1000,
    speedReachTimeoutMs: 3000,
  });
  assert.equal(timeoutState.timedOut, true);
});

test('scenarioOptions exposes MS criterion and JV/JP mode with JV/ms defaults', () => {
  const { scenarioOptions, effectiveReadyCriterion } = require('../src/scenario');
  const def = scenarioOptions({});
  assert.equal(def.speedReadyCriterion, 'ms');
  assert.equal(def.rotationCommandMode, 'JV');
  const sw = scenarioOptions({ advanced: { speedReadyCriterion: 'software', rotationCommandMode: 'jp' } });
  assert.equal(sw.speedReadyCriterion, 'software');
  assert.equal(sw.rotationCommandMode, 'JP');
  // JP cannot use MS (Recommendations table 5.2) -> software fallback even when 'ms' is configured
  assert.equal(effectiveReadyCriterion(scenarioOptions({ advanced: { rotationCommandMode: 'JP' } })), 'software');
  assert.equal(effectiveReadyCriterion(def, 'JV'), 'ms');
  assert.equal(effectiveReadyCriterion(def, 'JP'), 'software');
});

test('evaluateMsReady waits for the ramp, then MS=0, then times out', () => {
  const { evaluateMsReady, computeRampMs } = require('../src/scenario');
  assert.equal(computeRampMs(5, 0.5, 0, 0.5), 10000);
  assert.equal(computeRampMs(-5, 0.5, 5, 0.5), 20000);
  let st = evaluateMsReady(null, 2, 1000, { rampMs: 10000, msTimeoutMs: 10000 });
  assert.equal(st.phase, 'ramp');
  assert.equal(st.ready, false);
  assert.equal(st.timedOut, false);
  // MS=0 during the ramp is ignored (profiler still moving the target)
  st = evaluateMsReady(st, 0, 5000, { msTimeoutMs: 10000 });
  assert.equal(st.phase, 'ramp');
  assert.equal(st.ready, false);
  st = evaluateMsReady(st, 2, 12000, { msTimeoutMs: 10000 });
  assert.equal(st.phase, 'ms_wait');
  assert.equal(st.ready, false);
  // no VX available -> MS=0 after the ramp is the only signal
  st = evaluateMsReady(st, 0, 13000, { msTimeoutMs: 10000 });
  assert.equal(st.ready, true);
  assert.equal(st.readyBy, 'ms');
  assert.equal(st.timedOut, false);
  const late = evaluateMsReady(st, 1, 21000, { msTimeoutMs: 10000 });
  assert.equal(late.ready, false);
  assert.equal(late.timedOut, true);
  const unknown = evaluateMsReady(st, null, 13000, { msTimeoutMs: 10000 });
  assert.equal(unknown.ready, false);
  assert.equal(unknown.ms, null);
});

test('evaluateMsReady: MS=2 at steady JV is ready once VX stays in the TR[3] window for TR[4] ms', () => {
  const { evaluateMsReady } = require('../src/scenario');
  const win = { msTimeoutMs: 10000, targetDegSec: 2, windowDegSec: 0.5, windowMs: 100 };
  let st = evaluateMsReady(null, 2, 1000, Object.assign({ rampMs: 2100, measuredDegSec: 0.3 }, win));
  assert.equal(st.phase, 'ramp');
  st = evaluateMsReady(st, 2, 3200, Object.assign({ measuredDegSec: 2.0047 }, win));
  assert.equal(st.phase, 'ms_wait');
  assert.equal(st.inWindow, true);
  assert.equal(st.ready, false, 'dwell not yet elapsed');
  st = evaluateMsReady(st, 2, 3350, Object.assign({ measuredDegSec: 2.0047 }, win));
  assert.equal(st.ready, true);
  assert.equal(st.readyBy, 'window');
  // leaving the window resets the dwell
  let out = evaluateMsReady(null, 2, 1000, Object.assign({ rampMs: 0, measuredDegSec: 1.2 }, win));
  out = evaluateMsReady(out, 2, 1200, Object.assign({ measuredDegSec: 1.2 }, win));
  assert.equal(out.ready, false);
  assert.equal(out.inWindowSince, null);
  // MS=0 with VX known but outside the window (drive stopped by ST, JV still stored) is NOT ready
  const stopped = evaluateMsReady(null, 0, 1000, Object.assign({ rampMs: 0, measuredDegSec: 0.0 }, win));
  assert.equal(stopped.ready, false);
  // an over-estimated ramp (stale current speed) does not delay window readiness
  let early = evaluateMsReady(null, 2, 1000, Object.assign({ rampMs: 60000, measuredDegSec: 2.01 }, win));
  early = evaluateMsReady(early, 2, 1200, Object.assign({ measuredDegSec: 2.01 }, win));
  assert.equal(early.phase, 'ramp');
  assert.equal(early.ready, true);
  assert.equal(early.readyBy, 'window');
});
