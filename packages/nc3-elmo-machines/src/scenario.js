'use strict';

const fs = require('fs');
const path = require('path');
const { degPerSecToTicks, vh2MapDegPerSec } = require('./res');

// Speed limits come from the drive alone (VH[2] of each head pair). The software no longer
// carries custom per-pair ranges or a hand-entered switch boundary: the high pair is used while
// |speed| fits its VH[2], above that the low pair is required. Only the hysteresis around that
// boundary stays configurable. Speed may be negative (reverse rotation) — everything compares
// absolute values.
const DEFAULT_SCENARIO_OPTIONS = {
  switchHysteresisDegSec: 5,
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

function scenarioOptions(settings, override) {
  const advanced = (settings && settings.advanced) || {};
  const general = (settings && settings.general) || {};
  const o = override || {};
  // VH[2] по парам головок: номинал из таблицы RES, поверх — значения, прочитанные из привода.
  const vh2 = vh2MapDegPerSec(o.driveVh2Ticks || advanced.driveVh2Ticks);
  const tolerancePercent = clamp(
    finite(o.speedReadyTolerancePercent, finite(general.speedReadyTolerancePercent, DEFAULT_SCENARIO_OPTIONS.speedReadyTolerancePercent)),
    0,
    100
  );
  return {
    // maxDeg каждой пары = её VH[2]; минимума нет (0 — остановка), знак задаёт направление.
    vh2DegSec: vh2,
    switchBoundaryDegSec: vh2.high,
    switchHysteresisDegSec: Math.max(0, finite(o.switchHysteresisDegSec, finite(advanced.encoderSwitchHysteresisDegSec, DEFAULT_SCENARIO_OPTIONS.switchHysteresisDegSec))),
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
  const inWindowSince = inWindow ? (prev.inWindowSince || now) : null;
  const inWindowMs = inWindowSince ? now - inWindowSince : 0;

  // Window readiness is not gated by the ramp: the actual speed cannot sit inside the window of
  // the target before the ramp really ends, so an over-estimated ramp (stale "current speed")
  // must not delay it. MS=0 counts only when no VX is available: after ST the drive reports
  // MS=0 with the JV setpoint still stored, which is NOT "at speed".
  const readyByMs = !inRamp && !windowKnown && msKnown && msValue === 0;
  const readyByWindow = inWindow && inWindowMs >= windowMs;
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

// |speed| must not exceed VH[2] of the pair: the drive would silently cap it anyway
// (Remarks 11.09.2026 item 6). There is no lower limit — 0 is a stop, the sign is direction.
function speedAllowedInRange(speedDegSec, resolution, options) {
  const opts = options && options.vh2DegSec ? options : scenarioOptions(null, options);
  const absSpeed = Math.abs(finite(speedDegSec, 0));
  const maxDeg = opts.vh2DegSec[resolution === 'low' ? 'low' : 'high'];
  if (absSpeed === 0) return { ok: true };
  if (absSpeed > maxDeg) return { ok: false, reason: 'above_vh2', maxDeg: maxDeg };
  return { ok: true };
}

// Пара головок выбирается по VH[2] высокой пары: пока |скорость| укладывается в него — высокое
// разрешение, выше — низкое. Гистерезис не даёт «дребезжать» на самой границе: с высокой пары
// уходим строго выше VH[2], обратно возвращаемся, опустившись на гистерезис ниже.
function selectResolutionForSpeed(speedDegSec, currentResolution, settings, override) {
  const opts = scenarioOptions(settings, override);
  const absSpeed = Math.abs(finite(speedDegSec, 0));
  const current = currentResolution === 'low' ? 'low' : (currentResolution === 'high' ? 'high' : null);
  if (absSpeed > opts.vh2DegSec.low) {
    return { ok: false, resolution: null, reason: 'above_vh2', maxDeg: opts.vh2DegSec.low, absSpeedDegSec: absSpeed, options: opts };
  }
  if (absSpeed === 0) {
    return { ok: true, resolution: current || 'high', changed: false, absSpeedDegSec: absSpeed, options: opts };
  }

  const boundary = opts.switchBoundaryDegSec;
  const hyst = opts.switchHysteresisDegSec;
  let selected;
  if (current === 'high') selected = absSpeed <= boundary ? 'high' : 'low';
  else if (current === 'low') selected = absSpeed <= Math.max(0, boundary - hyst) ? 'high' : 'low';
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
