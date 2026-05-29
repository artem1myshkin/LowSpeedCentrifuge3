'use strict';

// Generates an importable Node-RED flow (a new tab) wiring the ElmoTransport XState actor to
// ELMO over UDP: `udp out` (one atomic command per datagram) + `udp in` -> a small change node
// that marks the datagram as an ELMO response -> the actor. There is NO FrameSplitter: a UDP
// datagram is already a complete frame, which is what lets this path reach ~30 Hz where the old
// TCP `sit` + idle-gap path capped at ~4 Hz. Node glue is thin; logic lives in nc3-elmo-machines.
//
// flows.json is the canonical runtime artifact; this generator reproduces the same tab (same node
// ids, so re-import replaces cleanly) for bring-up. Run:  node flows/elmo-xstate-udp/build-flow.js
// Output: flows/elmo-xstate-udp.flow.json  (import via Node-RED editor -> Import).

const fs = require('fs');
const path = require('path');

const ELMO_HOST = '192.168.1.2';
const ELMO_CMD_PORT = '5001';  // ELMO listens here (udp out -> ELMO)
const LOCAL_PORT = '5005';     // we bind here; ELMO replies here (udp in)

const TAB = 'elmoxs-tab';
const UDP_OUT_ID = '9eebec7a9fcbd4c5';
const UDP_IN_ID = '9dcb69eb8ba2c5f5';

const transportInit = `
// nc3-elmo-machines is exposed via functionGlobalContext in settings.js, NOT as a Function
// external module; it is a local package, not on the npm registry. xstate stays internal to nc3.
const nc3 = global.get('nc3');
if (!nc3 || typeof nc3.startElmoTransport !== 'function') {
    node.error('global.nc3 not available. Add nc3 to functionGlobalContext in settings.js (see docs/xstate-elmo-status.md, "How to test on the stand").');
    return;
}

function ensureCr(c) { const t = String(c == null ? '' : c); return t.endsWith('\\r') ? t : t + '\\r'; }
function debugTransport(evt) { if (context.get('transportDebug') === true) node.warn(evt); }
function finiteNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function readPollConfigFromGlobals() {
    const settings = global.get('settings') || {};
    const advanced = settings.advanced || {};
    return {
        isRecording: !!global.get('is_recording'),
        isRecordingRaw: !!global.get('is_recording_raw'),
        rawDataEnabled: !!global.get('recording_save_raw_data'),
        fastRawPollingEnabled: advanced.fastRawPollingEnabled !== false,
        normalPollHz: 2,
        fastRawPollHz: clamp(finiteNumber(advanced.rawDataPollHz, 30), 1, 30),
        fastStableSamples: Math.round(clamp(finiteNumber(advanced.fastStableSamples, 3), 1, 50)),
        fastStableToleranceTicks: Math.max(0, finiteNumber(advanced.fastStableToleranceTicks, 1000))
    };
}
function syncPollConfig(actor, force) {
    const cfg = context.get('pollConfigOverride') || readPollConfigFromGlobals();
    const json = JSON.stringify(cfg);
    if (force || context.get('pollConfigJson') !== json) {
        actor.send({ type: 'POLL.CONFIG', config: cfg });
        context.set('pollConfigJson', json);
    }
}

// Default (in-memory) context store; the checkpoint is only a pre-first-poll UI hint.
const ckpt = context.get('elmo_checkpoint') || {};
const initialPollConfig = readPollConfigFromGlobals();

// UDP transport: out0 -> udp out (one atomic command per datagram), out1 -> ResponseParser/
// debug, out2 -> domain events. No socket reset (UDP is connectionless); replies come via udp in.
const actor = nc3.startElmoTransport({
    sendCmd: function (cmd) { debugTransport({ tag: 'ELMO_TX', cmd: String(cmd == null ? '' : cmd) }); node.send([{ payload: ensureCr(cmd) }, null, null]); },
    forwardResp: function (raw, topic) { node.send([null, { topic: topic || 'poll_data', payload: raw }, null]); },
    emitEvent: function (evt) { node.send([null, null, { topic: evt.type, payload: evt }]); },
    setStatus: function (st) { node.status(st); },
    timeoutMs: 1000,
    connectTimeoutMs: 2000,
    reconnectMs: 1000,
    maxMisses: 3,
    statePeriodMs: 1000,
    pollOptions: { normalPollHz: 2, minHz: 1, maxHz: 30, timerCompensationMs: 8 }
}, { resolution: ckpt.resolution || 'high', pollConfig: initialPollConfig });

let lastRes = ckpt.resolution || null;
actor.subscribe(function (snap) {
    context.set('transport_state', snap.value);
    const r = snap.context.resolution;
    if (r && r !== lastRes) { context.set('elmo_checkpoint', { resolution: r }); lastRes = r; }
});

context.set('elmoActor', actor);
syncPollConfig(actor, true);

const pct = setInterval(function () {
    const a = context.get('elmoActor');
    if (a) syncPollConfig(a, false);
}, 500);
context.set('pollConfigTimer', pct);

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

function shortValue(value) {
    const s = String(value == null ? '' : value);
    return s.length > 300 ? s.slice(0, 300) + '...<truncated>' : s;
}
function debugTransport(evt) { if (context.get('transportDebug') === true) node.warn(evt); }
function finiteNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function readPollConfigFromGlobals() {
    const settings = global.get('settings') || {};
    const advanced = settings.advanced || {};
    return {
        isRecording: !!global.get('is_recording'),
        isRecordingRaw: !!global.get('is_recording_raw'),
        rawDataEnabled: !!global.get('recording_save_raw_data'),
        fastRawPollingEnabled: advanced.fastRawPollingEnabled !== false,
        normalPollHz: 2,
        fastRawPollHz: clamp(finiteNumber(advanced.rawDataPollHz, 30), 1, 30),
        fastStableSamples: Math.round(clamp(finiteNumber(advanced.fastStableSamples, 3), 1, 50)),
        fastStableToleranceTicks: Math.max(0, finiteNumber(advanced.fastStableToleranceTicks, 1000))
    };
}
function activePollConfig() { return context.get('pollConfigOverride') || readPollConfigFromGlobals(); }
function syncPollConfig(force) {
    const cfg = activePollConfig();
    const json = JSON.stringify(cfg);
    if (force || context.get('pollConfigJson') !== json) {
        actor.send({ type: 'POLL.CONFIG', config: cfg });
        context.set('pollConfigJson', json);
    }
}

if (msg.topic === 'POLL.CONFIG') {
    const cfg = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
    if (cfg.clearOverride === true) context.set('pollConfigOverride', null);
    else context.set('pollConfigOverride', cfg);
    syncPollConfig(true);
    actor.send({ type: 'POLL.TICK' });
    return null;
}

syncPollConfig(false);

// udp in -> change(elmo_raw=true) -> here: a complete reply datagram.
if (msg.elmo_raw === true) { actor.send({ type: 'ELMO.RESP', raw: msg.payload }); return null; }
if (msg.topic === 'CONNECT') { actor.send({ type: 'CONNECT' }); return null; }
if (msg.topic === 'POLL.TICK') { actor.send({ type: 'POLL.TICK' }); return null; }
if (msg.topic === 'POLL.FULL_STATE') { actor.send({ type: 'POLL.FULL_STATE' }); return null; }

// Any remaining string input becomes a UI.CMD; logical batches are split and reassembled
// inside nc3-elmo-machines (e.g. "MO=1;BG").
if (typeof msg.payload === 'string' && msg.payload.length) {
    const meta = (msg.elmo_meta && typeof msg.elmo_meta === 'object') ? Object.assign({}, msg.elmo_meta) : {};
    meta.topic = msg.elmo_topic || meta.topic || msg.topic || 'manual';
    if (msg.setpointDegS !== undefined && msg.setpointDegS !== null) meta.setpointDegS = Number(msg.setpointDegS);
    const kind = msg.elmo_kind || (msg.topic === 'tilt_brake' ? 'tilt' : 'cmd');
    debugTransport({ tag: 'INTO_TRANSPORT_UI_CMD', kind: kind, topic: meta.topic, payload: shortValue(msg.payload), _msgid: msg._msgid });
    actor.send({ type: 'UI.CMD', envelope: { kind: kind, cmd: msg.payload, meta: meta } });
    return null;
}

debugTransport({ tag: 'INTO_TRANSPORT_IGNORED_NON_RAW', topic: msg.topic, payloadType: typeof msg.payload, payload: shortValue(msg.payload), _msgid: msg._msgid });
return null;
`.trim();

const transportStop = `
const actor = context.get('elmoActor');
if (actor) actor.stop();
const ct = context.get('connectTimer');
if (ct) clearTimeout(ct);
const pct = context.get('pollConfigTimer');
if (pct) clearInterval(pct);
`.trim();

const rateMeterFunc = `
const now = Date.now();
const bucket = context.get('poll_rate_bucket') || { startedAt: now, counts: {} };
const topic = String(msg.topic || 'unknown');
bucket.counts[topic] = (bucket.counts[topic] || 0) + 1;
const elapsed = now - bucket.startedAt;
context.set('poll_rate_bucket', bucket);
if (elapsed < 1000) return null;

const counts = bucket.counts;
const total = Object.keys(counts).reduce(function (sum, key) { return sum + counts[key]; }, 0);
context.set('poll_rate_bucket', { startedAt: now, counts: {} });
return {
    topic: 'poll_rate',
    payload: {
        windowMs: elapsed,
        total: total,
        hz: Number((total * 1000 / elapsed).toFixed(2)),
        counts: counts
    }
};
`.trim();

function pollConfigInject(id, name, y, payload) {
  return {
    id,
    type: 'inject',
    z: TAB,
    name,
    props: [{ p: 'payload' }, { p: 'topic', vt: 'str' }],
    repeat: '',
    crontab: '',
    once: false,
    onceDelay: 0.1,
    topic: 'POLL.CONFIG',
    payload: JSON.stringify(payload),
    payloadType: 'json',
    x: 210,
    y,
    wires: [['elmoxs-transport']],
  };
}

function fastCfg(hz, recording) {
  return {
    isRecording: recording,
    isRecordingRaw: recording,
    rawDataEnabled: recording,
    fastRawPollingEnabled: true,
    normalPollHz: 2,
    fastRawPollHz: hz,
    fastStableSamples: 3,
    fastStableToleranceTicks: 1000,
  };
}

const nodes = [
  {
    id: TAB,
    type: 'tab',
    label: 'ELMO XState (UDP)',
    disabled: false,
    info: 'Parallel bring-up of the ElmoTransport XState actor over UDP (udp out/in, atomic per-parameter poll with reassembly). Does not replace existing ELMO nodes. See docs/xstate-elmo-design.md.',
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
    libs: [],
    x: 470,
    y: 160,
    // out0 cmd -> udp out; out1 resp -> parser/debug+meter; out2 events -> debug
    wires: [[UDP_OUT_ID], ['elmoxs-dbg-resp', 'elmoxs-rate-meter', 'elmoxs-link-resp-out'], ['elmoxs-dbg-evt', 'elmoxs-link-events-out']],
  },
  {
    id: 'elmoxs-link-cmd-in',
    type: 'link in',
    z: TAB,
    name: 'ELMO command bus in',
    links: ['bun-elmo-cmd-out', 'newui-tilt-elmo-cmd-out'],
    x: 210,
    y: 380,
    wires: [['elmoxs-transport']],
  },
  {
    id: 'elmoxs-link-resp-out',
    type: 'link out',
    z: TAB,
    name: 'ELMO response bus out',
    mode: 'link',
    links: ['7ea17c20dc6a19cc'],
    x: 735,
    y: 220,
    wires: [],
  },
  {
    id: 'elmoxs-link-events-out',
    type: 'link out',
    z: TAB,
    name: 'ELMO event bus out',
    mode: 'link',
    links: [],
    x: 735,
    y: 460,
    wires: [],
  },
  {
    id: 'elmoxs-udp-rx',
    type: 'change',
    z: TAB,
    name: 'mark elmo_raw',
    rules: [{ t: 'set', p: 'elmo_raw', pt: 'msg', to: 'true', tot: 'bool' }],
    action: '',
    property: '',
    from: '',
    to: '',
    reg: false,
    x: 690,
    y: 300,
    wires: [['elmoxs-transport']],
  },
  {
    id: UDP_OUT_ID,
    type: 'udp out',
    z: TAB,
    name: '',
    addr: ELMO_HOST,
    iface: '',
    port: ELMO_CMD_PORT,
    ipv: 'udp4',
    outport: LOCAL_PORT,
    base64: false,
    multicast: 'false',
    x: 680,
    y: 100,
    wires: [],
  },
  {
    id: UDP_IN_ID,
    type: 'udp in',
    z: TAB,
    name: '',
    iface: '',
    port: LOCAL_PORT,
    ipv: 'udp4',
    multicast: 'false',
    group: '',
    datatype: 'utf8',
    x: 500,
    y: 300,
    wires: [['elmoxs-udp-rx']],
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
  pollConfigInject('elmoxs-inject-poll-normal', 'poll mode: normal override', 40, fastCfg(1, false)),
  pollConfigInject('elmoxs-inject-poll-fast1', 'poll mode: raw fast 1Hz', 80, fastCfg(1, true)),
  pollConfigInject('elmoxs-inject-poll-fast10', 'poll mode: raw fast 10Hz', 120, fastCfg(10, true)),
  pollConfigInject('elmoxs-inject-poll-fast30', 'poll mode: raw fast 30Hz', 200, fastCfg(30, true)),
  pollConfigInject('elmoxs-inject-poll-settings', 'poll mode: settings/global', 240, { clearOverride: true }),
  {
    id: 'elmoxs-inject-poll-tick',
    type: 'inject',
    z: TAB,
    name: 'poll tick now',
    props: [{ p: 'topic', vt: 'str' }],
    repeat: '',
    crontab: '',
    once: false,
    onceDelay: 0.1,
    topic: 'POLL.TICK',
    x: 230,
    y: 280,
    wires: [['elmoxs-transport']],
  },
  {
    id: 'elmoxs-inject-fullstate',
    type: 'inject',
    z: TAB,
    name: 'poll full state once',
    props: [{ p: 'topic', vt: 'str' }],
    repeat: '',
    crontab: '',
    once: false,
    onceDelay: 0.1,
    topic: 'POLL.FULL_STATE',
    x: 230,
    y: 320,
    wires: [['elmoxs-transport']],
  },
  {
    id: 'elmoxs-dbg-resp',
    type: 'debug',
    z: TAB,
    name: 'forwarded resp (out1)',
    active: false,
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
  {
    id: 'elmoxs-rate-meter',
    type: 'function',
    z: TAB,
    name: 'PollRateMeter',
    func: rateMeterFunc,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
    x: 970,
    y: 360,
    wires: [['elmoxs-dbg-rate']],
  },
  {
    id: 'elmoxs-dbg-rate',
    type: 'debug',
    z: TAB,
    name: 'poll rate (valid frames/sec)',
    active: true,
    tosidebar: true,
    console: false,
    complete: 'payload',
    targetType: 'msg',
    statusVal: '',
    statusType: 'auto',
    x: 1230,
    y: 360,
    wires: [],
  },
];

const outPath = path.join(__dirname, '..', 'elmo-xstate-udp.flow.json');
fs.writeFileSync(outPath, JSON.stringify(nodes, null, 2) + '\n', 'utf8');
console.log('Wrote', outPath, '(' + nodes.length + ' nodes)');
