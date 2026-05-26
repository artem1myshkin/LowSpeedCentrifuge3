'use strict';

// Resolution constants for the ELMO encoder head pairs (manual section 4, table 4.1).
// Mirrors CommandHandler.RES in flows.json so the transport and scenario share one source
// of truth for ticks/rev, range limits and the set_resolution command set.

const RES = {
  high: {
    ol1: 0,
    ca18: 262144000,
    s1_5: 50000000,
    kp2: 1e-6,
    sd: 131072000,
    qs: 131072000,
    vh1: 131072000,
    vl1: 131072000,
    vh2: 3640888,
    er3: 131072000,
    er2: 131072000,
    tr1: 7282,
    tr3: 364089,
    sp_def: 728177,
    ac_def: 364088,
  },
  low: {
    ol1: 1,
    ca18: 6553600,
    s1_5: 7662835,
    kp2: 1e-5,
    sd: 3276800,
    qs: 3276800,
    vh1: 3276800,
    vl1: 3276800,
    vh2: 6553600,
    er3: 3276800,
    er2: 3276800,
    tr1: 182,
    tr3: 9102,
    sp_def: 18204,
    ac_def: 9102,
  },
};

function resKey(resolution) {
  return resolution === 'low' ? 'low' : 'high';
}

function ticksPerRev(resolution) {
  return RES[resKey(resolution)].ca18;
}

function ticksPerDeg(resolution) {
  return ticksPerRev(resolution) / 360;
}

function degPerSecToTicks(degPerSec, resolution) {
  return Math.round(degPerSec * ticksPerDeg(resolution));
}

module.exports = { RES, resKey, ticksPerRev, ticksPerDeg, degPerSecToTicks };
