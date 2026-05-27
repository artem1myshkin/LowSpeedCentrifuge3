'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseElmoScalars } = require('../src/parse');

test('parses PARAM=VALUE form', () => {
  assert.deepEqual(parseElmoScalars('VX=728177;'), { vx: 728177 });
});

test('parses PARAM;VALUE form', () => {
  assert.deepEqual(parseElmoScalars('VX;-3640888;'), { vx: -3640888 });
});

test('parses observed PARAM CR VALUE form', () => {
  assert.deepEqual(parseElmoScalars('VX\r0.000000e+00;'), { vx: 0 });
  assert.deepEqual(parseElmoScalars('OL[1]\r1;'), { ol1: 1, resolution: 'low' });
});

test('OL[1] maps to resolution', () => {
  assert.deepEqual(parseElmoScalars('OL[1]=1;'), { ol1: 1, resolution: 'low' });
  assert.deepEqual(parseElmoScalars('OL[1];0;'), { ol1: 0, resolution: 'high' });
});

test('extracts multiple fields from a poll response, omits absent ones', () => {
  const f = parseElmoScalars('TM=12345;PX=678;VX=90;MS=0;MO=1;SO=1;SR=0;OL[1]=0;');
  assert.equal(f.tm, 12345);
  assert.equal(f.px, 678);
  assert.equal(f.vx, 90);
  assert.equal(f.mo, 1);
  assert.equal(f.so, 1);
  assert.equal(f.ms, 0);
  assert.equal(f.sr, 0);
  assert.equal(f.ol1, 0);
  assert.equal(f.resolution, 'high');
});

test('uses the last value when a response contains duplicate scalar fields', () => {
  const f = parseElmoScalars('MS;3;MO;0;SO;0;MS;0;MO;1;SO;1;');
  assert.equal(f.ms, 0);
  assert.equal(f.mo, 1);
  assert.equal(f.so, 1);
});

test('does not consume the next parameter when a value is missing', () => {
  const f = parseElmoScalars('TM;PX;-6.690000e+03;VX;9.000000e+00;');
  assert.equal(f.tm, undefined);
  assert.equal(f.px, -6690);
  assert.equal(f.vx, 9);
});

test('returns {} for ack-only / empty responses', () => {
  assert.deepEqual(parseElmoScalars(';'), {});
  assert.deepEqual(parseElmoScalars(''), {});
  assert.deepEqual(parseElmoScalars(null), {});
});
