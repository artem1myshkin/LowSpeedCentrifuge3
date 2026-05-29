'use strict';

// ELMO Direct Access commands must end with CR. The transport keeps logical command
// strings without a trailing CR (§4.2); the I/O effect normalizes before send.
function ensureCr(cmd) {
  const text = String(cmd == null ? '' : cmd);
  return text.endsWith('\r') ? text : text + '\r';
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function splitElmoCommands(cmd) {
  if (Array.isArray(cmd)) {
    return cmd.map((part) => String(part == null ? '' : part).trim()).filter(Boolean);
  }
  return String(cmd == null ? '' : cmd)
    .replace(/\r+/g, ';')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

module.exports = { ensureCr, clamp, splitElmoCommands };
