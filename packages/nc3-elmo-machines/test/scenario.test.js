'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  scenarioOptions,
  selectResolutionForSpeed,
  computeSpeedReachTimeoutMs,
  normalizeScenarioFileName,
  listScenarioFiles,
  parseScenarioText,
  normalizeScenario,
  evaluateSpeedReady,
} = require('../src/scenario');

test('scenarioOptions uses non-zero settings ranges and falls back from zero values', () => {
  const settings = {
    advanced: {
      encoderSwitchSpeed: { decimalDeg: 0 },
      rotationSpeedRanges: {
        high: { min: { decimalDeg: 0 }, max: { decimalDeg: 48 } },
        low: { min: { decimalDeg: 0 }, max: { decimalDeg: 400 } },
      },
    },
    general: {
      speedReadyTolerancePercent: 7,
    },
  };
  const opts = scenarioOptions(settings);
  assert.equal(opts.ranges.high.minDeg, 1 / 3600);
  assert.equal(opts.ranges.high.maxDeg, 48);
  assert.equal(opts.ranges.low.minDeg, 10);
  assert.equal(opts.ranges.low.maxDeg, 360);
  assert.equal(opts.switchBoundaryDegSec, 20);
  assert.equal(opts.speedReadyTolerancePercent, 7);
});

test('selectResolutionForSpeed keeps current range inside 20 deg/s +/-5 hysteresis', () => {
  assert.equal(selectResolutionForSpeed(22, 'high').resolution, 'high');
  assert.equal(selectResolutionForSpeed(22, 'low').resolution, 'low');
  assert.equal(selectResolutionForSpeed(26, 'high').resolution, 'low');
  assert.equal(selectResolutionForSpeed(14, 'low').resolution, 'high');
});

test('selectResolutionForSpeed rejects low-range absolute max above 360 deg/s', () => {
  const selected = selectResolutionForSpeed(361, 'low');
  assert.equal(selected.ok, false);
  assert.equal(selected.reason, 'above_low_absolute_max');
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
  assert.equal(normalized.steps[1].resolution, 'low');
  assert.equal(normalized.steps[1].range_switch_required, true);
  assert.equal(normalized.steps[2].resolution, 'low');
  assert.equal(normalized.steps[2].range_switch_required, false);
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
