'use strict';

const { createElmoTransport, startElmoTransport } = require('./elmoTransport');
const { createFrameSplitter } = require('./frameSplitter');
const { parseElmoScalars } = require('./parse');
const res = require('./res');
const queue = require('./queue');
const poll = require('./poll');
const util = require('./util');

module.exports = {
  createElmoTransport,
  startElmoTransport,
  createFrameSplitter,
  parseElmoScalars,
  // helpers (also useful for the Node-RED glue layer and tests)
  RES: res.RES,
  ticksPerRev: res.ticksPerRev,
  ticksPerDeg: res.ticksPerDeg,
  degPerSecToTicks: res.degPerSecToTicks,
  priorityInsert: queue.priorityInsert,
  dequeue: queue.dequeue,
  PRIORITY: queue.PRIORITY,
  DATA_POLL: poll.DATA_POLL,
  buildPollEnvelope: poll.buildPollEnvelope,
  buildStatePoll: poll.buildStatePoll,
  buildFullStatePoll: poll.buildFullStatePoll,
  computePollDelayMs: poll.computePollDelayMs,
  omegaDegPerSec: poll.omegaDegPerSec,
  computeRateHz: poll.computeRateHz,
  ensureCr: util.ensureCr,
};
