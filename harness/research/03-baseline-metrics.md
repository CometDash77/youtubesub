# 03 — Context 成本与 Tool 管理的可测基线：量什么、怎么量

子票 #13（wayfinder:research）。取证时间 2026-09-21，本机 DeepSeek Harness Desktop 4.2.0。

本机的关键事实：**所有活动会话都是 `ptc` preset**（33/33 会话日志 + 619 条投影缓存全部 `agentPreset: "ptc"`、`toolsTokens: 524`），因此下面所有「当前基线值」都是 ptc 侧的真值；native 侧只有下界，原因见 §5。

## 0. 一句话结论

1. **引擎已经自带这套口径，不需要自研埋点。** 三个真值源都在磁盘上、字段都是稳定的：会话事件日志、派生投影缓存 `storages/session_projcache/`、每日本地账本。本票的工作是把「读哪个字段」定死（§2 口径表），不是造新指标。
2. **「ptc 让工具声明的 prompt 变小」这个说法在本机数据上不成立。** ptc 把 native 的 N 个 schema 从 `request/header.tools` 里删干净（只剩 `run_code`，524 tokens），但**同一批工具的完整 TS 声明被塞进了 system prompt 的 `tools:sdk` 段**（49009 字符 / 12253 tokens）。合计 12777 tokens，大于 native 的下界 5016 tokens。PTC 的真实收益必须用 `tool/ptc-dispatch` 与 `step/start` 度量（一次程序替代 N 次往返），不能用 schema 体积度量。
3. **压缩 / tool-result 剪枝在本机从未触发**：33/33 会话日志里 `compaction/summary` = 0、`compaction/prune` = 0、surface 替换 = 0；最高上下文占用 41.1%（205526/500000），远低于 compaction-basic 的 0.8 阈值。这项「改后变好」当前**无基线可比**，必须先造一个能跨过 400k tokens 的负载。

## 1. 真值源与权威性排序

| # | 路径 | 粒度 | 权威度 | 记录什么 |
|---|---|---|---|---|
| A | `~/.dsh-community/storages/session_projcache/sessions/<session-id>.json` | 单会话、最新快照 | **最高**：引擎自己算完写盘的派生投影 | `contextBreakdown` / `contextPressure` / `tokenUsage` / `liveTokenUsage` / `sessionStats` |
| B | `~/.dsh-community/sessions/<workspace-slug>/<session-id>/session.v3.jsonl.zstd` | 单会话、逐事件 | 原始事实，需自己按公式折叠 | 每一次 LLM 往返、每一次工具调用、`usage`、压缩事件、`request/header` |
| C | `~/.dsh-community/state/live-stats/usage-ledger.json` | 本机 × 天 | 高（@linxin666/dsh-live-stats 写入） | 每日 totalTokens / turns / byModel / `peakTps` |
| D | `~/.dsh-community/dsh-usage/usage-ledger.json` | 本机 × 天 × 模型 | 高（@linxin666/dsh-usage 写入） | 每日每模型 input/output/cacheRead/cacheWrite/`calls` |
| E | `~/.dsh-community/dsh-usage/provider-snapshots.json` | 本机 | 高 | 余额、`spendWatch` |

**关键点：A 是唯一能给出「单会话 context 占用」的来源**，而它恰好是引擎按下面的公式算好的（见 §3.3）。

## 2. 口径表（核心交付）

记号：`$DSH = C:\Users\Administrator\.dsh-community`；`$APP = C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness Desktop\resources\app.asar.unpacked`。命令 C1–C7 见 §4，**全部在本机实跑过**。

### 2.1 Context 体积（对应「Context 成本下降」）

| 指标 | 采集 | 当前基线值 | 改造后的期望方向 |
|---|---|---|---|
| `toolsTokens`（工具 schema 的 prompt 计价） | C1 / C2 | **524**（32/32 会话完全一致） | 持平或下降；必须与下一行合看才不代表变好 |
| `request/header.tools` 的 JSON 字符数 | C3 | **2078**（内容 = `[run_code]` 一个） | 若做按需激活，应观察到 `request/header` 出现 >1 次且 `reason` 含 `"change"` |
| `tools:sdk` 段字符 / tokens | C3 | **49009 字符 / 12253 tokens** | **下降**（懒加载、输出类型裁剪、描述精简） |
| 工具声明合计（ptc）= 上两行之和 | C3 + 计算 | **12777 tokens** | 降到 native 真值以下 |
| native 下界 tokens（name+description 的 JSON） | C3 | **5016**（20046 字符）；加空 `parameters` 对象 5305 | 这是**下界不是真值**，真值需切 preset 采（§5）|
| `systemPrompt.systemTokens` | C2 / C3 | **14452**（57790 字符） | 下降 |
| `systemPrompt` 非 SDK 部分 | C3 | **8781 字符** | 下降（工作区指令 / personal prompt） |
| `skillsCatalog.catalogChars` / 条数 | C3 | **6089 字符 / 32 条**（整条 reminder 6734 字符，引擎计价 **1692 tokens**） | **下降** |
| `~/.agents/skills` 的 Σdescription | C4 | **6646 字符 / 32 个目录** | 下降（截断或按需） |
| `contextPressure.surfaceTokens` | C2 | 该会话 80512；33 会话 max **205526** | 同负载下下降 |
| `contextPressure.pressureTokens` | C2 | 该会话 96223 | 下降 |
| 上下文占用率 = `surfaceTokens / contextWindow` | C2 | 本机 33 会话：4.5% ~ **41.1%**（窗口 500000） | 同负载下降 |

### 2.2 Loop / 稳定性 / 长任务（对应「Agent 稳定性提升」「长任务执行能力提升」）

| 指标 | 采集 | 当前基线值（33 会话统计） | 期望方向 |
|---|---|---|---|
| `turns`（`turn/start` 计数） | C7 | 中位 1，最大 **12** | 上升（不崩地连跑更多轮） |
| `steps`（`step/start`，= LLM 往返次数） | C7 | 中位 40，最大 **140** | 上升 |
| 工具往返 `tool/call` / `tool/result` | C7 | 取证会话 42 / 41 | 同任务下下降（PTC 折叠） |
| PTC 子调用 `tool/ptc-dispatch` | C7 | 取证会话 **108**（≈2.6 × 顶层工具调用） | 上升（一次程序做更多事） |
| 重试 `llm/retry` / `assistant/attempt` | C7 | 取证会话 5 / 6，**全部 429 RATE_LIMIT** | 下降 |
| 单步 input 峰值 `assistant/message.data.usage.inputTokens` | C3 | 取证会话 7960；全机最大 **168345** | 下降 |
| `tokensPerSecond` | C2 | 中位 142，最大 **661** | 持平或上升 |
| `peakTokensPerSecond` | C2 | 中位 249，最大 **789** | 持平 |
| `sessionStats.ttftMs` | C2 | 中位 186159，最大 **2103072** | 下降 |
| `sessionStats.llmMs` / `toolMs` | C2 | llm 中位 409497 最大 3093318；tool 中位 114658 最大 663131 | `toolMs` 下降 |
| 错误终止 `turn/end.data.reason.kind` | C7 | 取证会话 1 次 `error`(429) | 下降 |

### 2.3 用量与压缩（对应「Context 成本下降」，也是改前改后对账用）

| 指标 | 采集 | 当前基线值 | 期望方向 |
|---|---|---|---|
| 全局日本账本 `state/live-stats/usage-ledger.json` | C5 | `peakTps` 9739；3 条日记录；2026-09-21 `totalTokens` 103802783 / `turns` 1093 | 同任务量下总量下降 |
| 全局日本账本 `dsh-usage/usage-ledger.json` | C6 | 3 天 × 3 模型；2026-09-21 `command/deepseek/deepseek-v4.1-flash` `calls` 689 | 同任务量下 `calls` 下降 |
| 单会话 `tokenUsage.totals` | C2 | 取证会话 uncachedInput 41269 / output 55273 / cacheRead 2753536 | 下降 |
| `compaction/summary` 次数 + `shadowedTokenCount` | C3 / C7 | **0 / 0**（33/33 会话，全机 0） | 长任务下应 >0，且每次可读到被替换的 token 数 |
| `compaction/prune` 次数 + `shadowedTokenCount` | C3 / C7 | **0 / 0** | 同上；应能读到 `charsBefore/charsAfter` |
| surface 替换次数（`surfaceOp.op === 'replace'`） | C7 | **0** | 同上 |

## 3. 分项取证

### 3.1 工具 schema 在 native 与 ptc 两种呈现下的体积

**机制（源码锚点）**

- `$APP/node_modules/@deepseek-ai/dsh-agent-presets/presets/ptc/agent.cordis.yml:277-280` — 本机 ptc preset 挂 `tool-presentation` 且 `mode: ptc`。
- `$APP/node_modules/@deepseek-ai/dsh-tools/lib/index.js:2829-2846` `wireSchemas()` — `native`：全部可见 schema；`ptc`：`schemas.filter(s => s.name === RUN_CODE_NAME)`；`both`：全部 + `run_code`。
- `$APP/node_modules/@deepseek-ai/dsh-tools/lib/index.js:2743-2758` `sdkSection()` — 非 `native` 时把生成 SDK 作为 system prompt 段 `tools:sdk` 渲染。
- `$APP/node_modules/@deepseek-ai/dsh-tools/lib/index.js:1729-1755` `renderToolsSdk()` — 生成 `interface ToolArgsMap` + `interface ToolOutputMap`。
- `$APP/node_modules/@deepseek-ai/dsh-tools/lib/index.js:3024-3046` `sdkSchemas()/schemaOf()` — `sdkSchemas` = `schemaOf(def, true)` + `output`，且**排除 `run_code` 自己**；native 的 wire schema 就是 `{name, description, parameters}` 三个字段。
- `$APP/node_modules/@deepseek-ai/dsh-agent-tool-presentation/lib/index.js:41-49` — `presentAs("native" | "ptc" | "both")` 的按 scope 声明。

**本机实测（ptc 侧，全部真值）** — 取证会话 `session-de059c2d-971c-48ed-9e2e-4811d734be30`：

```
request/header.data.header.tools        = ["run_code"]         (1 个)
JSON.stringify(tools).length            = 2078 字符
engine estimateToolsTokens              = ceil(2078/4) + 4     = 524 tokens   ← 与投影缓存逐位一致
systemPrompt 总                        = 57790 字符            = 14452 tokens (引擎计价，逐位一致)
  ├─ tools:sdk 段                      = 49009 字符            = 12253 tokens
  │    ├─ interface ToolArgsMap 块      = 35029 字符
  │    └─ interface ToolOutputMap 块    = 12232 字符
  └─ 其余（工作区指令 / 插件说明 / MCP 等）= 8781 字符
SDK 声明的工具数                        = 68
SDK 里 Σ 工具 description 字符          = 16662
```

**native 侧（只能给下界）**：把 68 个工具的 `{name, description}` 序列化成 JSON = **20046 字符 → 5016 tokens**；再补每个工具的空 `"parameters":{}` = 21298 字符 → 5305 tokens。native 的真值 = 这一项 **加上 68 份真实 `parameters` JSON Schema**（作为标尺：`run_code` 一个工具的完整 wire schema 就是 2074 字符，其中 `parameters` 占 985 字符）。

**结论**：ptc 的工具声明合计 **524 + 12253 = 12777 tokens**，比 native 下界 5016 高 **2.5×**。也就是说，「ptc 省 context」**在工具声明这一项上为假**；ptc 省的是**往返次数**（一次 `run_code` 程序里并发 `tools.*` 子调用），这一项要用 §2.2 的 `tool/ptc-dispatch` 与 `steps` 计量。

### 3.2 技能目录全量注入的体积

- 渲染者：`$APP/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js:238-261` `renderCatalogMessage()`（变更时 `renderCatalogUpdate()` `:262-286`）。产出是**一条 `user/message`**，`source.kind = "skill-catalog"`，正文是 `<system-reminder>` 包住的 `<available_skills>` 列表，每行 = 名称 + 一行 description。
- 本机实测（同一取证会话）：`<available_skills>` 块 **6089 字符 / 32 条**；整条 reminder 6734 字符；引擎把该 surface 节点计价为 **1692 tokens**（`liveTokenUsage.surface["12"]`）。目录本体 ≈ 6089/4 ≈ **1523 tokens**。
- 老会话 `session-deeded38-69c1-4754-9839-56b9788154fc` 的目录是 4865 字符 / 18 条 → 说明目录随插件装配变化，**不是常量**。
- 目录磁盘侧 `~/.agents/skills`：**32 个目录**，Σname 392 字符、Σdescription **6646 字符**（最大 ponytail 827、pdf-to-txt 473、obsidian-cli 467）。

**注意：会话目录 ≠ 磁盘目录。** 取证会话目录里的 32 条与 `~/.agents/skills` 的 32 个目录只有 17 个重合：

- 只在会话目录里（15 个，来自插件 deck）：`superpower-*`（14）+ `weread-skills`
- 只在 `~/.agents/skills` 里（15 个，本会话未被注入）：`ask-matt, grill-me, grill-with-docs, handoff, i-have-adhd, implement, improve-codebase-architecture, setup-matt-pocock-skills, teach, to-spec, to-tickets, triage, wayfinder, wechatreading, writing-great-skills`

所以「技能注入成本」必须**从会话日志量**（A/B 源），不能只扫 `~/.agents/skills`。

### 3.3 会话 token 用量从哪里读

| 位置 | 字段（真实） | 能否给单会话 context 占用 |
|---|---|---|
| `~/.dsh-community/dsh-usage/usage-ledger.json` | `days.<YYYY-MM-DD>.command.<provider/model>.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens,calls,cost}` | **不能**：只有「天 × 模型」两维，无 session 维度。写入者 `$APP/node_modules/@linxin666/dsh-usage/lib/index.js:1001-1003`（`persistDir = join(dshHome(), "dsh-usage")`）；HTTP 路由 `/api/dsh-usage/overview` `:1595` |
| `~/.dsh-community/dsh-usage/provider-snapshots.json` | `{version, providers.<p>.{balance,credential,supported,updatedAt}, spendWatch{accruedCny,since,lastBalanceCny}}` | 不能 |
| `~/.dsh-community/state/live-stats/usage-ledger.json` | `{updatedAt, peakTpsVersion:2, peakTps, records:[{date,totalTokens,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,estimatedCost,turns,cacheSavedCost,byModel{<m>:{tokens,cost,turns}}}]}` | **不能**：只有日期维度。写入者 `@linxin666/dsh-live-stats/lib/index.js:927,940` |
| `~/.dsh-community/sessions/<slug>/<id>/session.v3.jsonl.zstd` | **多帧 zstd** 的 JSONL，一行一事件。`assistant/message.data.usage = {inputTokens,outputTokens,totalTokens,cacheReadTokens,cacheWriteTokens}`（每步一条，共 39 条）；`request/context` 带 `contextWindow: 500000` | 能（逐事件，但要自己折叠） |
| `~/.dsh-community/storages/session_projcache/sessions/<id>.json` | `{version:7, record:{rows:{...}}}`，行键含 `contextBreakdown` / `contextPressure` / `tokenUsage` / `liveTokenUsage` / `sessionStats` / `turnOutline` / `subagentCatalog` 等 26 个 | **能，且是权威**（引擎算好的） |

**注意：`sessions/<workspace-slug>/<session-id>/` 目录里只有 `session.v3.jsonl.zstd` 一个文件**，没有 index、没有 sqlite（`dsh-session-query-sqlite` 在 web profile 里是 `path: ':memory:'`、`openAt: never`，见 `$APP/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:27-30`）。

权威公式（源码 `$APP/node_modules/@deepseek-ai/dsh-token-meter/lib/types/estimate.js:9-13,93-97` 与 `breakdown-projection.js:33-67`）：

```
CHARS_PER_TOKEN = 4, BLOCK_OVERHEAD = 4, ROLE_OVERHEAD = 4
toolsTokens    = ceil(JSON.stringify(header.tools).length / 4) + 4      // 取最近一次 request/header
systemTokens   = ceil(systemPromptText.length / 4) + 4                  // 取 surface 顺序里最后一个非空 system/message
messageTokens  = 其余 surface 节点之和
contextBreakdown = { systemTokens, toolsTokens, messageTokens }
```

交叉验证：取证会话 `contextBreakdown.breakdown = {systemTokens: 14452, toolsTokens: 524, messageTokens: 66060}`，而 `liveTokenUsage.surfaceTokens = 80512`、`liveTokenUsage.surface["8"] = 14452`（system 节点）→ 80512 − 14452 = **66060**，逐位吻合。**所以单会话 context 占用直接读 `contextPressure.surfaceTokens`（或 `liveTokenUsage.surfaceTokens`）即可**，不必自己折叠。

### 3.4 压缩与 tool-result 剪枝的触发记录怎么看

| 机制 | 事件 / 字段 | 源码锚点 |
|---|---|---|
| 自动压缩 | `compaction/start` → `compaction/summary` → `compaction/end`；`compaction/summary.data.shadowedRange{start,end}` + `shadowedTokenCount` | `@deepseek-ai/dsh-compaction-basic/lib/index.js:613` `session.append("compaction/summary", ...)` |
| 自动压缩阈值 | `thresholdTokens = floor(contextWindow × thresholdRatio)`；默认 `DEFAULT_THRESHOLD_RATIO = 0.8`、`DEFAULT_RETAIN_RATIO = 0.16`；判定 `if (measurement.totalTokens < spec.thresholdTokens) return null` | `dsh-compaction-basic/lib/index.js:15-17, 111, 908` |
| tool-result 剪枝 | `compaction/prune`，字段同上；紧接着一条 `tool/result` 带 `data.surfaceOp = {op:'replace', startSeq, endSeq}` 与 `sourceEventSeqs` | `dsh-compaction-tool-result-pruner/lib/index.js:163-181` |
| 剪枝预算 | 默认 `thresholdChars: 8192, headChars: 4096, tailChars: 1024`；替换标记 `PRUNE_MARKER = "\\n\\n[... tool result middle pruned ...]\\n\\n"`；本机 value-mode preset 显式配了这三个值 | `dsh-compaction-tool-result-pruner/lib/index.js:8-14`；`~/.dsh-community/.agent-presets/value-mode/agent.cordis.yml:93-98` |
| 手工压缩 | `/compact@@ 命令，回文本 `"Compacted N history items (~M tokens)."` | `dsh-command-compact/lib/index.js:55-64` |

**本机基线：0 次。** 33 个会话日志全掃 → `compaction/summary` 0、`compaction/prune` 0、surface 替换 0。500k 窗口 × 0.8 = 400k tokens 才自动压缩，实测最高 surfaceTokens 205526（41.1%）。**因此这些字段的语义目前只有源码依据、没有实测样本；「改造后压缩是否更优」必须先造一个 >400k 的负载才能对比。**

### 3.5 agent loop 的轮次、工具往返、单轮 token 峰值怎么计数

全部落在**事件日志**（B 源）的固定事件名上，v1 就能用：

| 问题 | 计数方式 |
|---|---|
| 轮次 | `turn/start` 计数（配 `turn/end.data.reason` 判正常/错误收尾） |
| LLM 往返次数 | `step/start` 计数 |
| 顶层工具往返次数 | `tool/call` / `tool/result` 计数 |
| PTC 子调用次数 | `tool/ptc-dispatch` 计数（配对 `tool/ptc-dispatch-start`） |
| 重试 | `llm/retry` / `llm/retry-started` / `assistant/attempt` |
| 单步 token | `assistant/message.data.usage.{inputTokens,outputTokens,totalTokens,cacheReadTokens}`（带 `turn` / `step`，可直接按轮聚合） |
| **单轮 input 峰值** | 该轮所有 step 的 `usage.inputTokens` 取 max；**或**直接读 `liveTokenUsage.last.peakTokensPerSecond`（吞吐峰值） |
| 耗时分解 | `sessionStats = {turns,steps,llmMs,toolMs,ttftMs,ttftSteps,decodeMs,decodeTokens,lastTurn,openStep,pendingCalls}` |
| 吞吐 | `liveTokenUsage.last.{tokensPerSecond, peakTokensPerSecond, rateAlgorithmVersion:2, estimated}` |

取证会话实测：`turns 3 / steps 44 / toolCalls 42 / toolResults 41 / ptcDispatches 108 / llmRetries 5`；`perTurn` 可按轮拆出 `{steps,in,out,cacheRead,peakIn}`。

## 4. 采集命令（全部在本机实跑过，可直接复制粘贴）

### C1 — 全部会话的 context 三分账（最快的一条）

```powershell
$c = "$env:USERPROFILE\.dsh-community\storages\session_projcache\sessions"
Get-ChildItem $c -Filter *.json | Where-Object { $_.Name -notlike 'import-*' } | ForEach-Object {
  $j = Get-Content $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  $b = $j.record.rows.contextBreakdown.val.breakdown
  [pscustomobject]@{ session = $_.BaseName; system = $b.systemTokens; tools = $b.toolsTokens; messages = $b.messageTokens }
} | Sort-Object messages -Descending | Format-Table -AutoSize
```

真实输出（前 3 行）：

```
session                system tools messages
-------                ------ ----- --------
session-dab83ba1-6a6   14452   524   192798
session-4ae8f244-110   14452   524   184427
92fbcd95-7b01-471b-a   11640   524   178419
```

### C2 — 单会话 context 压力 / 耗时分解 / 吞吐

```powershell
$c = "$env:USERPROFILE\.dsh-community\storages\session_projcache\sessions"
$j = Get-Content "$c\session-de059c2d-971c-48ed-9e2e-4811d734be30.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$j.record.rows.contextPressure.val | Format-List
$j.record.rows.sessionStats.val   | Format-List
$j.record.rows.liveTokenUsage.val.last | Format-List
```

真实输出（节选）：

```
surfaceTokens        : 80512
contextWindow        : 500000
pressureTokens       : 96223
sampledSurfaceTokens : 79660
---
turns : 2    steps : 40   llmMs : 365398   toolMs : 514088
ttftMs : 147078   ttftSteps : 39   decodeMs : 218320   decodeTokens : 50068
---
turn : 2   step : 10   tokensPerSecond : 128   peakTokensPerSecond : 253   rateAlgorithmVersion : 2
```

### C3 / C7 — 工具 schema、技能目录、压缩触发、loop 计数（一个脚本全出）

把下面这段存成 `$env:TEMP\dsh-metrics.cjs`，然后
`node $env:TEMP\dsh-metrics.cjs <会话文件> [<投影缓存文件>]`：

```javascript
// dsh-metrics.cjs - DSH context / tool / loop baselines from one session log
// usage: node dsh-metrics.cjs <session.v3.jsonl.zstd> [projcache.json]
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
```

真实输出（节选，取证会话）：

```json
"loop":  { "turns": 3, "steps": 44, "toolCalls": 42, "toolResults": 41, "ptcDispatches": 108, "llmRetries": 5, "compactions": 0, "prunes": 0 }
"tools": { "count": 1, "names": ["run_code"], "jsonChars": 2078, "toolsTokens": 524 }
"systemPrompt": { "chars": 57790, "systemTokens": 14452, "sdkSectionChars": 49009, "sdkSectionTokens": 12253, "nonSdkChars": 8781 }
"sdk":   { "declaredTools": 68, "descriptionChars": 16662, "nativeLowerBoundJsonChars": 20046, "nativeLowerBoundTokens": 5016, "nativeWithEmptyParamsTokens": 5305 }
"skillsCatalog": { "catalogChars": 6089, "skills": 32, "catalogTokens": 1523 }
```

### C4 — `~/.agents/skills` 的名称 + 描述总量

```powershell
$rows = Get-ChildItem "$env:USERPROFILE\.agents\skills" -Directory | ForEach-Object {
  $f = Join-Path $_.FullName 'SKILL.md'
  if (-not (Test-Path $f)) { return }
  $t = Get-Content $f -Raw -Encoding UTF8
  $fm = [regex]::Match($t, '(?s)^---\r?\n(.*?)\r?\n---').Groups[1].Value
  $nm = [regex]::Match($fm, '(?m)^name:[ \t]*(.*)$').Groups[1].Value.Trim()
  $de = [regex]::Match($fm, '(?m)^description:[ \t]*(.*(?:\r?\n[ \t]+.*)*)').Groups[1].Value
  [pscustomobject]@{ dir = $_.Name; name = $nm; descChars = ($de -replace '\s+',' ').Trim().Length }
}
"count = $($rows.Count)"
"sum descChars = $(($rows | Measure-Object descChars -Sum).Sum)"
"sum nameChars = $(($rows | ForEach-Object { $_.name.Length } | Measure-Object -Sum).Sum)"
$rows | Sort-Object descChars -Descending | Select-Object -First 5 | Format-Table -AutoSize
```

真实输出：

```
skill count    = 32
sum descChars  = 6646
sum nameChars  = 392
dir          name         descChars
---          ----         ---------
ponytail     ponytail           827
pdf-to-txt   pdf-to-txt         473
obsidian-cli obsidian-cli       467
```

### C5 — 全局吞吐/日账

```powershell
$u = Get-Content "$env:USERPROFILE\.dsh-community\state\live-stats\usage-ledger.json" -Raw -Encoding UTF8 | ConvertFrom-Json
"updatedAt=$($u.updatedAt) peakTpsVersion=$($u.peakTpsVersion) peakTps=$($u.peakTps) dayRecords=$($u.records.Count)"
$u.records | Select-Object -Last 3 | Format-Table date,totalTokens,inputTokens,outputTokens,cacheReadTokens,turns,estimatedCost -AutoSize
```

真实输出：

```
updatedAt=1789972873570 peakTpsVersion=2 peakTps=9739 dayRecords=3
date       totalTokens inputTokens outputTokens cacheReadTokens turns estimatedCost
----       ----------- ----------- ------------ --------------- ----- -------------
2026-09-19    21628850      432235       297799        20898816   208     6.0667776
2026-09-21   103802783     3554144      1466377        98782262  1093 33.05157029999998
```

### C6 — 天 × 模型 账

```powershell
Get-Content "$env:USERPROFILE\.dsh-community\dsh-usage\usage-ledger.json" -Raw -Encoding UTF8 |
  ConvertFrom-Json | Select-Object -ExpandProperty days |
  ForEach-Object { $_.PSObject.Properties | ForEach-Object { "$($_.Name): $($_.Value.command.PSObject.Properties.Name -join ', ')" } }
```

真实输出（节选）：`2026-09-21: deepseek/deepseek-v4.1-flash, meta/muse-spark-1.3-contributor, z-ai/glm-5.3-flash`

### C7 — loop / 压缩计数（不需要投影缓存，只要会话日志）

```powershell
# 需要先把多帧 zstd 解出来；直接复用 C3 的脚本，读 out.loop / out.usage / out.perTurn
# 全机压缩事件普查（会解压全部会话，约 1 分钟）：
#   node $env:TEMP\dsh-metrics.cjs <每个会话文件> | Select-String '"compactions"|"prunes"'
```

## 5. 未发现 / 无法证实

1. **native 模式的 toolsTokens 真值：本机不存在。** 33 个活动会话日志全部 `agentPreset: "ptc"`；619 条投影缓存里 `toolsTokens` 的分布是 `{0: 587, 524: 32}`（0 的是 `import-imp-*` 导入会话，没有 `request/header`）。**未发现任何 native 或 both 会话。** `$APP/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/` 存在（`preset.yml` = 「标准模式」），`dsh-web-app/cordis.patch.yml:32-38` 的 `tools.mode` 默认也是 `native`（`mode: !!js process.env.DSH_TOOLS_MODE`，不设即 native），但要取到真值**必须新建一个 native 会话**（会写本机文件），超出本票只读边界。故本票只给**下界 5016 tokens**，并给出复现路径：把会话 preset 切到「标准模式」→ 跑 1 轮 → 用 C1/C2 读 `contextBreakdown.breakdown.toolsTokens`。
2. **68 个工具的真实 `parameters` JSON Schema 字节数：拿不到。** SDK 里只有 `jsonSchemaToTs` 的 TypeScript 投影（`dsh-tools/lib/index.js:1680-1687`），本机没有任何 native wire schema 落盘；`request/header` 在 ptc 下只有 `run_code`。因此 native 只能给下界，不能给等值估算 —— 我没有做「按 TS 类型长度反推 JSON Schema」的换算，那属于推测。
3. **压缩 / 剪枝：本机 0 例可引用。** `compaction/summary` / `compaction/prune` / surface 替换在 33 个会话日志里全部为 0。所以 §3.4 的字段语义**只有源码依据，没有实测样本**；`charsBefore/charsAfter`（`pruner/lib/index.js:182-188` 返回但未入事件）在会话日志里读不到，只能读 `shadowedTokenCount`。
4. **`sessions/<workspace-slug>/` 下没有独立的 token 统计文件。** 每个会话目录只有 `session.v3.jsonl.zstd`；没有 sqlite / index（web profile 里 `session-query-sqlite` 是内存态）。单会话统计只能走投影缓存或自己折叠事件。
5. **`~/.dsh-community/dsh-session-archive/` 是空的**（只有 `archive-ledger.json` 33 字节 + `state.json` 168 字节），无法从中找历史 native 会话。
6. **未调用 `/api/dsh-usage/overview` 等 HTTP 接口**，也未打开 GUI 的用量面板；本票所有数字都来自磁盘文件。
7. **`both` 模式在本机无任何样例**（没有会话、没有配置），因此「native 与 ptc 各占多少」里的 `both` 分支只有源码依据（`wireSchemas` 的第三个分支）。

## 6. 改造后的期望方向（与四句目的地要求对齐）

| 目的地要求 | 用哪几个指标证 | 期望方向 |
|---|---|---|
| **Context 成本下降** | `contextBreakdown.systemTokens` / `toolsTokens` / `messageTokens`、`contextPressure.surfaceTokens`、`skillsCatalog.catalogChars`、`tools:sdk` 段字符、`dsh-usage` 的日 `calls` | systemTokens 与 sdkSectionChars 下降；同负载下 surfaceTokens 下降；技能目录字符下降 |
| **Tool 管理能力提升** | `tool/ptc-dispatch` / `toolCalls` 比值、`request/header` 次数与 `reason`、`toolsTokens` | 出现按需激活（>1 次 `request/header`、`reason: "change"`）同时 `toolsTokens` 不升；单次程序内子调用数上升 |
| **Agent 稳定性提升** | `llm/retry` / `assistant/attempt`、`turn/end.data.reason.kind`、`peakTokensPerSecond`、`ttftMs` | 重试与错误收尾下降；`peakTokensPerSecond` / `ttftMs` 不劣化 |
| **长任务执行能力提升** | `turns` / `steps` 上限、`compaction/summary` 次数与 `shadowedTokenCount`、`compaction/prune` 次数、`turnOutline.turns.length` | 在**同一个可复现负载**下 turns/steps 上限提高；压缩事件开始 >0 且每次压缩后上下文回落到阈值以下 |

**对账纪律（避免自欺）**：所有指标必须「同一负载、改前改后各跑一次」，且至少同时看 `contextBreakdown` 三项的**和**——只看 `toolsTokens` 会因为 ptc 把成本搬到 systemTokens 而得出错误结论（本票已实测到这一点）。
