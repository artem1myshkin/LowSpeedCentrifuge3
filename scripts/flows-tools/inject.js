// Inject edited files back into flows.json (by node id in filename). Preserves CRLF + 4-space indent, no trailing newline.
const fs = require('fs'), path = require('path');
const FLOWS = process.argv[2]; const SRC = process.argv[3];
const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const byId = {}; flows.forEach(n => byId[n.id] = n);
let changed = 0;
function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    const m = f.match(/__([0-9a-zA-Z\-]+)(\.init)?\.(js|vue)$/); if (!m) continue;
    const n = byId[m[1]]; if (!n) { console.error('missing node', m[1]); continue; }
    const code = fs.readFileSync(p, 'utf8');
    const key = m[2] ? 'initialize' : (n.type === 'function' ? 'func' : 'format');
    if (n[key] !== code) { n[key] = code; changed++; console.log('updated', n.type, n.name, key, m[1]); }
  }
}
walk(SRC);
fs.writeFileSync(FLOWS, JSON.stringify(flows, null, 4).replace(/\n/g, '\r\n'), 'utf8');
console.log(changed, 'nodes updated');
