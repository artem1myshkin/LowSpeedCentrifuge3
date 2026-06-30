'use strict';

// Minimal scalar extraction from a raw ELMO Direct Access response, ONLY for the fields the
// transport needs for its own control decisions (poll rate, current range). This is NOT a
// replacement for ResponseParser (which builds the full UI drive_state) — the raw response
// is still forwarded downstream to ResponseParser unchanged (plan §4.6).
//
// ELMO answers in `PARAM=VALUE`, `PARAM;VALUE`, or observed `PARAM\rVALUE` form.
// The parser tokenizes the whole response and uses the last value for duplicate fields.

function parseNumber(value) {
  const v = Number(String(value == null ? '' : value).trim());
  return Number.isFinite(v) ? v : undefined;
}

function setScalar(out, param, value) {
  const p = String(param || '').trim().toUpperCase();
  const v = parseNumber(value);
  if (v === undefined) return false;
  switch (p) {
    case 'TM': out.tm = v; return true;
    case 'PX': out.px = v; return true;
    case 'VX': out.vx = v; return true;
    case 'MS': out.ms = v; return true;
    case 'MO': out.mo = v; return true;
    case 'SO': out.so = v; return true;
    case 'SR': out.sr = v; return true;
    case 'AF': out.af = v; return true;
    case 'OL[1]':
      out.ol1 = v;
      out.resolution = v === 1 ? 'low' : 'high';
      return true;
    case 'OL[2]': out.ol2 = v; return true;
    case 'KP[2]': out.kp2 = v; return true;
    default:
      return false;
  }
}

// Returns only the keys that were present in the response.
function parseElmoScalars(raw) {
  const text = String(raw == null ? '' : raw)
    .replace(/\u0000/g, '')
    .replace(/^"+|"+$/g, '')
    .replace(/[\r\n]+/g, ';');
  const tokens = text.split(';').map((s) => s.trim()).filter(Boolean);
  const out = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const eq = token.indexOf('=');
    if (eq !== -1) {
      setScalar(out, token.slice(0, eq), token.slice(eq + 1));
      continue;
    }
    if (i + 1 < tokens.length && tokens[i + 1].indexOf('=') === -1) {
      if (setScalar(out, token, tokens[i + 1])) i++;
    }
  }
  return out;
}

module.exports = { parseElmoScalars };
