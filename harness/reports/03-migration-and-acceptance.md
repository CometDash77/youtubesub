# 03 — 迁移计划与验收口径（P0→P3）

本报告是 issue [#16](https://github.com/CometDash77/youtubesub/issues/16) 决议的落盘，外加 2026-09-21 本轮只读复核的实测值。票级事实以 #16 的 resolution comment 与 `harness/research/03-baseline-metrics.md` 为准；本报告另加两类证据：本轮实跑（命令 + 真实输出）与全机会话普查，均标 `[本轮实测]`。

状态输入：#16 为 `CLOSED`，其依赖的 9 张子票（#11–#19）全部 `CLOSED`；母 map #10 仍为 `OPEN`、进度 `95% · 待确认`。四态分离见 §3，P0–P3 明细见 §4–§7。

> 复核后状态（2026-09-21 本会话收尾）：用户采纳裁定 A 后，map #10 已 close 并改为 `## 进度：100%`；§1.3 的两条裁定与 §8 的移出范围已写入 issue #10 正文的 `## Out of scope` 段。本报告 §1.3 / §8 / §9 中「草稿为唯一依据」「复核时点仍 OPEN」的说法均为复核时点快照。


## 1. 验收口径：两笔账

### 1.1 两笔账的定义

| 账 | 改前实测（ptc 侧） | 说明 |
|---|---|---|
| (a) 声明成本 | wire `toolsTokens` **524** + `tools:sdk` 段 **12253** = **12777 tokens**；native 下界仅 **5016 tokens** | PTC 在声明上更贵，「省 schema」为假；native 只能给下界 |
| (b) 中间结果成本与往返 | 顶层 `tool/call` **85** 次 vs 程序内 `tool/ptc-dispatch` **233** 次 | PTC 真正省的是这里：子调用结果不进模型历史 |

来源：issue #16 resolution comment 的口径表。两笔账的机制依据见 `harness/research/03-baseline-metrics.md:10`（合计 12777 = 2.5 × native 下界 5016）与 `:103`。

### 1.2 对账纪律（三条，缺一不可）

1. **同负载、改前改后各跑一次**；不同负载的两次读数不构成证据。
2. **必须看 `contextBreakdown` 的 system + tools + message 三项之和**。
3. **只看 `toolsTokens` 会被骗**：PTC 把 native 的 schema 从 `request/header.tools` 搬到 system prompt 的 `tools:sdk` 段，toolsTokens 恒为 524，成本体现在 systemTokens 上。

三项之和的口径与逐位交叉验证见 `harness/research/03-baseline-metrics.md:131-141`；纪律原文见 `harness/research/03-baseline-metrics.md:410`。

### 1.3 口径收窄与范围裁定（2026-09-21）

- 用户采纳**收窄口径 A**：验收只认两笔账，见 `.scratch/wayfinder/investigation/draft-issue-10.close-comment.md:3,8`。
- 用户同时裁定：**「Agent 稳定性证据」与「长任务（压缩 / 剪枝）基线」移出本 map**，见 `.scratch/wayfinder/investigation/draft-issue-10.close-comment.md:9`。
- 复核注记：该裁定记在关闭总结草稿里；issue #10 本体在复核时点仍 `OPEN`（`95% · 待确认`），其 `Out of scope` 段（`gh issue view 10` 正文 L50-55）**未发现**已写入这两条。

## 2. 改前实测（基线）

### 2.1 声明成本与构成

| 指标 | 值 | 来源 |
|---|---|---|
| wire `tools` | 1 个（`run_code`）/ 2078 字符 / **524 tokens** | `harness/research/03-baseline-metrics.md:88-91`；[本轮实测] 复现 |
| `tools:sdk` 段 | **49009 字符 / 12253 tokens** | `harness/research/03-baseline-metrics.md:93`；[本轮实测] 复现 |
| 声明合计 | **12777 tokens** | `harness/research/03-baseline-metrics.md:103` |
| native 下界 | **5016 tokens**（20046 字符；补空 parameters 为 5305） | `harness/research/03-baseline-metrics.md:101` |
| 系统提示总量 | 57790 字符 / **14452 tokens**（非 SDK 部分 8781 字符） | `harness/research/03-baseline-metrics.md:92,96` |
| SDK 声明工具数 | **68** | `harness/research/03-baseline-metrics.md:97` |
| 逐工具均值 | 68 工具 / **47044 字符** / 均值 **692 字符/工具** | issue #16 P2-1 行；[本轮实测] 复现 |

### 2.2 往返与中间结果

| 指标 | 值 | 来源 |
|---|---|---|
| 顶层 `tool/call` | **85** 次 | issue #16 resolution comment（两笔账表） |
| 程序内 `tool/ptc-dispatch` | **233** 次 | issue #16 resolution comment（两笔账表） |
| 复核注记（[本轮实测]） | 全机 42 个会话日志的事件计数里**未发现**某一笔恰好停在 85 / 233：最接近的存活会话是 `session-de059c2d`（104 / 295）与 `session-4ae8f244`（64 / 234）。事件计数随会话进行单调增长，历史某时点的读数无法事后逐字复现；该 85 / 233 只能引 issue #16，不能当作可复跑基线 |

### 2.3 技能目录、压缩与剪枝

| 指标 | 值 | 来源 |
|---|---|---|
| 技能目录（`<available_skills>` 块） | **6089 字符 / 32 条**；整条 reminder 6734 字符 | `harness/research/03-baseline-metrics.md:108`；[本轮实测] 复现 |
| 目录的引擎计价 | **1692 tokens** | `harness/research/03-baseline-metrics.md:108`；[本轮实测] 复核 `liveTokenUsage.surface["12"] = 1692` |
| 磁盘侧 `~/.agents/skills` | 32 目录 / Σdescription 6646 字符 | `harness/research/03-baseline-metrics.md:110` |
| 压缩 `compaction/summary` | **33/33 会话 0 次** | `harness/research/03-baseline-metrics.md:11,153` |
| 剪枝 `compaction/prune` | **33/33 会话 0 次** | `harness/research/03-baseline-metrics.md:11,153` |
| 阈值 / 峰值 | 阈值 = contextWindow × 0.8 = **400k**；峰值 **205k** | `harness/research/03-baseline-metrics.md:11,153` |

[本轮实测] 复核：42 个会话日志的事件统计里 `compaction/summary` 与 `compaction/prune` **均为 0**；投影缓存里最大 `contextPressure.surfaceTokens` 为 **209584**（`session-de059c2d`，窗口 500000，即 41.9%）；另有 1 笔会话窗口为 1048576。目录块复核另见 §2.5 的方差说明。

### 2.4 本轮复核（只读实跑）

| 命令 | 结果 | 来源 |
|---|---|---|
| `harness\scripts\verify-dsh.cmd` | **6/6 PASS**、退出码 0：AgentLoop / ToolCalling / PluginLoading / Session / RuntimeIntegrity / SnapshotIntegrity | [本轮实测]；脚本 `harness/scripts/verify-dsh.ps1:31-136` |
| `node harness\scripts\validate-preset.cjs` | **PASS**：`rows.total = 21`、`packageRows = 17`、`presentationRows = 1`、`toolScope.denyPrefixes = 5`、`denyExact = 4` | [本轮实测]；脚本 `:47-80` |
| `node harness\scripts\test-tool-scope.cjs` | **PASS**：68 可见 → deny **42** → 保留 **26**；`savedChars = 24053` / `savedTokensEstimate = 6014` | [本轮实测]；脚本 `harness/scripts/test-tool-scope.cjs:86-100` |
| `node harness\scripts\sdk-budget.cjs <68 档会话>` | `declaredTools = 68` / `totalToolChars = 47044` / `perToolMeanChars = 692` / `sdkBlockChars = 49009` | [本轮实测]；脚本 `harness/scripts/sdk-budget.cjs:81-92` |

verify-dsh 本轮明细：AgentLoop `preset=ptc turns=1 steps=7`；ToolCalling `tool/call=7 tool/result=6 ptc-dispatch=17 modelSideSchemas=1`；PluginLoading `compositionRows=23 resolved=23 lockParses=True`；Session `systemTokens=13330 toolsTokens=524 messageTokens=26402`。

### 2.5 全机会话普查（[本轮实测]）

| 维度 | 复核值 |
|---|---|
| 会话日志总数 | **42**；`agentPreset` 全部为 **ptc**（0 个 native / 0 个 both） |
| `toolsTokens` 分布（投影缓存） | `{0: 1, 524: 41}` |
| `declaredTools` / `sdkSectionChars` 分布（41 个有 `system/message` 的会话） | `68/49009` × 11、`62/46179` × 11、`41/42281` × 9、`35/39451` × 8、`40/40617` × 2 |
| 目录块最大值 | 8430 字符 / 34 条（`1a93c5d3…`），大于取证会话的 6089 / 32 → 目录随插件装配变化，非常量 |
| mtime ≥ 2026-09-21T08:00Z 的会话 | 复核时点 **10** 个（日志仍在被并行会话写入，该数随时间变动）；issue #10 的复核评论当时记录为 **7** 个 |
| 与题面清单的差异说明 | `sdk-budget.cjs` 默认取「最新会话日志」；复核时点最新一笔是子代理会话（`62/46179`，工具面更窄），不是 68 档主会话。68 档（`68/49009`）在 41 个有 `system/message` 的会话里占 11 个，最新一笔是 `session-24232d0c`（2026-09-21T08:11:23Z）。判据读数必须在**选中 Lean 的主会话**上取，见 §9。 |

## 3. 四种状态总览（不许含糊）

| 状态 | 项 |
|---|---|
| **已完成** | P0 五项（P0-1 … P0-5）；P1-1 的源码与离线验证（在线生效未验）；P2-1 的度量脚本；#16 的全部决策 |
| **预测（未验证）** | P2-2：14452 → 约 8438 tokens（−42%）；判据 = `declaredTools` 68→26 且 `sdkSectionChars` 49009→约 25000 |
| **未做（附理由与触发条件）** | P1-2（不建，阈值见下）；P1-3（不采用，理由见下）；P2-3（不做，触发条件见下）；P3 四项只登记触发条件 |
| **移出范围** | 「Agent 稳定性证据」；「长任务（压缩 / 剪枝）基线」 |

## 4. P0 安全（五项全部完成）

| # | 项 | 修改位置 | 原因 | 风险 | 回滚 | 验证 | 状态 |
|---|---|---|---|---|---|---|---|
| P0-1 | 快照 + 回滚 + checkpoint 铁律 | `harness/scripts/backup-dsh.ps1`、`harness/scripts/restore-dsh.ps1`、`harness/README.md:45-60` | 动配置前必须有回退路径 | 无（纯加法） | 删脚本即可 | `selftest.cmd` 往返逐字节一致（`harness/scripts/selftest-backup-restore.ps1:56-57`；`backup-dsh.ps1:81-96` 写入后逐文件重新 sha256 自检；往返结论见 issue #10 正文 L35） | **完成** |
| P0-2 | 运行时完整性闸门 | `harness/scripts/verify-dsh.ps1:78-102`（`RuntimeIntegrity`） | 审计发现过「手工 patch 运行时文件、升级静默覆盖」这一无痕失效模式 | 误报（合法升级会变版本号，`:100`） | 忽略 / 调阈值 | 对 `known-good.json` 逐文件 sha256 比对 **[本轮实测] PASS** | **完成** |
| P0-3 | 不碰 `app.asar.unpacked` | 纪律 + 校验 | 升级即失效，且违反「不整体替换 Runtime」 | 无 | — | `RuntimeIntegrity` 全绿即证明未被改 [本轮实测] | **完成** |
| P0-4 | 凭据不外流 | `backup-dsh.ps1:48-55` 用白名单采集（`settings.yaml` / `.agent-presets` / profile 五文件 / skills）；`harness/README.md:25` 明示不纳入凭据；`.gitignore:7` 忽略 `harness/backups/` | 快照含账号 / 端点信息 | 无 | — | `git check-ignore` 命中 **[本轮实测]** | **完成** |
| P0-5 | 快照漂移可观测 | `harness/scripts/verify-dsh.ps1:104-136`（`SnapshotIntegrity`） | 改了配置要看得见 | 无 | — | 报告 `liveDrift` / `addedUnderAgentPresets` **[本轮实测] PASS** | **完成** |


## 5. P1 架构瓶颈

### P1-1 工具面按能力家族收窄 —— 已完成安装，在线生效未验

| 列 | 内容 |
|---|---|
| 修改位置 | `harness/preset/lean/{agent.cordis.yml,tool-scope.mjs,preset.yml}` → 装入 `<DSH_HOME>/.agent-presets/lean/` |
| 原因 | 声明块占系统提示 85%，且 42 个工具与当前用途无关 |
| 风险 | preset 挂载失败（仅影响该 preset，默认仍是官方 `ptc`） |
| 回滚 | 删 `<DSH_HOME>/.agent-presets/lean/` |
| 验证 | 离线：`test-tool-scope.cjs` PASS、`validate-preset.cjs` PASS [本轮实测]；**在线待验**：下个会话 `sdk-budget.cjs` 的 `declaredTools` 应从 68 变 26 |
| 状态 | **已完成（安装）｜opt-in｜在线生效未验（D1）** |

机制与边界：只用一行 `tool-scope` 模块行（`harness/preset/lean/agent.cordis.yml:290-291`，行定义见 `:285-297`），在 `agent/created` 时对 scoped registry 调 `restrict({ deny })`——因为要拿掉的工具大多来自 host 组合，preset 里卸不掉（`harness/preset/README.md:7`）。保留面（never-deny）含 `run_code` 与读写 / shell / 委派等，见 `harness/preset/lean/tool-scope.mjs:36-41`。

复核证据：`C:\Users\Administrator\.dsh-community\.agent-presets\lean\` 下实存 `agent.cordis.yml` / `preset.yml` / `tool-scope.mjs` 三个文件；`settings.yaml:9-10` 仍是 `agent-presets: default: ptc`，故默认 preset 未变，Lean 为选择项 [本轮实测]。

保守口径：被 deny 的 42 个工具里，`consult_expert` 与 `spawn_teammate` 可能是本 preset 自有注册，而 `restrict` 按 #14 的结论豁免本层注册，因此保守收益为 **约 5508 tokens**（24053 字符中扣掉这两行 1080 + 944），见 `harness/preset/README.md:24`。

### P1-2 Skill 按任务加载 —— 不做，附阈值

| 列 | 内容 |
|---|---|
| 位置 | 不建（不自建 skill router） |
| 原因 | 官方无 per-skill 开关、catalog 全有 / 全无；不删任何技能 |
| 收益对比 | 目录本体约 1523 tokens（6089/4）对可省工具声明 6014 tokens ≈ **1/3.9**（#16）；引擎计价 1692 tokens 对 SDK 段 12253 tokens ≈ **1/7.2**（#18）。两个比值基数不同，均如实登记 |
| 重开阈值 | `catalogChars > 12000` 或技能数 `> 64` 即重开决策 |
| 状态 | **未做** |

阈值来源：issue #18；亦见 issue #10 正文 Decisions so far 的 #18 行（L37）。

### P1-3 `both` 模式 / SDK generation 增强 —— 不采用

| 列 | 内容 |
|---|---|
| 位置 | 不采用 |
| 原因 | 无 composition 用 `both`；`presentAs` 每 scope 只能声明一次，且与内置 `ptc` preset 的 `tool-presentation` 行冲突 |
| 判据位置 | 理由与判据写在票 #15；机制依据见 #14 与 `harness/research/04-dynamic-visibility.md` |
| 状态 | **未做（不采用）** |

## 6. P2 性能

### P2-1 逐工具 / 逐家族声明预算 —— 已完成

`harness/scripts/sdk-budget.cjs` 从会话日志逐条量出每个工具在 `ToolArgsMap` + `ToolOutputMap` 两块的字符数，并按家族聚合（`harness/scripts/sdk-budget.cjs:34-54,72-92`）。[本轮实测] 三笔 68 档会话结果一致：`declaredTools = 68`、`totalToolChars = 47044`、`perToolMeanChars = 692`；家族分布 `core 17/11051`、`fs+shell 9/11046`、`mcp/playwright 24/6185`、`ssh 6/5895`、`agent-team 4/4076`、`goal 3/3881`、`delegation 2/2918`、`jobs 3/1992`。

### P2-2 声明成本下降 —— 预测（未验证）

| 列 | 内容 |
|---|---|
| 预测 | 系统提示 14452 → **约 8438 tokens（−42%）** |
| 算法 | 14452 − 6014 = 8438；6014 / 14452 = 41.6% ≈ 42% [本轮实测 计算复核] |
| 判据 | 下个会话 `declaredTools` **68 → 26** 且 `sdkSectionChars` **49009 → 约 25000** |
| 承载项 | 由 P1-1 承载（不是独立改造） |
| 状态 | **预测（未验证）** |

来源：issue #16 P2-2 行；`harness/preset/README.md:22`；`harness/preset/lean/preset.yml:2`。26 = 68 − 42；约 25000 的由来是 49009 − 24053 = 24956。

### P2-3 压缩 / tool-result 剪枝调优 —— 不做，附触发条件

本机 33/33 会话从未触发（阈值 400k、峰值 205k），**无基线可比**；要证明它必须先造 >400k 负载，本次不做。触发条件：**出现长任务被截断 / 丢失上下文的实测案例**。来源：issue #16 P2-3 行。状态：**未做**。

## 7. P3 未来能力（只登记触发条件，不投入）

| 项 | 现状 | 触发条件 |
|---|---|---|
| Code Runtime 增强 | `run_code` 已是独立 Node 子进程 + 长度前缀 JSON 管道，预算 120s / 600s、64MiB 输出、512MB heap、并发 10 | 出现「单次程序被 64MiB 输出上限或 10 并发子调用卡住」的实测案例 |
| Context 检索 | storage 侧只有压缩与剪枝，无检索 | 同一任务反复需要跨会话历史 |
| MCP 子进程治理 | 属 profile 组合层，不在 A+C 面内（票 #19） | 由 #19 登记为未解决项；是否在桌面端插件管理里禁用 browser-use 待定 |
| 本机内分层（Decision / Reasoning / Execution / Memory） | 与 Hermes 无关的部分暂无独立诉求；本机只有单一 Runtime + 单一 Profile | 出现第二个 Runtime 或第二个 Profile |

来源：issue #16 P3 段；#19；#10 正文 L38、L48。

## 8. 移出范围（用户 2026-09-21 裁定）

| 项 | 裁定 | 依据 |
|---|---|---|
| 「Agent 稳定性证据」 | 移出本 map，不再作为本 map 的验收项 | `.scratch/wayfinder/investigation/draft-issue-10.close-comment.md:9` |
| 「长任务（压缩 / 剪枝）基线」 | 移出本 map；因此 P2-3 只登记触发条件、不建基线 | `.scratch/wayfinder/investigation/draft-issue-10.close-comment.md:9`，与 #16 P2-3 判定一致 |
| Hermes / Jev / Skill Router / Context Engine 融合设计 | 与 Hermes 无关，改造限于本项目 | issue #10 正文 Out of scope（L52）；`.scratch/alignment/20260921-1530-harness-对齐成果.md:31` |

原 Destination 的四项硬条件里，`contextBreakdown` 的两个稳定性 / 长任务维度即由此移出；剩余两笔账（声明成本、中间结果与往返）为本 map 的验收范围。

## 9. 带出条件 D1：Lean 在线生效判据

| 列 | 内容 |
|---|---|
| 判据命令 | `node harness/scripts/sdk-budget.cjs`（在**选中 Lean 的主会话**里跑） |
| 判据 | `declaredTools` 68 → 26；`sdkSectionChars` 49009 → 约 25000 |
| 不达预期的回滚 | 删除 `<DSH_HOME>/.agent-presets/lean/`，并把默认 preset 切回官方 `ptc` |
| 回滚快照 | `harness/backups/20260921-152631-before-lean-preset` |
| 现状 | **未验证**：全机普查 42/42 会话仍是 `ptc`，Lean 从未在真实会话跑过 |

来源：`.scratch/wayfinder/investigation/draft-issue-10.close-comment.md:31-33`；issue #10 正文 L69（未闭环第 1 条）。

## 10. 执行顺序

P0-1 → P0-4（已完成）→ P1-1（已完成安装，待下个会话在线确认）→ P2-1 / P2-2（度量已完成、预测待验）→ 其余按触发条件。来源：issue #16 执行顺序段。

## 来源

1. issue #16（`gh issue view 16 --comments`，resolution comment）—— 两笔账口径、P0 五项、P1/P2/P3 表、执行顺序、85 / 233 往返、预测 14452 → 8438。
2. issue #10（`gh issue view 10`）—— L33 对账纪律、L35 P0 与 selftest、L36–L39 P1/P2/P3 判定、L50-55 Out of scope、L69 D1 未闭环、L71 报告落点。
3. issue #13、#14、#15、#17、#18、#19 —— 基线口径与各决策票结论。
4. `harness/research/03-baseline-metrics.md:10-11`、`:29-44`、`:86-101`、`:103`、`:105-117`、`:131-141`、`:143-153`、`:401-410`。
5. `harness/preset/README.md:5-9`、`:11-24`、`:26`、`:36-46`。
6. `harness/preset/lean/preset.yml:1-3`；`harness/preset/lean/tool-scope.mjs:29-55`、`:76-131`；`harness/preset/lean/agent.cordis.yml:1-10`、`:285-297`。
7. `harness/scripts/verify-dsh.ps1:31-136`（六项体检）；`harness/scripts/backup-dsh.ps1:21-55`、`:81-96`；`harness/scripts/selftest-backup-restore.ps1:40-57`。
8. `harness/scripts/sdk-budget.cjs:1-92`；`harness/scripts/validate-preset.cjs:1-84`；`harness/scripts/test-tool-scope.cjs:1-101`。
9. `harness/README.md:14`、`:16-27`、`:42-43`、`:45-60`；`.gitignore:7`。
10. `.scratch/wayfinder/investigation/draft-issue-10.close-comment.md:3`、`:8-10`、`:31-37`；`.scratch/alignment/20260921-1530-harness-对齐成果.md:31`、`:75-76`、`:82`、`:92`、`:139-142`。
11. [本轮实测] 命令与输出：`harness\scripts\verify-dsh.cmd`（6/6 PASS，退出码 0）、`node harness\scripts\validate-preset.cjs`、`node harness\scripts\test-tool-scope.cjs`、`node harness\scripts\sdk-budget.cjs`（68 档会话指定路径）、`node harness\scripts\session-metrics.cjs`、全机会话普查（42 个 `session.v3.jsonl.zstd` 事件计数 + 42 个投影缓存 `contextPressure` / `contextBreakdown` / `liveTokenUsage.surface`）。
