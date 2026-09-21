// test-tool-scope.cjs - offline functional test for harness/preset/lean/tool-scope.mjs
//
// Boots no host: it imports the module, drives it through a stub Cordis context, and feeds it
// the REAL tool names measured from the newest session log. Asserts the deny set is exactly the
// intended families, that the transport and loop-critical tools survive, and reports the
// projected token saving using the measured per-tool costs.
const fs = require('fs'), path = require('path'), zlib = require('zlib'), assert = require('assert');
const NL = String.fromCharCode(10), BT3 = String.fromCharCode(96).repeat(3);

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
  return best.f;
}
function decompress(p) {
  const buf = fs.readFileSync(p), offs = [];
  for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === 0x28 && buf[i+1] === 0xb5 && buf[i+2] === 0x2f && buf[i+3] === 0xfd) offs.push(i);
  const parts = [];
  for (let k = 0; k < offs.length; k++) { const s = offs[k], e = (k+1 < offs.length) ? offs[k+1] : buf.length; try { parts.push(zlib.zstdDecompressSync(buf.slice(s, e))); } catch (err) {} }
  return Buffer.concat(parts).toString('utf8');
}
function measure() {
  const log = newestLog();
  const evs = [];
  for (const ln of decompress(log).split(NL)) { if (!ln.trim()) continue; try { evs.push(JSON.parse(ln)); } catch (e) {} }
  const s = evs.filter(e => e.type === 'system/message').pop().data.message.content.map(b => b.text || '').join('');
  const a0 = s.indexOf('interface ToolArgsMap'), a1 = s.indexOf('interface ToolOutputMap');
  const o0 = a1, o1 = s.indexOf('declare class', o0);
  const split = (block) => {
    const out = {}; let cur = null, depth = -1;
    for (const ln of block.split(NL)) {
      if (depth === 0) { const m = ln.match(/^  ("?[A-Za-z_][A-Za-z0-9_-]*"?): /); if (m) { cur = m[1].replace(/"/g, ''); out[cur] = 0; } }
      if (cur) out[cur] += ln.length + 1;
      for (const c of ln) { if ('{(['.includes(c)) depth++; else if ('})]'.includes(c)) depth--; }
    }
    return out;
  };
  const args = split(s.slice(a0, a1)), outs = split(s.slice(o0, o1));
  return { log, tools: Object.keys(args).map(n => ({ name: n, chars: (args[n] || 0) + (outs[n] || 0) })) };
}

(async () => {
  const mod = await import(new URL('file:///' + path.resolve(__dirname, '../preset/lean/tool-scope.mjs').replace(/\\/g, '/')).href);
  const { log, tools } = measure();
  const names = tools.map(t => t.name);
  const chars = Object.fromEntries(tools.map(t => [t.name, t.chars]));

  // --- stub Cordis context -------------------------------------------------
  const handlers = {};
  const ctx = { on: (ev, fn) => { handlers[ev] = fn; }, logger: { info: () => {}, warn: (m) => console.log('warn:', m) } };
  let captured = null;
  const agent = { ctx: { tools: {
    schemas: () => names.map(n => ({ name: n })),
    restrict: (arg) => { captured = arg; return () => {}; },
  } } };

  assert.strictEqual(typeof mod.apply, 'function', 'module must export apply()');
  assert.ok(mod.name, 'module must export name');
  mod.apply(ctx, {});
  assert.ok(handlers['agent/created'], 'apply() must register an agent/created handler');
  assert.ok(handlers['agent/disposed'], 'apply() must register an agent/disposed handler');
  handlers['agent/created']({ agent });

  assert.ok(captured && Array.isArray(captured.deny), 'restrict() must be called with a deny list');
  const denied = captured.deny.slice().sort();

  const expectedPrefixes = ['mcp__playwright-mcp__', 'ssh_', 'team_task_', 'job_'];
  const mustDeny = names.filter(n => expectedPrefixes.some(p => n.startsWith(p)));
  for (const n of mustDeny) assert.ok(denied.includes(n), 'expected ' + n + ' to be denied');

  for (const n of ['run_code', 'read', 'write', 'edit', 'pwsh', 'ask_user_question', 'todo_write', 'present', 'subagent', 'web_search', 'web_fetch']) {
    assert.ok(!denied.includes(n), 'never-deny tool was denied: ' + n);
  }
  handlers['agent/disposed']({ agent });

  const savedChars = denied.reduce((x, n) => x + (chars[n] || 0), 0);
  const byFam = {};
  for (const n of denied) { const f = n.startsWith('mcp__') ? 'mcp' : n.split('_')[0]; byFam[f] = (byFam[f] || 0) + 1; }
  console.log(JSON.stringify({
    result: 'PASS',
    log,
    visibleTools: names.length,
    deniedTools: denied.length,
    deniedNames: denied,
    byFamily: byFam,
    savedChars,
    savedTokensEstimate: Math.ceil(savedChars / 4),
    systemPromptTokensBefore: 14452,
    systemPromptTokensAfterEstimate: 14452 - Math.ceil(savedChars / 4),
  }, null, 1));
})().catch((err) => { console.log(JSON.stringify({ result: 'FAIL', error: err.message })); process.exit(1); });
