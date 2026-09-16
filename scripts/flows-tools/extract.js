// Extract function/ui-template nodes from flows.json into scratchpad/src/<tab>/<name>__<id>.(js|vue)
// Function "On Start" code goes to <name>__<id>.init.js
const fs = require('fs'), path = require('path');
const FLOWS = process.argv[2]; const OUT = process.argv[3];
const flows = JSON.parse(fs.readFileSync(FLOWS, 'utf8'));
const tabs = {}; flows.filter(n => n.type === 'tab' || n.type === 'subflow').forEach(t => tabs[t.id] = t.label || t.name);
const safe = s => String(s || 'noname').replace(/[^\w\u0400-\u04FF.-]+/g, '_').slice(0, 60);
const index = [];
for (const n of flows) {
  let code, ext;
  if (n.type === 'function') { code = n.func; ext = 'js'; }
  else if (n.type === 'ui-template') { code = n.format; ext = 'vue'; }
  else continue;
  const tab = safe(tabs[n.z] || 'global');
  const dir = path.join(OUT, tab); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${safe(n.name)}__${n.id}.${ext}`), code || '', 'utf8');
  if (n.type === 'function' && n.initialize) fs.writeFileSync(path.join(dir, `${safe(n.name)}__${n.id}.init.js`), n.initialize, 'utf8');
  index.push(`${n.type}\t${tab}\t${n.name}\t${n.id}\t${n.d ? 'DISABLED' : ''}\t${(code||'').split('\n').length}`);
}
fs.writeFileSync(path.join(OUT, 'INDEX.tsv'), index.join('\n'), 'utf8');
console.log(index.length, 'nodes extracted');
