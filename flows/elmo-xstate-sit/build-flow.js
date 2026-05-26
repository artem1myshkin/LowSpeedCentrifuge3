'use strict';

// Generates an importable Node-RED flow (a new tab) wiring the ElmoTransport XState actor
// to ONE tcp request node in sit mode (kept-open) + a FrameSplitter, in parallel to the
// existing ELMO nodes (plan §4.9 step 1). Node glue is thin: heavy logic is in the
// nc3-elmo-machines package. Run:  node flows/elmo-xstate-sit/build-flow.js
//
// Output: flows/elmo-xstate-sit.flow.json  (import via Node-RED editor -> Import).

const fs = require('fs');
const path = require('path');

const ELMO_HOST = '192.168.1.2';
const ELMO_PORT = '2000';

const transportInit = `
const { createActor } = xstateLib;
const { createElmoTransport } = nc3;

function ensureCr(c) { const t = String(c == null ? '' : c); return t.endsWith('\\r') ? t : t + '\\r'; }

const ckpt = context.get('elmo_checkpoint', 'file') || {};

const machine = createElmoTransport({
    // out0 -> tcp request (sit). resetTcp uses msg.reset to force reconnect.
    sendTcp: function (cmd) { node.send([{ payload: ensureCr(cmd) }, null, null]); },
    resetTcp: function () { node.send([{ reset: true }, null, null]); },
    // out1 -> ResponseParser (here: debug). Restore logical topic (poll -> poll_data).
    forwardResp: function (raw, topic) { node.send([null, { topic: topic || 'poll_data', payload: raw }, null]); },
    // out2 -> domain events (CMD.ACKED/FAILED, ...).
    emitEvent: function (evt) { node.send([null, null, { topic: evt.type, payload: evt }]); },
    setStatus: function (st) { node.status(st); },
    timeoutMs: 1000,
    connectTimeoutMs: 2000,
    statePeriodMs: 1000
});

const actor = createActor(machine, { input: { resolution: ckpt.resolution || 'high' } }).start();

let lastRes = ckpt.resolution || null;
actor.subscribe(function (snap) {
    context.set('transport_state', snap.value);
    const r = snap.context.resolution;
    if (r && r !== lastRes) { context.set('elmo_checkpoint', { resolution: r }, 'file'); lastRes = r; }
});

context.set('elmoActor', actor);

// Kick connect + self-clocked poll AFTER On Start completes.
const ct = setTimeout(function () {
    const a = context.get('elmoActor');
    if (a) a.send({ type: 'CONNECT' });
}, 0);
context.set('connectTimer', ct);
`.trim();

const transportFunc = `
const actor = context.get('elmoActor');
if (!actor) { node.error('ElmoTransport actor not initialized', msg); return null; }

if (msg.elmo_raw === true) { actor.send({ type: 'ELMO.RESP', raw: msg.payload }); return null; }
if (msg.topic === 'CONNECT') { actor.send({ type: 'CONNECT' }); return null; }
if (msg.topic === 'POLL.TICK') { actor.send({ type: 'POLL.TICK' }); return null; }

// Bring-up: msg.payload as a raw ELMO command string (e.g. "VX").
if (typeof msg.payload === 'string' && msg.payload.length) {
    actor.send({ type: 'UI.CMD', envelope: { kind: 'cmd', cmd: msg.payload, meta: { topic: msg.topic || 'manual' } } });
}
return null;
`.trim();

const transportStop = `
const actor = context.get('elmoActor');
if (actor) actor.stop();
const ct = context.get('connectTimer');
if (ct) clearTimeout(ct);
`.trim();

const splitterInit = `
const { createFrameSplitter } = nc3;
// Stand bring-up: terminator '\\r' is the candidate end-of-frame (confirm on stand, §11.1).
context.set('splitter', createFrameSplitter({ terminator: '\\r' }));
`.trim();

const splitterFunc = `
const splitter = context.get('splitter');
if (!splitter) { node.error('FrameSplitter not initialized', msg); return null; }

const frames = splitter.push(msg.payload);
for (let i = 0; i < frames.length; i++) {
    node.send({ elmo_raw: true, payload: frames[i] });
}

// Idle-gap fallback: if the terminator is wrong/unknown, flush the buffered remainder
// after a short silence so bring-up still produces frames (single in-flight => safe).
let t = context.get('idleTimer');
if (t) clearTimeout(t);
t = setTimeout(function () {
    const s = context.get('splitter');
    const rem = s && s.flush();
    if (rem != null && rem.length) node.send({ elmo_raw: true, payload: rem });
}, 15);
context.set('idleTimer', t);
return null;
`.trim();

const splitterStop = `
const t = context.get('idleTimer');
if (t) clearTimeout(t);
`.trim();

const TAB = 'elmoxs-tab';

const nodes = [
  {
    id: TAB,
    type: 'tab',
    label: 'ELMO XState (sit)',
    disabled: false,
    info: 'Parallel bring-up of the ElmoTransport XState actor over one tcp request (sit). Does not replace existing ELMO nodes. See docs/xstate-integration-plan.md §4.9.',
  },
  {
    id: 'elmoxs-transport',
    type: 'function',
    z: TAB,
    name: 'ElmoTransport',
    func: transportFunc,
    outputs: 3,
    timeout: 0,
    noerr: 0,
    initialize: transportInit,
    finalize: transportStop,
    libs: [
      { var: 'xstateLib', module: 'xstate' },
      { var: 'nc3', module: 'nc3-elmo-machines' },
    ],
    x: 470,
    y: 160,
    wires: [['elmoxs-tcp'], ['elmoxs-dbg-resp'], ['elmoxs-dbg-evt']],
  },
  {
    id: 'elmoxs-tcp',
    type: 'tcp request',
    z: TAB,
    name: 'ELMO tcp (sit)',
    server: ELMO_HOST,
    port: ELMO_PORT,
    out: 'sit',
    ret: 'string',
    splitc: '',
    newline: '',
    trim: false,
    tls: '',
    x: 700,
    y: 120,
    wires: [['elmoxs-splitter']],
  },
  {
    id: 'elmoxs-splitter',
    type: 'function',
    z: TAB,
    name: 'FrameSplitter',
    func: splitterFunc,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: splitterInit,
    finalize: splitterStop,
    libs: [{ var: 'nc3', module: 'nc3-elmo-machines' }],
    x: 700,
    y: 220,
    wires: [['elmoxs-transport']],
  },
  {
    id: 'elmoxs-inject',
    type: 'inject',
    z: TAB,
    name: 'manual cmd (VX)',
    props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }],
    repeat: '',
    crontab: '',
    once: false,
    onceDelay: 0.1,
    topic: 'manual',
    payload: 'VX',
    payloadType: 'str',
    x: 230,
    y: 160,
    wires: [['elmoxs-transport']],
  },
  {
    id: 'elmoxs-dbg-resp',
    type: 'debug',
    z: TAB,
    name: 'forwarded resp (out1)',
    active: true,
    tosidebar: true,
    console: false,
    complete: 'true',
    targetType: 'full',
    statusVal: '',
    statusType: 'auto',
    x: 720,
    y: 360,
    wires: [],
  },
  {
    id: 'elmoxs-dbg-evt',
    type: 'debug',
    z: TAB,
    name: 'transport events (out2)',
    active: true,
    tosidebar: true,
    console: false,
    complete: 'payload',
    targetType: 'msg',
    statusVal: '',
    statusType: 'auto',
    x: 730,
    y: 420,
    wires: [],
  },
];

const outPath = path.join(__dirname, '..', 'elmo-xstate-sit.flow.json');
fs.writeFileSync(outPath, JSON.stringify(nodes, null, 2) + '\n', 'utf8');
console.log('Wrote', outPath, '(' + nodes.length + ' nodes)');
