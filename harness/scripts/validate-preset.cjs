// validate-preset.cjs - structural validation for a user-side agent preset.
//
// Checks what can be checked WITHOUT booting the host: the YAML parses (the runtime's own
// yaml package, with the deployment's !!js tag stripped), every package row resolves to an
// installed module, every local ./module row exists next to the preset file, and the
// presentation row is declared exactly once.
//
// usage: node validate-preset.cjs <preset-dir>
const fs = require('fs'), path = require('path');
const yaml = require('C:/Users/Administrator/.dsh-community/profiles/desktop/node_modules/yaml');

const dir = path.resolve(process.argv[2] || 'harness/preset/lean');
const DSH = path.join(process.env.USERPROFILE, '.dsh-community');
const APP = 'C:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness Desktop/resources/app.asar.unpacked';
const roots = [
  path.join(DSH, 'profiles/desktop/node_modules'),
  path.join(DSH, 'profiles/node_modules'),
  path.join(APP, 'node_modules'),
];
const fails = [];
const info = {};

function parseFile(f) {
  const src = fs.readFileSync(f, 'utf8').replace(/!!js /g, '');
  return yaml.parse(src);
}
function pkgRoot(name) {
  let p = name;
  if (p.startsWith('@')) { const s = p.split('/'); if (s.length < 2) return null; p = s[0] + '/' + s[1]; }
  else p = p.split('/')[0];
  for (const r of roots) { const c = path.join(r, p); if (fs.existsSync(c)) return c; }
  return null;
}

const presetYml = path.join(dir, 'preset.yml');
const agentYml = path.join(dir, 'agent.cordis.yml');
for (const f of [presetYml, agentYml]) if (!fs.existsSync(f)) fails.push('missing ' + f);
if (fails.length) { console.log(JSON.stringify({ result: 'FAIL', fails }, null, 1)); process.exit(1); }

let meta, rows;
try { meta = parseFile(presetYml); } catch (e) { fails.push('preset.yml parse: ' + e.message); }
try { rows = parseFile(agentYml); } catch (e) { fails.push('agent.cordis.yml parse: ' + e.message); }
if (meta) {
  info.preset = { name: meta.name, order: meta.order, hasDescription: Boolean(meta.description) };
  for (const k of ['name', 'description', 'order']) if (meta[k] === undefined) fails.push('preset.yml missing ' + k);
}
if (Array.isArray(rows)) {
  let packageRows = 0, localRows = 0, disabled = 0, presentationRows = 0;
  const unresolved = [], missingLocal = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.disabled === true) disabled++;
    if (row.id === 'tool-presentation') presentationRows++;
    const n = row.name;
    if (typeof n !== 'string') continue;
    if (n.startsWith('cordis:')) continue;
    if (n.startsWith('./') || n.startsWith('../')) {
      localRows++;
      if (!fs.existsSync(path.join(dir, n))) missingLocal.push(n);
      continue;
    }
    packageRows++;
    if (!pkgRoot(n)) unresolved.push(n);
  }
  info.rows = { total: rows.length, packageRows, localRows, disabled, presentationRows };
  if (unresolved.length) fails.push('unresolved package rows: ' + unresolved.join(', '));
  if (missingLocal.length) fails.push('missing local module rows: ' + missingLocal.join(', '));
  if (presentationRows !== 1) fails.push('expected exactly 1 tool-presentation row, found ' + presentationRows);
  const scope = rows.find(r => r && r.id === 'tool-scope');
  if (!scope) fails.push('no tool-scope row');
  else {
    info.toolScope = { name: scope.name, denyPrefixes: scope.config?.denyPrefixes?.length ?? 0, denyExact: scope.config?.denyExact?.length ?? 0 };
    const modPath = path.join(dir, String(scope.name).replace('./', ''));
    if (!fs.existsSync(modPath)) fails.push('tool-scope module not found: ' + modPath);
    else {
      const src = fs.readFileSync(modPath, 'utf8');
      info.toolScope.exports = { apply: /export function apply\(/.test(src), name: /export const name =/.test(src) };
      if (!info.toolScope.exports.apply) fails.push('tool-scope module does not export apply()');
    }
  }
} else if (rows !== undefined) fails.push('agent.cordis.yml is not a row array');

console.log(JSON.stringify({ result: fails.length ? 'FAIL' : 'PASS', dir, info, fails }, null, 1));
process.exit(fails.length ? 1 : 0);
