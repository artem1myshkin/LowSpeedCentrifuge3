'use strict';

// FrameSplitter for sit-mode (kept-open) TCP: the response arrives as a byte stream that
// may be chunked and is not auto-split by terminator (plan §4.4.3 / §4.6). This pure helper
// accumulates chunks and yields complete frames split on a terminator (default CR).
//
// The Node-RED glue adds the idle-gap flush timer: if the terminator is wrong/unknown,
// flush() emits the buffered remainder after a short silence so bring-up still works.
function createFrameSplitter(opts) {
  const o = opts || {};
  const terminator = o.terminator == null ? '\r' : o.terminator;
  const stripTerminator = o.stripTerminator !== false; // default true
  let buf = '';

  return {
    // Append a chunk; return any complete frames (terminator removed by default).
    push(chunk) {
      buf += (chunk == null ? '' : String(chunk));
      const frames = [];
      if (terminator === '') return frames;
      let idx;
      while ((idx = buf.indexOf(terminator)) >= 0) {
        const end = stripTerminator ? idx : idx + terminator.length;
        frames.push(buf.slice(0, end));
        buf = buf.slice(idx + terminator.length);
      }
      return frames;
    },

    // Emit whatever is buffered (used by idle-gap flush). Returns null if empty.
    flush() {
      if (buf.length === 0) return null;
      const r = buf;
      buf = '';
      return r;
    },

    reset() {
      buf = '';
    },

    get pending() {
      return buf;
    },
  };
}

module.exports = { createFrameSplitter };
