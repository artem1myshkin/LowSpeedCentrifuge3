'use strict';

const { createElmoTransport, startElmoTransport } = require('./elmoTransport');
const { parseElmoScalars } = require('./parse');
const res = require('./res');
const queue = require('./queue');
const poll = require('./poll');
const util = require('./util');
const scenario = require('./scenario');

module.exports = {
  createElmoTransport,
  startElmoTransport,
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
  estimateVelocityFromPositionSamples: poll.estimateVelocityFromPositionSamples,
  computeRateHz: poll.computeRateHz,
  ensureCr: util.ensureCr,
  splitElmoCommands: util.splitElmoCommands,
  DEFAULT_SPEED_RANGES: scenario.DEFAULT_SPEED_RANGES,
  DEFAULT_SCENARIO_OPTIONS: scenario.DEFAULT_SCENARIO_OPTIONS,
  scenarioOptions: scenario.scenarioOptions,
  speedAllowedInRange: scenario.speedAllowedInRange,
  selectResolutionForSpeed: scenario.selectResolutionForSpeed,
  computeSpeedReachTimeoutMs: scenario.computeSpeedReachTimeoutMs,
  computeRampMs: scenario.computeRampMs,
  evaluateMsReady: scenario.evaluateMsReady,
  effectiveReadyCriterion: scenario.effectiveReadyCriterion,
  normalizeScenarioFileName: scenario.normalizeScenarioFileName,
  listScenarioFiles: scenario.listScenarioFiles,
  parseScenarioText: scenario.parseScenarioText,
  normalizeScenario: scenario.normalizeScenario,
  evaluateSpeedReady: scenario.evaluateSpeedReady,
};
