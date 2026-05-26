'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFrameSplitter } = require('../src/frameSplitter');

test('splits on terminator across chunks, strips terminator', () => {
  const fs = createFrameSplitter({ terminator: '\r' });
  assert.deepEqual(fs.push('TM=1;PX=2;'), []); // no terminator yet
  assert.deepEqual(fs.push('VX=0;\r'), ['TM=1;PX=2;VX=0;']);
  assert.equal(fs.pending, '');
});

test('emits multiple frames from one chunk', () => {
  const fs = createFrameSplitter({ terminator: '\r' });
  assert.deepEqual(fs.push('A\rB\rC'), ['A', 'B']);
  assert.equal(fs.pending, 'C');
});

test('flush returns the buffered remainder (idle-gap fallback)', () => {
  const fs = createFrameSplitter({ terminator: '\r' });
  fs.push('partial-no-term');
  assert.equal(fs.flush(), 'partial-no-term');
  assert.equal(fs.flush(), null);
});

test('reset clears the buffer', () => {
  const fs = createFrameSplitter({ terminator: '\r' });
  fs.push('stale');
  fs.reset();
  assert.equal(fs.pending, '');
  assert.equal(fs.flush(), null);
});

test('keeps terminator when stripTerminator=false', () => {
  const fs = createFrameSplitter({ terminator: '\n', stripTerminator: false });
  assert.deepEqual(fs.push('x\n'), ['x\n']);
});
