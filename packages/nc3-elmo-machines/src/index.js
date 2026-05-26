'use strict';

const { createElmoTransport } = require('./elmoTransport');
const { createFrameSplitter } = require('./frameSplitter');
const res = require('./res');
const queue = require('./queue');
const poll = require('./poll');
const util = require('./util');

module.exports = {
  createElmoTransport,
  createFrameSplitter,
  // helpers (also useful for the Node-RED glue layer and tests)
  RES: res.RES,
  ticksPerRev: res.ticksPerRev,
  ticksPerDeg: res.ticksPerDeg,
  degPerSecToTicks: res.degPerSecToTicks,
  priorityInsert: queue.priorityInsert,
  dequeue: queue.dequeue,
  PRIORITY: queue.PRIORITY,
  buildPollEnvelope: poll.buildPollEnvelope,
  computePollDelayMs: poll.computePollDelayMs,
  omegaDegPerSec: poll.omegaDegPerSec,
  computeRateHz: poll.computeRateHz,
  ensureCr: util.ensureCr,
};
