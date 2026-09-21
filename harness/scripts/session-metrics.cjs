// session-metrics.cjs - DSH context / tool / loop baselines from one session log
//
// Provenance: extracted verbatim from harness/research/03-baseline-metrics.md section C3
// (ticket #13, "Context 成本与 Tool 管理的可测基线"), which in turn was reproduced by the
// Lead on session-de059c2d-971c-48ed-9e2e-4811d734be30. Kept here because the pre/post
// comparison required by ticket #16 needs a stable, copy-pasteable measurement tool.
//
// usage: node session-metrics.cjs <session.v3.jsonl.zstd> [projcache.json]
const fs = require('fs'), zlib = require('zlib');
const CPT = 4, BO = 4, RO = 4, NL = String.fromCharCode(10), BT3 = String.fromCharCode(96).repeat(3);
function decompress(p) {
  const buf = fs.readFileSync(p), offs = [];
  for (let i = 0; i + 4 <= buf.length; i++) if (buf[i] === 0x28 && buf[i+1] === 0xb5 && buf[i+2] === 0x2f && buf[i+3] === 0xfd) offs.push(i);
  const parts = [];
  for (let k = 0; k < offs.length; k++) { const s = offs[k], e = (k+1 < offs.length) ? offs[k+1] : buf.length; try { parts.push(zlib.zstdDecompressSync(buf.slice(s, e))); } catch (err) {} }
  return Buffer.concat(parts).toString('utf8');
}
const evs = [];
for (const ln of decompress(process.argv[2]).split(NL)) { if (!ln.trim()) continue; try { evs.push(JSON.parse(ln)); } catch (e) {} }
const cnt = {}; for (const e of evs) cnt[e.type] = (cnt[e.type] || 0) + 1;
const head = evs.find(e => e.type === 'session') || {};
const out = { session: head.id, preset: head.agentPreset, cwd: head.cwd, events: evs.length };
out.loop = {
  turns: cnt['turn/start'] || 0, steps: cnt['step/start'] || 0,
  toolCalls: cnt['tool/call'] || 0, toolResults: cnt['tool/result'] || 0,
  ptcDispatches: cnt['tool/ptc-dispatch'] || 0,
  llmAttempts: cnt['assistant/attempt'] || 0, llmRetries: cnt['llm/retry'] || 0,
  compactions: (cnt['compaction/summary'] || 0), prunes: (cnt['compaction/prune'] || 0)
};
const hdrs = evs.filter(e => e.type === 'request/header');
if (hdrs.length) {
  const tools = hdrs[hdrs.length-1].data.header.tools || [];
  out.tools = { headerEvents: hdrs.length, count: tools.length, names: tools.map(t => t.name),
    jsonChars: JSON.stringify(tools).length, toolsTokens: Math.ceil(JSON.stringify(tools).length / CPT) + BO,
    reasons: hdrs.map(e => e.data.reason) };
}
const rc = evs.filter(e => e.type === 'request/context').pop();
if (rc) out.context = rc.data;
const sys = evs.filter(e => e.type === 'system/message').pop();
if (sys) {
  const s = sys.data.message.content.map(b => b.text || '').join('');
  const st = s.indexOf('## Writing code for run_code');
  const fe = st < 0 ? -1 : s.indexOf(NL + BT3 + NL, s.indexOf('declare const tools'));
  const sdk = st < 0 ? 0 : (fe < 0 ? s.length - st : fe + 4 - st);
  out.systemPrompt = { seq: sys.seq, chars: s.length, systemTokens: Math.ceil(s.length / CPT) + RO,
    sdkSectionChars: sdk, sdkSectionTokens: Math.ceil(sdk / CPT), nonSdkChars: s.length - sdk };
  const a = s.indexOf('interface ToolArgsMap'), b = s.indexOf('interface ToolOutputMap');
  if (a >= 0 && b > a) {
    const blk = s.slice(a, b).split(NL); let depth = -1; const names = [], docs = []; let pending = null;
    for (const ln of blk) {
      const docStart = /^  \/\*\*/.test(ln), docCont = /^   \*/.test(ln);
      if (depth === 0 && !docStart && !docCont) { const nm = ln.match(/^  (\S[^:]*): /); if (nm) { names.push(nm[1].replace(/"/g,'')); docs.push(pending || ''); pending = null; } }
      if (depth === 0 && docStart) { const m = ln.match(/^  \/\*\* (.*) \*\/$/); pending = m ? m[1] : null; }
      if (depth === 0 && docCont) pending = null;
      for (const c of ln) { if (c === '{') depth++; else if (c === '}') depth--; }
    }
    const nameDesc = names.reduce((x, n, i) => x + JSON.stringify({ name: n, description: docs[i] || '' }).length, 0) + (names.length - 1) + 2;
    const withEmptyParams = nameDesc + names.length * 17;
    out.sdk = { declaredTools: names.length, descriptionChars: docs.reduce((x, y) => x + y.length, 0),
      nativeLowerBoundJsonChars: nameDesc, nativeLowerBoundTokens: Math.ceil(nameDesc / CPT) + BO,
      nativeWithEmptyParamsTokens: Math.ceil(withEmptyParams / CPT) + BO };
  }
}
const sk = evs.filter(e => e.type === 'user/message' && JSON.stringify(e).includes('<available_skills>')).pop();
if (sk) {
  const t = sk.data.content.map(b => b.text || '').join('');
  const a = t.indexOf('<available_skills>'), b = t.indexOf('</available_skills>');
  const blk = b < 0 ? t.length - a : b + 19 - a;
  out.skillsCatalog = { seq: sk.seq, reminderChars: t.length, catalogChars: blk,
    skills: (t.slice(a, b).match(/^- /gm) || []).length, catalogTokens: Math.ceil(blk / CPT) };
}
const us = [];
for (const e of evs) if (e.type === 'assistant/message' && e.data.usage) us.push({ turn: e.data.turn, step: e.data.step, u: e.data.usage });
const S = k => us.reduce((x, y) => x + (y.u[k] || 0), 0);
out.usage = { steps: us.length, inputTokens: S('inputTokens'), outputTokens: S('outputTokens'),
  cacheReadTokens: S('cacheReadTokens'), cacheWriteTokens: S('cacheWriteTokens'), totalTokens: S('totalTokens'),
  maxInputTokens: us.reduce((x, y) => Math.max(x, y.u.inputTokens || 0), 0),
  maxTotalTokens: us.reduce((x, y) => Math.max(x, y.u.totalTokens || 0), 0) };
out.perTurn = {};
for (const { turn, u } of us) { const t = out.perTurn[turn] = out.perTurn[turn] || { steps: 0, in: 0, out: 0, cacheRead: 0, peakIn: 0 };
  t.steps++; t.in += u.inputTokens || 0; t.out += u.outputTokens || 0; t.cacheRead += u.cacheReadTokens || 0; t.peakIn = Math.max(t.peakIn, u.inputTokens || 0); }
if (process.argv[3]) {
  const R = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).record.rows;
  out.engine = {};
  for (const k of ['contextBreakdown','contextPressure','tokenUsage','liveTokenUsage','sessionStats']) {
    if (!R[k]) continue; const v = R[k].val;
    if (k === 'contextBreakdown') out.engine.contextBreakdown = { seq: R[k].seq, nodes: v.nodes.length, breakdown: v.breakdown };
    else if (k === 'liveTokenUsage') { const { surface, ...rest } = v; out.engine.liveTokenUsage = { ...rest, surfaceNodes: Object.keys(surface).length }; }
    else out.engine[k] = v;
  }
}
console.log(JSON.stringify(out, null, 1));
