#!/usr/bin/env node
'use strict';

// Per-machine bootstrap for the nc3-elmo-machines XState package.
// Run once on every machine after `git pull`:   node scripts/setup-nc3.js
//
// It installs the package's own dependencies (xstate) INSIDE the package folder only —
// it never touches the Node-RED userDir node_modules, so it cannot prune palette nodes.
// The package is then loaded by Node-RED via functionGlobalContext (see settings.js
// snippet printed below and docs/xstate-integration-plan.md §9.1).

const { execSync } = require('child_process');
const path = require('path');

const pkgDir = path.join(__dirname, '..', 'packages', 'nc3-elmo-machines');

console.log('[setup-nc3] Installing package dependencies in:\n  ' + pkgDir + '\n');
execSync('npm install --no-audit --no-fund', { cwd: pkgDir, stdio: 'inherit' });

console.log('\n[setup-nc3] Package deps installed.\n');
console.log('One-time per machine: add this to functionGlobalContext in <Node-RED userDir>/settings.js');
console.log('(the package is loaded BY PATH, so all logic travels via git; this is just a bootstrap):\n');
console.log("    nc3: (function () {");
console.log("        try { return require('./projects/LowSpeedCentrifuge3/packages/nc3-elmo-machines'); }");
console.log("        catch (e) { console.warn('[nc3-elmo-machines] ' + e.message); return undefined; }");
console.log("    })(),\n");
console.log('Then restart Node-RED. Verify: the ElmoTransport node status goes connecting -> online.');
