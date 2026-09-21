// sdk-budget.cjs - exact per-tool cost of the PTC SDK declaration block in the system prompt.
//
// Why: harness/research/03-baseline-metrics.md measured that the PTC tools:sdk block is
// 49009 chars / 852 -> 12253 tokens of a 57790-char system prompt, i.e. ~85% of it, while the
// per-request tools array is only [run_code] (2078 chars). Turning that into a decision needs
// per-tool numbers, not a total. This script produces them from the session log itself.
//
// usage: node sdk-budget.cjs [session.v3.jsonl.zstd]
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const NL = String.fromCharCode(10), BT3 = String.fromCharCode(96).repeat(3), CPT = 4;

function newestLog() {
  const root = path.join(process.env.USERPROFILE, '.dsh-community', 'sessions');
  let best = null;
  for (const slug of fs.readdirSync(root)) {
    const d = path.join(root, slug);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const sid of fs.readdirSync(d)) {
      const f = path.join(d, sid, 'session.v3.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      const m = fs.statSync(f).mtimeMs;
      if (!best || m > best.m) best = { m, f };
    }
  }
  return best && best.f;
}
function decompress(p) {
  const buf = fs.readFileSync(p), offs = [];
  for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === 0x28 && buf[i+1] === 0xb5 && buf[i+2] === 0x2f && buf[i+3] === 0xfd) offs.push(i);
  const parts = [];
  for (let k = 0; k < offs.length; k++) { const s = offs[k], e = (k+1 < offs.length) ? offs[k+1] : buf.length; try { parts.push(zlib.zstdDecompressSync(buf.slice(s, e))); } catch (err) {} }
  return Buffer.concat(parts).toString('utf8');
}
function splitMap(block) {
  // start at -1 so the `interface XMap {` opener itself lands us on depth 0 (see #13's parser)
  const out = {}; let cur = null, depth = -1;
  for (const ln of block.split(NL)) {
    if (depth === 0) { const m = ln.match(/^  ("?[A-Za-z_][A-Za-z0-9_-]*"?): /); if (m) { cur = m[1].replace(/"/g, ''); out[cur] = 0; } }
    if (cur) out[cur] += ln.length + 1;
    for (const c of ln) { if (c === '{' || c === '(' || c === '[') depth++; else if (c === '}' || c === ')' || c === ']') depth--; }
  }
  return out;
}
function familyOf(n) {
  if (n.startsWith('mcp__playwright')) return 'mcp/playwright';
  if (n.startsWith('mcp__')) return 'mcp/other';
  if (n.startsWith('ssh_')) return 'ssh';
  if (n.startsWith('team_task_')) return 'agent-team';
  if (n.startsWith('job_')) return 'jobs';
  if (/^(create_goal|get_goal|update_goal)$/.test(n)) return 'goal';
  if (n.startsWith('subagent')) return 'delegation';
  if (/^(read|write|edit|glob|grep|pwsh|present|read_image|describe_image)$/.test(n)) return 'fs+shell';
  return 'core';
}

const log = process.argv[2] || newestLog();
const evs = [];
for (const ln of decompress(log).split(NL)) { if (!ln.trim()) continue; try { evs.push(JSON.parse(ln)); } catch (e) {} }
const sys = evs.filter(e => e.type === 'system/message').pop();
if (!sys) { console.log(JSON.stringify({ error: 'no system/message event' })); process.exit(1); }
const s = sys.data.message.content.map(b => b.text || '').join('');

const sdkStart = s.indexOf('## Writing code for run_code');
const sdkEnd = s.indexOf(NL + BT3 + NL, s.indexOf('declare const tools'));
const sdkBlock = sdkStart < 0 ? '' : (sdkEnd < 0 ? s.slice(sdkStart) : s.slice(sdkStart, sdkEnd + 4));

const a0 = sdkBlock.indexOf('interface ToolArgsMap'), a1 = sdkBlock.indexOf('interface ToolOutputMap');
const o0 = a1, o1 = sdkBlock.indexOf('declare class', o0);
const argsMap = (a0 >= 0 && a1 > a0) ? splitMap(sdkBlock.slice(a0, a1)) : {};
const outMap = (o0 >= 0 && o1 > o0) ? splitMap(sdkBlock.slice(o0, o1)) : {};

const names = Object.keys(argsMap);
const tools = names.map(n => ({ name: n, family: familyOf(n), argsChars: argsMap[n] || 0, outChars: outMap[n] || 0, chars: (argsMap[n] || 0) + (outMap[n] || 0) }));
tools.sort((x, y) => y.chars - x.chars);

const fam = {};
for (const t of tools) { const f = fam[t.family] = fam[t.family] || { tools: 0, chars: 0 }; f.tools++; f.chars += t.chars; }
const famRows = Object.keys(fam).map(k => ({ family: k, tools: fam[k].tools, chars: fam[k].chars, tokens: Math.ceil(fam[k].chars / CPT) })).sort((a, b) => b.chars - a.chars);

const totalChars = tools.reduce((x, t) => x + t.chars, 0);
console.log(JSON.stringify({
  log,
  systemPromptChars: s.length,
  sdkBlockChars: sdkBlock.length,
  preambleChars: (a0 >= 0 ? a0 : 0),
  declaredTools: tools.length,
  perToolMeanChars: Math.round(totalChars / Math.max(1, tools.length)),
  totalToolChars: totalChars,
  families: famRows,
  top20: tools.slice(0, 20),
  uncontracted: names.filter(n => !(n in outMap)),
}, null, 1));
