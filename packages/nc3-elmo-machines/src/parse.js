'use strict';

// Minimal scalar extraction from a raw ELMO Direct Access response, ONLY for the fields the
// transport needs for its own control decisions (poll rate, current range). This is NOT a
// replacement for ResponseParser (which builds the full UI drive_state) — the raw response
// is still forwarded downstream to ResponseParser unchanged (plan §4.6).
//
// ELMO answers in `PARAM=VALUE`, `PARAM;VALUE`, or observed `PARAM\rVALUE` form.

function matchScalar(raw, name) {
  // name may contain regex-special chars like OL[1]
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc + '(?:\\s*[=;]\\s*|\\s+)(-?[0-9][0-9.eE+-]*)');
  const m = re.exec(raw);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

// Returns only the keys that were present in the response.
function parseElmoScalars(raw) {
  const text = String(raw == null ? '' : raw);
  const out = {};
  const vx = matchScalar(text, 'VX');
  if (vx !== undefined) out.vx = vx;
  const ol1 = matchScalar(text, 'OL[1]');
  if (ol1 !== undefined) {
    out.ol1 = ol1;
    out.resolution = ol1 === 1 ? 'low' : 'high';
  }
  const so = matchScalar(text, 'SO');
  if (so !== undefined) out.so = so;
  const ms = matchScalar(text, 'MS');
  if (ms !== undefined) out.ms = ms;
  const sr = matchScalar(text, 'SR');
  if (sr !== undefined) out.sr = sr;
  return out;
}

module.exports = { parseElmoScalars };
