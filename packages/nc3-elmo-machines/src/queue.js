'use strict';

// Single serialized request queue (§4.2).
// Priority: cmd/init(3) > fast raw poll(2.5) > tilt(2) > regular poll(1).
// Stable FIFO within the same priority.

const PRIORITY = { cmd: 3, init: 3, fastPoll: 2.5, tilt: 2, poll: 1 };

function priorityOf(envelope) {
  if (envelope && typeof envelope.priority === 'number') return envelope.priority;
  return (envelope && PRIORITY[envelope.kind]) || 0;
}

// Insert keeping the queue sorted by priority desc, stable for equal priorities.
function priorityInsert(queue, envelope) {
  const next = queue.slice();
  const p = priorityOf(envelope);
  let i = next.length;
  while (i > 0 && priorityOf(next[i - 1]) < p) i--;
  next.splice(i, 0, envelope);
  return next;
}

function dequeue(queue) {
  if (queue.length === 0) return { inFlight: null, queue: [] };
  return { inFlight: queue[0], queue: queue.slice(1) };
}

function hasKind(queue, kind) {
  return queue.some((e) => e.kind === kind);
}

module.exports = { PRIORITY, priorityOf, priorityInsert, dequeue, hasKind };
