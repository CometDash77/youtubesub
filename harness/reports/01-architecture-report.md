# 01 — 架构审计报告：本机 DSH Desktop 运行时现状与目标形态的差距

审计对象：本机 DeepSeek Harness Desktop（Electron 社区壳 + 官方 `@deepseek-ai/dsh` 内核）。审计时间基准沿用来源票：**2026-09-21**。

口径与标记：

- 本报告是**只读审计**：除本文件外，未修改仓库任何文件、未改任何 GitHub issue、未执行写盘或改配置命令。
- 标 **[本轮实测]** 的数字由本报告在本次执行中直接读盘或复算得到（方法：读活配置 + 复算 `harness/scripts/verify-dsh.ps1:56-63` 的 composition 行计数逻辑）。
- 其余数字均给出出处文件与行号；查不到依据的一律写「未发现」，不做推测。
- 路径别名沿用 `harness/research/01-environment-audit.md:9-16`：`$ASAR`/`$APP`/`$RES`/`$DSH`=`C:/Users/Administrator/.dsh-community`/`$AGENTS`。

## 1 目标形态（issue #10 的 Destination）

issue #10 的 Destination 逐字要求：

> 把本机这套 DeepSeek Harness Desktop 改造到 `Model → Runtime → Skills/Tools → Execution Environment → Context Management` 形态，并**用实测证据**说明收益……源码、脚本与报告全部落在本仓 `harness/`，本机只做安装与启用。

验收硬条件（同一段逐字）：必须能证明 **Context 成本下降、Tool 管理能力提升、Agent 稳定性提升、长任务执行能力提升**——不允许只给结论。

下表是**本报告对五层目标含义的归纳**（非 issue 原文逐字），用于逐层对照：

| 层 | 归纳出的目标含义 | 对照章节 |
|---|---|---|
| Model | 模型/provider/pinned 与 value-mode 分层清晰、取值可核 | §2.1 |
| Runtime | 壳与内核边界清楚、装配可复算、兼容补丁可追踪 | §2.2 |
| Skills/Tools | 工具可见性可控、技能按需而非全量注入 | §2.3 |
| Execution Environment | 执行隔离与沙箱分层、预算与并发有界 | §2.4 |
| Context Management | 声明成本与中间结果成本可分开计量、压缩路径有基线 | §2.5 |

## 2 目的地五层逐层对照

### 2.1 Model 层

| 项 | 本机现状 | 出处 |
|---|---|---|
| 默认 preset | `agent-presets.default: ptc` | `$DSH/settings.yaml:9-10` [本轮实测] |
| provider | `command`（displayName `commandcode`），`api: openai-completions`，baseURL `https://api.commandcode.ai/provider/v1` | `$DSH/settings.yaml:27-33` [本轮实测] |
| 模型窗口 | `deepseek/deepseek-v4.1-flash` contextWindow `500000`；`z-ai/glm-5.3-flash` `1048576` | `$DSH/settings.yaml:44-49` [本轮实测] |
| pinned | `command` / `deepseek/deepseek-v4.1-flash`；disabledProviders 含 `openai-codex` | `$DSH/settings.yaml:59-65` [本轮实测] |
| value-mode | `enabled: true`；expert = `command` / `deepseek/deepseek-v4.1-flash`；executor = `command` / `z-ai/glm-5.3-flash`；`strategy: powerful` | `$DSH/settings.yaml:13-21` [本轮实测] |
| 默认模型 | `agent-default-model` = `command` / `deepseek/deepseek-v4.1-flash` | `$DSH/settings.yaml:77-79` [本轮实测] |
| 子代理白名单 | `subagent-model-selection.allowedModels` 只有 2 个模型（同上 expert/executor 两个） | `$DSH/settings.yaml:80-86` [本轮实测] |
| 每会话模型侧工具 schema | **恒 1 个**：本机 33 个 session 共 49 条 `request/header`，49/49 的 `header.tools` 长度 = 1 且名字 = `run_code` | `harness/research/01-environment-audit.md:157` |

Model 层结论：取值本身**完整可核**（provider/pinned/value-mode 三处都在活文件里逐行可读），不存在「声明一套、跑另一套」的证据。但目标形态的 model 分层（Decision/Reasoning/Execution 之类）在 issue #10 中已被用户判定为与 Hermes 无关，本报告**未发现**本机存在该类分层配置。

### 2.2 Runtime 层

| 项 | 本机现状 | 出处 |
|---|---|---|
| 外壳 | `@linxin666/dsh-desktop` **4.2.1**（第三方社区壳，维护者 ningbainb） | `harness/research/01-environment-audit.md:35`、`:125` |
| 内核 | 官方 `@deepseek-ai/dsh` **0.1.6-alpha.2**，带 integrity 与逐文件 sha256 | `harness/research/01-environment-audit.md:37`、`:126` |
| 兼容补丁 | 走**运行时 patch 注册表**（非改源码），共 **7 个 id**：`cancellation-presentation`、`desktop-skin-profile-isolation`、`queued-turn-continuation`、`session-startup-corruption`、`tool-call-arguments-envelope`、`tools-capability-request-side`、`transcript-tool-call-balance` | `harness/research/01-environment-audit.md:127` |
| Profile | 只有 `desktop` 一个；`cordis.yml` **2 行**（composition 为空数组，组合全靠 patch 层） | `$DSH/profiles/desktop/cordis.yml:1-2` [本轮实测；同 `harness/research/01-environment-audit.md:76`] |
| 装配行 | `cordis.patch.yml` **107 行**；compositionRows = **23** / resolved = **23** | 107 行 [本轮实测]；23/23 [本轮实测]，与 `harness/scripts/verify-dsh.ps1:56-68` 的判据同逻辑 |
| layer 顺序 | bundle patch → Profile `cordis.patch.yml` → `--patch primary-full-user.yml` → `--patch desktop-pipe.patch.yml`（后写赢） | `harness/research/01-environment-audit.md:76` |
| Profile 依赖 | `desktop-plugins.lock.json` **60 项**（enabled 43、managedByDesktop 58、用户自装 2） | `harness/research/01-environment-audit.md:114` |

Runtime 层结论：**壳/内核边界与「不是官方发行版、不是源码 fork」的判定证据齐全**（安装目录只有 asar/unpacked 产物，无 `apps/`、`packages/`、`pnpm-lock.yaml` 源码树，见 `harness/research/01-environment-audit.md:127`）。装配行在本轮可复算且全解析成功。

### 2.3 Skills/Tools 层

| 项 | 本机现状 | 出处 |
|---|---|---|
| 注册点 | 全机 `tools.register(` 共 **79 处 / 44 个包**；本机 `dsh-tool-*` 包 20 个 | `harness/research/01-environment-audit.md:144` |
| 每会话工具数 | **35~68**，5 档：35 / 40 / 41 / **62** / 68（随 Profile 装配与是否挂 MCP 变化） | `harness/research/01-environment-audit.md:159-169` |
| 模型实际看到 | 恒 1 个 `run_code`（49/49 条 `request/header`） | `harness/research/01-environment-audit.md:157` |
| 技能发现根 | 只有 `$AGENTS/skills` 存在，**32 个目录**；`.dsh/skills`、`<cwd>/.agents/skills`、`$DSH/skills` 均不存在 | `harness/research/01-environment-audit.md:115`、`:193` |
| 技能注入形态 | 目录（名称 + 一行 description）作为**一条 `user/message` 全量注入**；33 个 session 里 32 个各含且仅含 1 次（6734~9075 字符） | `harness/research/01-environment-audit.md:194`、`harness/research/03-baseline-metrics.md:108` |
| 注入体积（取证会话） | `<available_skills>` 块 **6089 字符 / 32 条**，整条 reminder 6734 字符，引擎计价 **1692 tokens** | `harness/research/03-baseline-metrics.md:108` |
| router | **未发现**任何 router / 自动匹配 / 向量召回 / 规则路由；`skill` 工具形参只有一个精确 `name` | `harness/research/01-environment-audit.md:198-201` |
| 按名启停 | **未发现**（patch 层、settings、`skill` schema 里都没有对应键） | `harness/research/01-environment-audit.md:252` |
| 实际使用分布 | `tool/ptc-dispatch` 共 2387 条；前 6 个工具占约 72% 调用；24 个 MCP 工具本机 **0 次**调用 | `harness/research/01-environment-audit.md:171` |

Skills/Tools 层结论：**「注册多少」不是固定数**，而是每会话集合；可见性治理的接缝存在（§5.2），但**技能侧是全量注入 + 无按任务加载**。

### 2.4 Execution Environment 层

| 项 | 本机现状 | 出处 |
|---|---|---|
| 执行器 | `run_code` = **全新 Node 子进程**，`language = "typescript"`、`isolation = "process"` | `harness/research/02-ptc-mechanism.md:60` |
| 进程边界 | 4 字节大端长度前缀 + JSON frame；子进程先发 `ready`，宿主再发 `boot`；代码在子进程内 `AsyncFunction` 求值 | `harness/research/02-ptc-mechanism.md:66-67` |
| 沙箱 | 与 pwsh **同一策略源、同一 confine 提供方、同一 approval 通道**（`ctx.sandbox` + `ctx.sandboxPolicy` + `ctx.approval`）；差别在授权粒度（`subject: "program"` vs `subject: "command"`） | `harness/research/02-ptc-mechanism.md:73-76`、`:104` |
| 本机沙箱档位 | `sandbox-policy.mode: danger-full-access`、`approval.policy: never`（用户 overlay 全文 2 行） | `harness/research/01-environment-audit.md:78-93` |
| 墙钟预算 | `timeoutMs` 默认 **120000**，上限 `maxTimeoutMs` **600000**；`run_code` 自身无 `timeoutMs` 字段，不与工具层超时叠加 | `harness/research/02-ptc-mechanism.md:88-89`、`:99` |
| 输出上限 | `maxOutputBytes` **67108864**（64 MiB，宿主与子进程双重记账）；`maxMessageBytes` 134217728 | `harness/research/02-ptc-mechanism.md:90`、`:92` |
| 堆上限 | `maxOldGenerationSizeMb` **512**（`--max-old-space-size=`） | `harness/research/02-ptc-mechanism.md:91` |
| 并发 | `maxParallelSubCalls` **10**；`maxPendingCalls` 128；`graceMs` 3000 | `harness/research/02-ptc-mechanism.md:98`、`:93`、`:94` |
| 环境清理 | 子进程环境只留 PATH/PATHEXT/SYSTEMROOT/WINDIR/TEMP/TMP，并额外剔除 `ELECTRON_RUN_AS_NODE` | `harness/research/02-ptc-mechanism.md:78` |

Execution Environment 层结论：隔离、预算、并发**都有界且在 host composition 行生效**（本机 `ptc-runtime` 行未写 config，取默认值，`harness/research/02-ptc-mechanism.md:84`）。但**沙箱实际档位是最宽的 `danger-full-access`、审批是 `never`**——这是用户选定组合，见 §4.3。

### 2.5 Context Management 层

| 项 | 本机现状 | 出处 |
|---|---|---|
| 系统提示分段 | 三段相关：`tools:ptc-only`（order 800，正文 = `PTC_ONLY_INSTRUCTION`）、`tools:sdk`（order 5000，`interpolate: false`）、各工具自己的 `TOOL_*` 指南段 | `harness/research/02-ptc-mechanism.md:43`、`:50` |
| 提示体积（取证会话） | 系统提示 **57790 字符 / 14452 tokens**；其中 `tools:sdk` **49009 字符 / 12253 tokens**，其余（工作区指令/插件/MCP）8781 字符 | `harness/research/03-baseline-metrics.md:92-96` |
| 声明成本合计 | 524（`run_code` wire，JSON 2078 字符）+ 12253 = **12777 tokens**；native 下界 **5016 tokens**（20046 字符） | `harness/research/03-baseline-metrics.md:89-91`、`:101`、`:103` |
| 压缩链 | `compaction-basic` + `command-compact` + `tool-result-pruner`（ptc preset 行） | `harness/research/01-environment-audit.md:104`、`:225` |
| 压缩阈值 | `DEFAULT_THRESHOLD_RATIO = 0.8`、`DEFAULT_RETAIN_RATIO = 0.16`、`auto ?? true`（默认 400k 触发） | `harness/research/03-baseline-metrics.md:148` |
| 剪枝预算 | `thresholdChars: 8192 / headChars: 4096 / tailChars: 1024` | `harness/research/01-environment-audit.md:225`、`harness/research/03-baseline-metrics.md:150` |
| 本机触发次数 | **0**：33 个 session 全文扫描 `compaction/summary` = 0、`compaction/prune` = 0、surface 替换 = 0 | `harness/research/01-environment-audit.md:232`、`harness/research/03-baseline-metrics.md:69-71`、`:153` |
| 实测峰值 | 33 会话最高 `surfaceTokens` **205526**（= 窗口 41.1%），远低于 400k 触发线 | `harness/research/03-baseline-metrics.md:11`、`:153` |

Context Management 层结论：**声明成本与中间结果成本已被分账**（`contextBreakdown` 三项 + `request/header` + `tool/ptc-dispatch`，`harness/research/03-baseline-metrics.md:36`、`:405-408`），但**压缩路径本机 0 次触发、无基线可比**。

## 3 版本与权威出处三层、Profile 装配、存储、MCP

### 3.1 版本权威出处三层

`harness/research/01-environment-audit.md:22` 把版本权威解算固定为三层，逐层可核：

| 层 | 文件 | 本机值 |
|---|---|---|
| 打包清单 | `$ASAR/package.json` | `@linxin666/dsh-desktop` 4.2.1 |
| 运行时锁（随安装器分发） | `$RES/runtime-support/known-good.json` | `version: 4.2.1`（`:13-14`）；官方运行时 `0.1.6-alpha.2`（`:19-21`，含 integrity）；`compatPatches.registry` 指向 `packages/dsh-desktop-compat/src/patch-registry.ts` |
| Profile 侧 | `$DSH/profiles/desktop/{package.json, desktop-plugins.lock.json}` | 全部 `link:` 指向 `$APP/node_modules/@deepseek-ai/...`；逐包 `version` = 0.1.6-alpha.2 |

旁证材料 `D:/Documents/vibe/_dsh_diag` 来自 4.1.0，本票口径**不使用**（`harness/research/01-environment-audit.md:22`）。支持矩阵另有 `supported-runtimes.json`：`desktopRange: "=4.2.1"`、`upstreamVersion 0.1.6-alpha.2`、`verifiedAt 2026-09-18`。

### 3.2 Profile 与插件装配

- `cordis.yml` 只有 2 行（Electron-owned 空根，注释声明 composition 由 patch 层供给）[本轮实测，同 `harness/research/01-environment-audit.md:76`]。
- `cordis.patch.yml` 首行是 `# --- dsh-desktop managed (auto-generated; do not edit) ---`，共 107 行，含逐行 `disabled: true` 的官方 web-ui 行 + `insert` 社区行 [本轮实测行数；内容见 `harness/research/01-environment-audit.md:77`]。
- 复算结果：compositionRows = **23**、resolved = **23**、unresolved 空 [本轮实测]。
- 用户 overlay 由 Runtime 命令行 `--patch` 供给，全文 2 行（`sandbox-policy` / `approval`，见 §4.3）。

### 3.3 会话与投影缓存存储

| 实体 | 落点 | 规模/性质 |
|---|---|---|
| session | `$DSH/sessions/<encoded-cwd>/<id>/session.v3.jsonl.zstd`（多帧 zstd 容器，3 个项目目录、33 个 session） | `harness/research/01-environment-audit.md:119`、`:219` |
| 投影缓存 | `$DSH/storages/session_projcache/sessions/<id>.json`（**本机唯一的缓存/索引实体，不是向量库**） | 每 session 13~47 KB；`harness/research/01-environment-audit.md:118`、`:222` |
| loop 派生指标 | 同文件的 `contextBreakdown` / `contextPressure` / `liveTokenUsage` / `sessionStats` | `harness/research/03-baseline-metrics.md:127` |
| 其它 state | `$DSH/state/external-conversation-imports-v2.json`（562185 B）、`dsh-usage/{usage-ledger,provider-snapshots}.json`、`memory/<principalId>`（空）、`worktrees/registry.json`（3 B） | `harness/research/01-environment-audit.md:118`、`:223` |

### 3.4 MCP 子进程

- Runtime 的子进程里有 **8 个** `@playwright/mcp/cli.js --browser chromium --isolated --executable-path "...msedge.exe"`，父进程均为 Runtime PID 14668。
- 这 8 个进程是 `mcp__playwright-mcp__*` **24 个工具**的来源；本机 33 个 session 里这些工具**0 次调用**。
- **无法证实**：8 个进程与「每会话一个」的精确对应关系——只能证实它们同为 Runtime 14668 的子进程且并发存在 8 个。
- 出处：`harness/research/01-environment-audit.md:69`、`:145`、`:171`、`:256`。

## 4 安全面

### 4.1 2026-09-18 的手工 patch 与 4.2.1 静默覆盖

- 会话记录（真实存在）：`$DSH/sessions/--D-Documents-~7535~5546WORKWORK--/session-439c4780-70f6-4fce-93cd-45e052460529/session.v3.jsonl.zstd` 的 `user/message seq9` 原文记录了「已完成补丁写入：`.../app.asar.unpacked/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/index.js`」并在结尾自陈「未来 DSH 更新可能覆盖此补丁」；该 session `createdAt` = **2026-09-18T01:48:59Z**。
- 当前状态：`grep "process\.execPath\.toLowerCase"` 在 `$APP/node_modules` 全树 **0 命中**；`dsh-ptc-runtime-node/lib/index.js` 只在 `:956` 出现 `ELECTRON_RUN_AS_NODE`，语义是**从子进程环境剔除**它（原始官方行为）。
- 时间证据：`$APP/node_modules/@deepseek-ai` 下 **270 个包目录 mtime 全部为 2026-09-21T00:55:45~00:55:59Z**，晚于补丁时间 → 该手工补丁**已被 4.2.1 安装覆盖，本机现存运行时无此改动**。
- 出处：`harness/research/01-environment-audit.md:133-134`。

结论：对安装目录内官方包做手工改动**无痕、且升级即失效**——这正是 issue #10 Notes 里用户选定「只改用户侧 + 自建包」的表面理由。

### 4.2 known-good.json：随安装器分发的运行时锁

`$RES/runtime-support/known-good.json` 随安装器分发，内含官方运行时包的 integrity 与**逐文件 sha256**。`harness/scripts/verify-dsh.ps1:78-101` 的第 5 项 `RuntimeIntegrity` 正是拿它做门禁：逐文件比对 sha256、缺失记 `missing`、漂移记 `drift`、版本不等记 `version`，全过才 PASS。该项的注释逐字写明它针对的就是 §4.1 的失败模式（「hand-patching a file inside the installed runtime leaves no trace and is silently overwritten by the next upgrade」，`harness/scripts/verify-dsh.ps1:79-80`）。

### 4.3 写入面 A+C

issue #10 Notes 逐字限定写入面：**用户侧配置（`~/.dsh-community`、`~/.agents/skills`）+ 自定义 preset / Cordis 插件 / skill 包**，**不碰** `app.asar.unpacked` 里的官方包（升级即失效）；产出物全部落本仓 `harness/`。本报告未发现该边界被越过的证据；唯一一次越界尝试见 §4.1，且已被升级覆盖。

对应地，`harness/README.md:18-25` 把快照范围固定为 A+C 的四个面（`settings.yaml`、`.agent-presets/**`、`profiles/desktop/*`、`~/.agents/skills/**`），并显式**排除**凭据文件、`sessions/`、`storages/`、`state/`、`attachments/` 与安装目录 `app.asar.unpacked`。

## 5 差距结论

### 5.1 与目标形态相比的不足

| # | 不足 | 证据 |
|---|---|---|
| 1 | **声明成本占据系统提示主体**：`tools:sdk` 占系统提示 79%~84%；取证会话 49009/57790 ≈ 84.8%（本报告按两个来源值相除得到，非来源逐字数值） | `harness/research/01-environment-audit.md:236`、`harness/research/03-baseline-metrics.md:92-93` |
| 2 | **PTC 并不省声明 token**：声明合计 12777 tokens，是 native 下界 5016 的 2.5×；省的是往返（顶层 `tool/call` vs 程序内 `tool/ptc-dispatch`） | `harness/research/03-baseline-metrics.md:10`、`:103` |
| 3 | **技能全量注入**：32 条目录摘要作为一条 `user/message` 注入，会话开始一次；本机 32/33 会话各 1 次 | `harness/research/01-environment-audit.md:194`、`:209` |
| 4 | **无按任务加载**：未发现 router/自动匹配/语义召回；`skill` 只接受精确名字；无按名启停配置 | `harness/research/01-environment-audit.md:198-201`、`:252` |
| 5 | **压缩路径无基线**：33/33 会话压缩与剪枝从未触发，52 项里的「改后更好」当前无基线可比 | `harness/research/03-baseline-metrics.md:11`、`:153`、`:395` |
| 6 | **MCP 子进程无治理**：8 个进程并发存在，归属无法从进程表断定；已登记为未解决项 | `harness/research/01-environment-audit.md:69`、`:256` |

补一条**落地进度**（不计入上表，避免把「已做」当「缺口」）：P1-1 的 Lean preset 落地物已在位——`harness/preset/lean/` = 官方 `ptc` preset 逐字拷贝 + 一行 `tool-scope` 本地模块；`validate-preset.cjs` PASS（21 行 / 17 package 行全解析 / `tool-presentation` 行保留），`test-tool-scope.cjs` PASS（68 可见 → deny 42 → 保留 26）。但该 preset **从未在真实会话里生效**：全机 session 日志普查全部 `agentPreset=ptc`，最新会话 `declaredTools=68 / sdkSectionChars=49009`，与基线逐位相同；`68→26 / 49009→约 25000` 仍属预测。出处：issue #10 进度段（复核时点 95% · 待确认）。

### 5.2 已具备的能力（不是缺口）

| 能力 | 本机证据 |
|---|---|
| **scope 注册表** | 唯一可见性解析器 `view(scope)` 喂 presentation / lookup / dispatch 三处；scoped 注册遮蔽 global；`run_code` 永不进全局层 | `harness/research/02-ptc-mechanism.md:142-148`、`harness/research/01-environment-audit.md:152` |
| **restrict / presentAs 接缝** | `register` / `restrict({allow,deny})` / `guard()` / `presentAs(mode)` 全部返回 disposer；`presentAs` 一个 scope 只能声明一次；直呼拒绝是能力层而非提示层 | `harness/research/02-ptc-mechanism.md:149-152`、`:169`、`:44`；issue #10 Decisions so far（#14） |
| **sandbox 分层** | `sandbox` / `sandbox-policy` / `pwsh-sandbox` 都是 host-plane 行；PTC 与 pwsh 同策略源、不同执行器与授权粒度 | `harness/research/02-ptc-mechanism.md:160`、`:104` |
| **checkpoint 安全网** | 铁律「先快照、再 checkpoint、才动配置」+ 仓库层/机器配置层双层回滚；`verify-dsh.cmd` 本轮实跑 **6/6 PASS**（退出码 0）；基线快照 108 文件 / 497 KB | `harness/README.md:45-60`、`:62-66`；issue #10 进度段（复核时点 95% · 待确认） |
| **版本完整性门禁** | `RuntimeIntegrity` 用 known-good.json 逐文件 sha256 对账，专治 §4.1 的静默漂移 | `harness/scripts/verify-dsh.ps1:78-101` |

### 5.3 一句话差距

**本机的「执行环境 + 沙箱 + 注册表接缝 + 回滚安全网」已经达到目标形态所需的形态；差距集中在可见性治理的「未生效」与上下文账的「无改后基线」**：声明成本仍占系统提示约 85%（第 1 条）、技能仍全量注入且无按任务加载（第 3、4 条）、压缩路径 0 次触发因此改后无从对比（第 5 条）、MCP 子进程仍在 profile 组合层无人治理（第 6 条）。Lean preset 已把第 1 条的对策做出来并离线验证，但 D1（在线生效）在 issue #10 里被明确列为未闭环。

## 6 未发现 / 无法证实

1. **未发现**原生官方发行标识：安装器、更新通道、包名、appId、作者均指向第三方（`harness/research/01-environment-audit.md:250`）。
2. **未发现**技能 router / 自动路由 / 语义召回；**未发现**技能的按名启停配置（同上 `:251-252`）。
3. **未发现** compaction 真实执行过的任何记录（33 个 session 全文 0 命中 `compact`）（同上 `:253`）。
4. **未发现**本机存在第二个 Runtime、第二个 Profile 或 native/both 展示模式的会话（同上 `:254`；`harness/research/03-baseline-metrics.md:393`）。
5. **未发现** `C:/Users/Administrator/.dsh` 目录，SSH 插件文档提到的 `~/.dsh/dsh-ssh.json` 本机未发现（同上 `:255`）。
6. **无法证实** 8 个 playwright MCP 子进程与会话的一一对应关系（同上 `:256`）。
7. **无法证实** native 模式的 toolsTokens 真值——本机不存在 native 会话，只有下界 5016 tokens（`harness/research/03-baseline-metrics.md:393`）。
8. **无法证实** 68 个工具真实 `parameters` JSON Schema 的字节数——SDK 里只有 TS 投影（同上 `:394`）。
9. **本报告新引入的一项计算值**：49009/57790 ≈ 84.8% 由两个来源数字相除得到，来源未逐字给出该百分比；来源给出的区间是 79%~84%（`harness/research/01-environment-audit.md:236`）。

## 来源

- `harness/research/01-environment-audit.md:3-5`（审计时间基准）、`:9-16`（路径别名）、`:22`（版本权威出处三层与旁证不使用）、`:24-25`（会话解码与 PTC 子进程事实）、`:33-42`（版本号表）、`:44-49`（安装方式与更新通道）、`:51-71`（Host/Runtime/MCP 进程树与启动日志）、`:73-96`（Profile 与 Agent 配置）、`:98-104`（ptc preset 三处证据与 compaction 行）、`:110-119`（实体落点表）、`:121-129`（架构判定五条）、`:131-134`（手工 patch 与覆盖）、`:140-147`（工具注册表与 schema 来源）、`:149-153`（discovery 与生命周期）、`:155-171`（工具数与使用分布）、`:173-183`（10/100/1000 档分析）、`:189-209`（技能系统与无 router）、`:215-225`（上下文实体表）、`:227-244`（实测压力与重复注入）、`:248-258`（未发现）、`:262-281`（只读复现命令）。
- `harness/research/02-ptc-mechanism.md:56-104`（第 2 节 run_code transport、沙箱边界、预算表、与 pwsh 关系）、`:108-134`（第 3 节 SDK 生成路径）、`:138-176`（第 4 节 Tool Registry 与 host/agent plane 接缝）、`:180-199`（第 5 节折叠动机）、`:203-207`（第 6 节设计总纲）、`:211-219`（未发现）。
- `harness/research/03-baseline-metrics.md:5`（33/33 ptc）、`:9-11`（一句话结论）、`:29-44`（Context 体积基线表）、`:46-60`（loop/稳定性/长任务基线表）、`:62-71`（用量与压缩基线表）、`:75-103`（工具声明体积与 84.8% 分子分母）、`:105-117`（技能目录体积）、`:131-141`（权威计价公式与交叉验证）、`:143-153`（压缩/剪枝触发记录与 0 次基线）、`:391-399`（未发现）、`:401-410`（改后期望方向与对账纪律）。
- `harness/README.md:1-14`（工作面定位与目录用途）、`:18-27`（快照含/不含）、`:31-43`（怎么跑与四项校验）、`:45-60`（checkpoint 铁律与双层回滚）、`:62-66`（与票的对应）。
- `harness/reports/README.md:1`（三份报告的落点与 Improvement 的前置条件）。
- `harness/scripts/verify-dsh.ps1:17-29`（定位最新 session 与投影缓存）、`:31-38`（AgentLoop/ToolCalling）、`:41-68`（PluginLoading：compositionRows 判据）、`:70-74`（Session 的 contextBreakdown 读取）、`:78-101`（RuntimeIntegrity：known-good.json 门禁）、`:104-136`（SnapshotIntegrity）、`:138-147`（6 项计数与退出码）。
- `C:/Users/Administrator/.dsh-community/settings.yaml:9-10`、`:13-21`、`:27-58`、`:59-72`、`:77-86` [本轮实测]。
- `C:/Users/Administrator/.dsh-community/profiles/desktop/cordis.yml:1-2` 与 `cordis.patch.yml`（107 行；compositionRows=23 / resolved=23）[本轮实测]。
- GitHub issue #10「DeepSeek Harness 运行时现代化：PTC 收益度量、能力可见性治理与 P0→P3 改造（规格 + 落地）」：`## Destination`、`## Notes`、`## Decisions so far`、`## Not yet specified`、`## Out of scope`、`## 进度：95% · 待确认`（`gh issue view 10 --repo CometDash77/youtubesub`）。
- GitHub issue 编号引用：issue #11（环境审计）、#12（PTC 机制）、#13（可测基线）、#14（动态可见性）、#15（呈现策略）、#16（迁移计划与验收口径）、#17（harness 骨架与安全网）、#18（Skill 可见性）、#19（工具规模可扩展性）——均见 issue #10 的 `Decisions so far` 段。
