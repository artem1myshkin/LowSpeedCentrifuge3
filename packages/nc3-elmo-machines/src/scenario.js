'use strict';

const fs = require('fs');
const path = require('path');
const { degPerSecToTicks } = require('./res');

const DEFAULT_SPEED_RANGES = {
  high: { minDeg: 1 / 3600, maxDeg: 20 },
  low: { minDeg: 10, maxDeg: 360 },
};

const DEFAULT_SCENARIO_OPTIONS = {
  switchBoundaryDegSec: 20,
  switchHysteresisDegSec: 5,
  speedRangeToleranceDegSec: 5,
  speedReadyTolerancePercent: 5,
  speedStableTimeMs: 1000,
  speedReachTimeoutMs: 10000,
  protocolPollMaxHz: 30,
  // 'ms': readiness from the drive's MS flag after the computed ramp (Appendix B item B1.3);
  // 'software': legacy tolerance/stable-time criterion on measured speed (fallback, and the
  // only option for JP because MS does not work for JP - Recommendations table 5.2).
  speedReadyCriterion: 'ms',
  rotationCommandMode: 'JV',
};

function readyCriterion(value) {
  return String(value || '').toLowerCase() === 'software' ? 'software' : 'ms';
}

function rotationMode(value) {
  return String(value || '').toUpperCase() === 'JP' ? 'JP' : 'JV';
}

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeScenarioFileName(value) {
  let name = path.basename(String(value || '').trim());
  name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  if (!name) name = 'scenario.scn';
  if (!/\.scn$/i.test(name)) name += '.scn';
  return name;
}

function listScenarioFiles(baseDir, defaults) {
  const seen = new Set();
  const out = [];
  const add = (name) => {
    const fileName = normalizeScenarioFileName(name);
    if (!/\.scn$/i.test(fileName)) return;
    const key = fileName.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(fileName);
  };

  (Array.isArray(defaults) ? defaults : []).forEach(add);
  try {
    fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.scn$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'ru'))
      .forEach(add);
  } catch (_) {
    // Missing scenario directory is handled by the caller/file node on first save.
  }
  return out;
}

function angleDeg(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value !== 'object') return finite(value, fallback);
  if (value.decimalDeg !== undefined && value.decimalDeg !== null && value.decimalDeg !== '') {
    return finite(value.decimalDeg, fallback);
  }
  if (value.rad !== undefined && value.rad !== null && value.rad !== '') {
    return finite(value.rad, 0) * 180 / Math.PI;
  }
  const deg = finite(value.deg, 0);
  const min = finite(value.min, 0);
  const sec = finite(value.sec, 0);
  const sign = deg < 0 ? -1 : 1;
  return sign * (Math.abs(deg) + min / 60 + sec / 3600);
}

function configuredRange(settings, key) {
  const defaults = DEFAULT_SPEED_RANGES[key];
  const range = settings && settings.advanced && settings.advanced.rotationSpeedRanges
    && settings.advanced.rotationSpeedRanges[key];
  let minDeg = Math.abs(angleDeg(range && range.min, defaults.minDeg));
  let maxDeg = Math.abs(angleDeg(range && range.max, defaults.maxDeg));
  if (!(minDeg > 0)) minDeg = defaults.minDeg;
  if (!(maxDeg > 0)) maxDeg = defaults.maxDeg;
  if (key === 'low') maxDeg = Math.min(maxDeg, 360);
  if (maxDeg < minDeg) {
    minDeg = defaults.minDeg;
    maxDeg = defaults.maxDeg;
  }
  return { minDeg, maxDeg };
}

function scenarioOptions(settings, override) {
  const advanced = (settings && settings.advanced) || {};
  const general = (settings && settings.general) || {};
  const o = override || {};
  const switchBoundary = finite(o.switchBoundaryDegSec, finite(advanced.encoderSwitchSpeedDegSec, angleDeg(advanced.encoderSwitchSpeed, DEFAULT_SCENARIO_OPTIONS.switchBoundaryDegSec)));
  const tolerancePercent = clamp(
    finite(o.speedReadyTolerancePercent, finite(general.speedReadyTolerancePercent, DEFAULT_SCENARIO_OPTIONS.speedReadyTolerancePercent)),
    0,
    100
  );
  return {
    ranges: {
      high: configuredRange(settings, 'high'),
      low: configuredRange(settings, 'low'),
    },
    switchBoundaryDegSec: switchBoundary > 0 ? switchBoundary : DEFAULT_SCENARIO_OPTIONS.switchBoundaryDegSec,
    switchHysteresisDegSec: finite(o.switchHysteresisDegSec, finite(advanced.encoderSwitchHysteresisDegSec, DEFAULT_SCENARIO_OPTIONS.switchHysteresisDegSec)),
    speedRangeToleranceDegSec: finite(o.speedRangeToleranceDegSec, finite(advanced.speedRangeToleranceDegSec, DEFAULT_SCENARIO_OPTIONS.speedRangeToleranceDegSec)),
    speedReadyTolerancePercent: tolerancePercent,
    speedStableTimeMs: Math.max(0, finite(o.speedStableTimeMs, finite(advanced.speedStableTimeMs, DEFAULT_SCENARIO_OPTIONS.speedStableTimeMs))),
    speedReachTimeoutMs: Math.max(1, finite(o.speedReachTimeoutMs, finite(advanced.speedReachTimeoutMs, DEFAULT_SCENARIO_OPTIONS.speedReachTimeoutMs))),
    protocolPollMaxHz: clamp(finite(o.protocolPollMaxHz, finite(advanced.rawDataPollHz, DEFAULT_SCENARIO_OPTIONS.protocolPollMaxHz)), 1, 30),
    speedReadyCriterion: readyCriterion(o.speedReadyCriterion || advanced.speedReadyCriterion || DEFAULT_SCENARIO_OPTIONS.speedReadyCriterion),
    rotationCommandMode: rotationMode(o.rotationCommandMode || advanced.rotationCommandMode || DEFAULT_SCENARIO_OPTIONS.rotationCommandMode),
  };
}

// Effective readiness criterion for a rotation command: MS is meaningless for JP, so JP always
// falls back to the software criterion regardless of the configured preference.
function effectiveReadyCriterion(options, commandMode) {
  const opts = options && options.speedReadyCriterion ? options : scenarioOptions(null, options);
  if (rotationMode(commandMode || opts.rotationCommandMode) === 'JP') return 'software';
  return opts.speedReadyCriterion;
}

// Ramp budget for reaching targetDegSec from currentDegSec: AC limits speeding up, DC limits
// slowing down; a sign reversal decelerates through zero first, then accelerates. Callers that
// omit current/deceleration get the legacy from-zero acceleration ramp.
function computeSpeedReachTimeoutMs(targetDegSec, accelerationDegSec2, reserveMs, currentDegSec, decelerationDegSec2) {
  const target = finite(targetDegSec, 0);
  const current = finite(currentDegSec, 0);
  const acceleration = Math.abs(finite(accelerationDegSec2, 0));
  const deceleration = Math.abs(finite(decelerationDegSec2, 0)) || acceleration;
  const reserve = Math.max(0, finite(reserveMs, 10000));
  let rampSec = 0;
  if (target === 0 || current === 0 || (target > 0) === (current > 0)) {
    const delta = Math.abs(target) - Math.abs(current);
    if (delta > 0) rampSec = acceleration > 0 ? delta / acceleration : 0;
    else rampSec = deceleration > 0 ? -delta / deceleration : 0;
  } else {
    rampSec = (deceleration > 0 ? Math.abs(current) / deceleration : 0)
      + (acceleration > 0 ? Math.abs(target) / acceleration : 0);
  }
  return Math.max(1, Math.ceil(rampSec * 1000 + reserve));
}

// Pure ramp time (no reserve) for the MS criterion phase 1.
function computeRampMs(targetDegSec, accelerationDegSec2, currentDegSec, decelerationDegSec2) {
  const target = finite(targetDegSec, 0);
  const current = finite(currentDegSec, 0);
  const acceleration = Math.abs(finite(accelerationDegSec2, 0));
  const deceleration = Math.abs(finite(decelerationDegSec2, 0)) || acceleration;
  let rampSec = 0;
  if (target === 0 || current === 0 || (target > 0) === (current > 0)) {
    const delta = Math.abs(target) - Math.abs(current);
    if (delta > 0) rampSec = acceleration > 0 ? delta / acceleration : 0;
    else rampSec = deceleration > 0 ? -delta / deceleration : 0;
  } else {
    rampSec = (deceleration > 0 ? Math.abs(current) / deceleration : 0)
      + (acceleration > 0 ? Math.abs(target) / acceleration : 0);
  }
  return Math.max(0, Math.ceil(rampSec * 1000));
}

// MS-based readiness (Appendix B item B1.3). Phase 'ramp': the profiler is still accelerating
// (elapsed < rampMs), MS is ignored. Phase 'ms_wait': ready as soon as the drive reports MS=0,
// OR when the measured speed stays inside the TR[3] window for TR[4] ms (stand finding
// 2026-09-17: for continuous JV the Platinum keeps MS=2 even at steady speed - table 5.2 gives
// MS=0 only when the target velocity command is zero - so the same window/dwell the drive
// would apply is evaluated here on VX). Neither by msTimeoutMs after the ramp -> timedOut.
//   options.measuredDegSec / targetDegSec / windowDegSec (TR[3]) / windowMs (TR[4])
function evaluateMsReady(state, ms, nowMs, options) {
  const o = options || {};
  const prev = state || {};
  const now = finite(nowMs, Date.now());
  const startedAt = prev.startedAt || now;
  const rampMs = Math.max(0, finite(prev.rampMs, finite(o.rampMs, 0)));
  const timeoutMs = Math.max(1, finite(o.msTimeoutMs, DEFAULT_SCENARIO_OPTIONS.speedReachTimeoutMs));
  const rampEndsAt = startedAt + rampMs;
  const deadlineAt = rampEndsAt + timeoutMs;
  const msValue = Number(ms);
  const msKnown = ms !== null && ms !== undefined && Number.isFinite(msValue);
  const inRamp = now < rampEndsAt;

  const measured = Number(o.measuredDegSec);
  const target = Number(o.targetDegSec);
  const windowDegSec = Math.abs(finite(o.windowDegSec, 0));
  const windowMs = Math.max(0, finite(o.windowMs, 0));
  const windowKnown = Number.isFinite(measured) && Number.isFinite(target) && windowDegSec > 0;
  const inWindow = windowKnown && Math.abs(measured - target) <= windowDegSec;
  const inWindowSince = !inRamp && inWindow ? (prev.inWindowSince || now) : null;
  const inWindowMs = inWindowSince ? now - inWindowSince : 0;

  const readyByMs = !inRamp && msKnown && msValue === 0;
  const readyByWindow = !inRamp && inWindow && inWindowMs >= windowMs;
  const ready = readyByMs || readyByWindow;
  const timedOut = !ready && now >= deadlineAt;
  return {
    startedAt,
    rampMs,
    rampEndsAt,
    deadlineAt,
    phase: inRamp ? 'ramp' : 'ms_wait',
    ms: msKnown ? msValue : null,
    inWindow,
    inWindowSince,
    inWindowMs,
    errorDegSec: windowKnown ? Math.abs(measured - target) : null,
    readyBy: readyByMs ? 'ms' : (readyByWindow ? 'window' : null),
    ready,
    timedOut,
  };
}

function speedAllowedInRange(speedDegSec, resolution, options) {
  const opts = options && options.ranges ? options : scenarioOptions(null, options);
  const absSpeed = Math.abs(finite(speedDegSec, 0));
  const range = opts.ranges[resolution] || opts.ranges.high;
  if (absSpeed === 0) return { ok: true };
  if (resolution === 'low' && absSpeed > 360) {
    return { ok: false, reason: 'above_low_absolute_max' };
  }
  const tol = Math.max(0, finite(opts.speedRangeToleranceDegSec, DEFAULT_SCENARIO_OPTIONS.speedRangeToleranceDegSec));
  const min = Math.max(0, range.minDeg - tol);
  const max = resolution === 'low' && range.maxDeg >= 360 ? 360 : range.maxDeg + tol;
  if (absSpeed < min) return { ok: false, reason: 'below_min', minDeg: range.minDeg, toleranceDegSec: tol };
  if (absSpeed > max) return { ok: false, reason: 'above_max', maxDeg: range.maxDeg, toleranceDegSec: tol };
  return { ok: true };
}

function selectResolutionForSpeed(speedDegSec, currentResolution, settings, override) {
  const opts = scenarioOptions(settings, override);
  const absSpeed = Math.abs(finite(speedDegSec, 0));
  const current = currentResolution === 'low' ? 'low' : (currentResolution === 'high' ? 'high' : null);
  if (absSpeed > 360) {
    return { ok: false, resolution: null, reason: 'above_low_absolute_max', absSpeedDegSec: absSpeed };
  }
  if (absSpeed === 0) {
    return { ok: true, resolution: current || 'high', changed: false, absSpeedDegSec: absSpeed, options: opts };
  }

  const boundary = opts.switchBoundaryDegSec;
  const hyst = opts.switchHysteresisDegSec;
  let selected;
  if (current === 'high') selected = absSpeed <= boundary + hyst ? 'high' : 'low';
  else if (current === 'low') selected = absSpeed >= boundary - hyst ? 'low' : 'high';
  else selected = absSpeed <= boundary ? 'high' : 'low';

  let allowed = speedAllowedInRange(absSpeed, selected, opts);
  if (!allowed.ok) {
    const other = selected === 'high' ? 'low' : 'high';
    const otherAllowed = speedAllowedInRange(absSpeed, other, opts);
    if (otherAllowed.ok) {
      selected = other;
      allowed = otherAllowed;
    } else {
      return { ok: false, resolution: selected, reason: allowed.reason, absSpeedDegSec: absSpeed, options: opts };
    }
  }

  return {
    ok: true,
    resolution: selected,
    changed: !!current && current !== selected,
    absSpeedDegSec: absSpeed,
    options: opts,
  };
}

function stripComment(line) {
  const idx = line.indexOf('#');
  return idx >= 0 ? line.slice(0, idx) : line;
}

function parseScenarioText(text, options) {
  const lines = String(text == null ? '' : text).replace(/\r/g, '').split('\n');
  const meta = {};
  const steps = [];
  let inSteps = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed[0] === '#') continue;
    if (/^-{3,}$/.test(trimmed)) {
      inSteps = true;
      continue;
    }
    if (trimmed === '=====') continue;

    const data = stripComment(raw).trim();
    if (!data) continue;
    const parts = data.split(/\s+/);
    if (!inSteps) {
      if (parts.length >= 2) meta[parts[0]] = parts.slice(1).join(' ');
      continue;
    }
    if (parts.length < 2) {
      throw new Error('Scenario line ' + (i + 1) + ': expected speed and hold time');
    }
    const speed = Number(parts[0].replace(',', '.'));
    const hold = Number(parts[1].replace(',', '.'));
    if (!Number.isFinite(speed)) throw new Error('Scenario line ' + (i + 1) + ': invalid speed');
    if (!Number.isFinite(hold) || hold <= 0) throw new Error('Scenario line ' + (i + 1) + ': invalid hold time');
    steps.push({ speed_deg_per_sec: speed, hold_sec: hold });
  }
  if (!steps.length) throw new Error('Scenario contains no steps');
  return { meta, steps };
}

function normalizeScenario(text, currentResolution, settings, override) {
  const parsed = parseScenarioText(text, override);
  let resolution = currentResolution === 'low' ? 'low' : 'high';
  const steps = parsed.steps.map((step, index) => {
    const selected = selectResolutionForSpeed(step.speed_deg_per_sec, resolution, settings, override);
    if (!selected.ok) {
      throw new Error('Scenario step ' + (index + 1) + ': speed ' + step.speed_deg_per_sec + ' deg/s is outside encoder ranges');
    }
    resolution = selected.resolution;
    return {
      ...step,
      resolution,
      speed_ticks: degPerSecToTicks(step.speed_deg_per_sec, resolution),
      range_switch_required: selected.changed,
    };
  });
  return { meta: parsed.meta, steps };
}

function evaluateSpeedReady(state, measuredDegSec, targetDegSec, nowMs, settings, override) {
  const opts = scenarioOptions(settings, override);
  const prev = state || {};
  const now = finite(nowMs, Date.now());
  const startedAt = prev.startedAt || now;
  const target = finite(targetDegSec, 0);
  const errorDegSec = Math.abs(finite(measuredDegSec, 0) - target);
  const toleranceDegSec = Math.abs(target) * opts.speedReadyTolerancePercent / 100;
  const errorPercent = Math.abs(target) > 0 ? errorDegSec / Math.abs(target) * 100 : (errorDegSec === 0 ? 0 : Infinity);
  const withinTolerance = errorDegSec <= toleranceDegSec;
  const stableSince = withinTolerance ? (prev.stableSince || now) : null;
  const stableMs = stableSince ? now - stableSince : 0;
  const ready = withinTolerance && stableMs >= opts.speedStableTimeMs;
  const timedOut = !ready && now - startedAt >= opts.speedReachTimeoutMs;
  return {
    startedAt,
    stableSince,
    stableMs,
    errorDegSec,
    errorPercent,
    toleranceDegSec,
    tolerancePercent: opts.speedReadyTolerancePercent,
    withinTolerance,
    ready,
    timedOut,
  };
}

module.exports = {
  DEFAULT_SPEED_RANGES,
  DEFAULT_SCENARIO_OPTIONS,
  scenarioOptions,
  speedAllowedInRange,
  selectResolutionForSpeed,
  computeSpeedReachTimeoutMs,
  computeRampMs,
  evaluateMsReady,
  effectiveReadyCriterion,
  normalizeScenarioFileName,
  listScenarioFiles,
  parseScenarioText,
  normalizeScenario,
  evaluateSpeedReady,
};
