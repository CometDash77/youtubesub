# 02 — PTC 兼容性报告：赖以构建的接缝、脆弱点与升级风险

- 判定基准：DeepSeek Harness Desktop **4.2.1** + `@deepseek-ai/*` **0.1.6-alpha.2**（04 L7-L9；02 L3）。本报告是对仓库内两份取证笔记与落地物的汇编与判定，本次未新增实测；所有数字均可回溯到「来源」一节列出的文件与行号。
- 一句话结论：PTC 的公共面只有三个 scoped 方法（`register` / `restrict` / `presentAs`）加两个 scoped 注册表（`tools` / `skills`），可安全依赖的共同点是「调用后返回 disposer」；事件名、payload 形状、section 名、保留名都是内部命名空间，升级即静默失效。

## 1 mode: native | ptc | both 的语义

### 1.1 谁有权声明 mode

| 声明者 | 位置 | 形态 | 证据 |
|---|---|---|---|
| 部署（host plane） | host 组合里 `tools` 行 | 该行**不写 mode**，取 schema 默认 `native` | 02 L16-L17 |
| agent（agent plane） | preset 文件里的 `tool-presentation` 行 | `config: mode: ptc`（本机唯一使用者） | 02 L20-L24 |

- host 侧：`ToolRuntime.Config = z.object({ mode: z.union([native, ptc, both]).default(native), maxParallelSubCalls: z.natural().min(1).default(10) })`，构造器 `this.defaultMode = config.mode ?? native`（02 L16，引用 `$APP/node_modules/@deepseek-ai/dsh-tools/lib/index.js:2665-2672, 2703`）。host 组合刻意不写 mode，注释原文即 `Presentation mode is a deployment choice; omitting it here keeps the schema default (native)`（02 L17）。
- agent 侧：`dsh-agent-tool-presentation` 的 `Config` 要求 mode 必填；`apply` 里 `mode === native` 直接 `ctx.tools.presentAs(native)` 并 return（不 inject `ptcRuntime`，因此 native 行能在没有 PTC runtime 的部署里 mount）；否则先 `ctx.inject([ptcRuntime], ...)` 再 `presentAs`（02 L20-L22；04 L65-L68）。
- 解析与结论：`modeFor(scope)` 沿 scope 链**从近到远**取第一个非空 mode，否则回落 `defaultMode`（02 L45）；即 `defaultMode` 由 host 的 `tools` 行拥有、per-agent 覆盖由 preset 的 `tool-presentation` 行拥有，两者之间没有第三种入口（02 L23）。

### 1.2 三种模式下模型看到什么

| 观测量 | native | ptc | both |
|---|---|---|---|
| API 请求的 `tools` 数组 | 每个可见工具一条 schema | **只有 `run_code` 一条** | 全量 + `run_code` |
| `tools:ptc-only` 提示段 | 空（且若部署默认 native，该 section 根本没注册） | 渲染 | **空**（native 直呼合法） |
| `tools:sdk` 生成 SDK 段 | 空（同上未注册） | 渲染 | 渲染 |
| 其它工具能否被模型直接调用 | 能 | **不能**（返回 `UNKNOWN_TOOL`） | 能 |
| 其它工具能否在程序内被调用 | 不适用 | 能 | 能 |

逐条证据见 02 L28-L34、L36-L45；`both` 无实机样本，见 §7。

### 1.3 切换 mode 后 prompt 与 API 请求的增减

- ptc 相对 native **多了**：`tools:ptc-only` 一行强制规则（section order 800）与 `tools:sdk` 一整块生成 SDK（order 5000）；`tools:sdk` 以 `interpolate: false` 注册，块内文本不做插值；非 native 部署里 opted-out 的 agent 仍看得见全局注册的两段，但渲染成空段，`renderPrompt` 丢弃空 section（02 L42、L50-L52）。
- ptc 相对 native **少了**：请求 `tools` 字段里的 K 条工具 schema 只剩 1 条 `run_code`；`wireSchemas` 在 ptc 下 `knownNames: [RUN_CODE_NAME]`，其余工具连「已知名字」都不再出现（02 L38-L41）。
- 直呼拒绝是**能力层**而非提示层：`collapses(name, scope, nested) = !nested && modeFor(scope) === ptc && name !== run_code`，命中即 `UNKNOWN_TOOL`；`nested` 由 `exec.parent` 判定，所以 `run_code` 的 SDK 子调用天然豁免（02 L44）。

## 2 run_code transport

### 2.1 process 隔离

- 每次调用 = 一个全新 Node 子进程：`NodePtcRuntime extends PtcRuntime`，`language = typescript`、`isolation = process`；程序只做类型剥离（`stripTypeScriptTypes(...)`），不编译、不做类型检查，与 SDK 文本 `erasable syntax only` 一致（02 L60、L63）。
- 程序本体在子进程里用 `AsyncFunction` 求值，顶层 `await` / `return` 可用，`console` 是注入的 shim；环境被清空到只留 `PATH/PATHEXT/SYSTEMROOT/WINDIR/TEMP/TMP`，宿主侧把其余键映射为 `undefined` 并剔除 `ELECTRON_RUN_AS_NODE`（02 L67、L78）。
- 运行期证据：本机 `run_code` 内部抛错时错误栈来自 `dsh-ptc-runtime-node/lib/process.js`，即确实由 Node 子进程引导文件执行、不是同进程 `eval`（02 L7）。

### 2.2 长度前缀 JSON 控制管道

- 进程边界协议是 **4 字节大端长度前缀 + JSON frame**（`JsonChannel`）；子进程一侧用 fd 7 打开继承来的控制通道（02 L66）。
- 握手顺序：孩子先发 `ready`，宿主**收到 ready 之后**才发 `boot`，即「代码 + 绑定名字表」在进程立起来之后才跨边界（02 L66）。
- 绑定调用往返：程序内 `await tools.x(args)` → 子进程 post `{type:call,...}` → 宿主 `JsonChannel` → 宿主侧 `binding(schema)` 经 `registry[TOOL_RUNTIME_SCHEDULER]` 走完整 `prepare/dispatch/finalize|finish` 管线 → `{type:reply}` 回子进程；输出用预序展平的 `encodePtcJsonWire/decodePtcJsonWire` 而非 `structuredClone`（02 L68、L79）。

### 2.3 与 pwsh 共用沙箱：同一策略源、同一 confine 提供方

- PTC runtime 的依赖声明是 `static inject = [fs, subprocess, sandbox, sandboxPolicy]`；边界就是宿主 `ctx.sandbox.confine`：`policy.mode === danger-full-access` 时跳过，否则 `confine(argv, policy, signal)`，并用 `confined?.argv ?? argv` 去 spawn（02 L73-L74）。
- 与 pwsh **同一对服务、同一写法**：`dsh-pwsh-sandbox` 同样 `inject = [subprocess, sandbox, sandboxPolicy]`、同样对 `danger-full-access` 早退；升级通道也是同一个 approval 服务，只是 `run_code` 以 `subject: program` 对整段程序一次性授权，pwsh 以 `subject: command` 逐条命令授权（02 L75-L76）。
- 沙箱事实回到模型的路径：用 `confined.denialSignatures` 匹配判定 `sandbox.denied`，模型侧只看到 `{ mode, denied, enforcement? }`；隔离强度不是 PTC 自己实现的，取决于 host 装载的 `dsh-sandbox-local`，`PtcRuntime.sandboxMode` 契约上可返回 `undefined` 表示该 provider 不支持限制（02 L77、L80）。

### 2.4 预算来源：`NodePtcRuntime.Config`

| 键 | 默认 | 作用点 |
|---|---|---|
| `timeoutMs` | 120000 | `resolve()` 的默认预算 |
| `maxTimeoutMs` | 600000 | 上限，且须 <= `MAX_TIMER_DELAY_MS` |
| `maxOutputBytes` | 67108864 | 宿主 `OutputLedger` 与孩子 `LogBuffer` 双重记账 |
| `maxOldGenerationSizeMb` | 512 | 传给 `--max-old-space-size=` |
| `maxMessageBytes` | 134217728 | 控制帧长上限与排队写上限，须能塞进 uint32 |
| `maxPendingCalls` | 128 | 未回复的绑定调用数 + 累计字节 |
| `graceMs` | 3000 | 终止后排空 stdout/stderr 的上限 |
| `nodeExecutable` / `bootstrapPath` | `process.execPath` / 空 | 子进程引导 |

（02 L84-L95；本机 host 组合的 `ptc-runtime` 行不写 config，故取默认值，02 L84。）

- `run_code` 自身**没有** `timeoutMs` 字段，工具调用层的超时策略对它是 no-op，不会与程序预算叠加；子调用并发上限 `maxParallelSubCalls` 默认 10，exclusive 分类的调用必须独占（02 L98-L99）。

### 2.5 反直觉结论：PTC 并不更省声明 token

- 结论原文口径：**ptc 不是「更省 token」，而是换了位置和集合**——(a) 每请求 `tools` 字段从 K 条降到 1 条；(b) 输出形状进入上下文（native 从不提供）；(c) 声明块落在稳定系统前缀里，而 native 的 schema 落在每请求字段里（02 L133）。
- 为什么反直觉仍成立：`tools:sdk` 声明块通常**更长**（JSDoc 排版 + 可选标记 + `JsonValue` 泛化 + 输出类型 + 固定说明文字），而且还要承担「ptc 下唯一信息来源」的完备性要求（02 L131）。
- 这条结论放在 §3.3 而不是 transport：它比较的是声明进入上下文的**位置与集合**，不是进程模型。本仓落地数据只到「能省多少」这一层（约 6014 tokens，保守口径约 5508；README L11-L24）；未测量项是真实请求体的字节 / Token 对照，§3.3 的体积结论是结构性的、不是测量值（02 L134、L215）。

## 3 generated SDK 的生成路径与体积位置

### 3.1 registry → 文本 → system prompt

1. **取可见集**：`sdkSchemas(scope)` 对 `view(scope).visible` 中除 `run_code` 外的每个定义取 `{ ...schemaOf(definition, true), output: snapshotJsonValue(definition.output.schema) }`；native 的 `schemas()` 只投影 `{name, description, parameters}`（02 L112）。
2. **选渲染器**：按 runtime 的 `language` 查 `SDK_RENDERERS`（`typescript` / `python`）；没有 runtime 或语言未知即 fail-loud，错误文案点名 `mode ptc requires a PTC runtime`（02 L113）。
3. **渲染（TypeScript 版）**：`renderToolsSdk(schemas)` 产出 JSDoc + `name: <TS 类型>`，再组装 `interface ToolArgsMap` / `interface ToolOutputMap` / `type ToolName = keyof ToolOutputMap` / `declare class ToolCallError` / `declare const tools`（02 L114-L119）。
4. **进 prompt 并同源执行**：`sdkSection()` 以 `name: tools:sdk`、`order: getSectionOrder(TOOLS_SDK) = 5000`、`interpolate: false` 注册，经 `renderPrompt` 拼进 system prompt、由 agent-loop 提交为 `system/message`；`run_code` 执行时用**同一个 view** 造绑定，所以声明的名字集合与程序里可绑定的名字集合不可能漂移（02 L120-L121）。

### 3.2 字典序确定性渲染（服务 prompt cache 稳定）

- `renderToolsSdk` 先按名字典序排序，注释明确目标是确定性：`unchanged tool set produces byte-identical text across assemblies`；只有集合不变，生成文本才字节不变（02 L115）。
- agent-loop 的 `toolsChanged(assembly.tools)` 会因 `tools` 变化开启新的请求序列；官方 ptc preset 的 plan-mode 段有同一取向的旁证：`The tool catalog stays the same across modes for request-cache stability.`（02 L133）。

### 3.3 与 native function-calling schema 的体积 / 位置差别

| 维度 | native | ptc |
|---|---|---|
| 位置 | API 请求的 `tools` 字段，每请求一份 | 系统提示词 `tools:sdk` 段（order 5000），请求 `tools` 只剩 `run_code` |
| 条数 | 每个可见工具 1 条 | 1 条（`run_code`）+ 1 个声明块 |
| 形状 | JSON Schema `{name, description, parameters}` | TypeScript 接口 + JSDoc + 工具名联合 + 调用签名 |
| 是否携带输出形状 | 不携带 | **携带**（`sdkSchemas` 追加 `output`） |
| 体积 | 各工具 JSON Schema 之和 | 声明块通常更长，且承担「唯一信息来源」完备性 |

（02 L125-L131。）Python 版注释的原文口径：ptc 下 native tool schemas 从请求里省略，所以生成的 SDK 是模型取得每个工具参数名、必填项、类型、描述与规范输出形状的**唯一来源**（02 L130）。

## 4 可见性机制与可控接缝

### 4.1 一个解析器喂三处消费者

- 模块注释原文：`Scoped registrations shadow globals; one visibility resolver feeds presentation, lookup, and dispatch.`（02 L142）
- `view(scope)` 是唯一解析点：global 层 + scope 链上每一层（不含本层）合成「继承面」→ 对继承面逐层应用 `layer.admits(name)`（allow / deny 交集）→ 再叠加**本层 own 注册**（不受 restriction 过滤）→ 非 native 时追加保留的 `run_code`；返回 `{ visible, knownNames, restrictableNames }`（02 L144）。
- 三个消费者：presentation（`schemas()` → API `tools`；`sdkSchemas()` → SDK 段）、lookup（`get(name, scope)`）、dispatch（`resolveExecution` / `executionMode`）；工具包自身也用同一解析结果决定指南段是否渲染（`ctx.tools.get(read, scope) === undefined` 则为空），即**工具不可见 → 它的提示词段自动消失**（02 L145-L148）。

### 4.2 register / restrict / guard / presentAs 的契约

| API | 契约要点 | 证据 |
|---|---|---|
| `register(def)` | `run_code` 名字被保留，注册即抛；写入调用方 scope 的层；返回 disposer | 02 L150；04 L79 |
| `restrict({allow?, deny?})` | 必须从 scoped ctx 调；空过滤抛错；不能命名 `run_code`；不能命名未知或 scope-local 名；返回 disposer | 02 L151；04 L78 |
| `guard(...)` | 单调否决；global 优先，然后 scope 链最远优先 | 02 L152 |
| `presentAs(mode)` | 必须从 scoped ctx 调；同一 scope 只能声明一次；返回 disposer，dispose 后 `layer.mode = void 0` | 02 L23；04 L77 |

- **per-scope 只能声明一次**：同 scope 二次声明抛 `tools.presentAs(...) conflicts with ... already declared for this scope`（04 L178）；答案写在 `ToolLayer.mode` 单格，注释原文 `One cell rather than an entry table: two answers to which form the model see is a contradiction, not a merge`，这一格同时决定请求里的 tools 集合、`view()` 是否追加 `run_code`、两段提示词文本、直呼是否被拒（02 L165-L166）。
- **restrict 豁免本层注册**：restriction 只过滤「继承面」，own layer 注册的工具永远过滤不掉；要卸载 preset 自己注册的工具，必须自己持有 `register()` 的 disposer（04 L179；02 L144）。
- 子调度豁免：collapse 只看 `exec.parent`，因此 `run_code` 的 SDK 子调用不受折叠影响；实例消费者 `dsh-experimental-browser-use-runtime` 用 `ctx.tools.schemas(agent).filter(...)` + `ctx.tools.restrict({ deny: [...] })` 给单个 agent 屏蔽继承来的 MCP 工具（02 L151、L153）。

### 4.3 时序：改动只对下一轮生效

- agent-loop 的 `preStep()` 先 assemble，之后才发 `agent/pre-step` 瀑布（04 L86-L93）→ 在 `agent/pre-step` 里 register / restrict / presentAs 只影响**下一次 assemble**；要与本轮 wire 一致，必须在 assemble 之前动手（`agent/created`、`tools/post-execute`，或更早的 hook）（04 L180）。
- `SystemPrompt.assemble()` 先于 assembly 瀑布渲染 `tools:sdk`，所以装在瀑布里的 restriction 也只能改变下一轮请求的 prompt（tool-scope L12-L16）。

## 5 兼容性判定（Desktop 4.2.1 + `@deepseek-ai/*` 0.1.6-alpha.2）

### 5.1 可安全依赖的接缝

| 接缝 | 依赖形式 | 为什么算安全 |
|---|---|---|
| `agent.ctx.tools.restrict({ deny })` | 返回 disposer，只过滤继承面 | 官方 scoped API，是删掉继承工具的唯一口（02 L144、L151） |
| `agent.ctx.tools.register(def)` | 返回 disposer | 官方 scoped API（02 L150） |
| `agent.ctx.tools.presentAs(mode)` | 返回 disposer，dispose 后可重声明 | 唯一的呈现模式入口（02 L23、L169） |
| `agent/created` / `agent/disposed` | payload 解构 `{ agent }` | 官方发射点在 `dsh-agent` 内，payload 为 `{ agent, source, signal? }`（04 L149、L170） |
| `ctx.skills.register` / `registerProvider` | 返回 disposer | 与 tools 同构的 scoped 注册表（04 L148） |
| `ctx.tools.get(name, scope)` 作提示词门 | 官方工具包自己就这么用 | 见 §4.1（02 L146） |

### 5.2 脆弱 / 易失效的点

| 风险 | 具体形态 | 证据 |
|---|---|---|
| `presentAs` 与内置行冲突 | 同时挂 `tool-presentation` 又自己 `presentAs` → 同 scope 二次声明抛错；两条路不能并存 | 04 L178 |
| restrict 豁免本层注册 | 本层注册的工具砍不掉，必须先持有 `register()` 的 disposer | 04 L179；tool-scope L18-L24 |
| MCP 子进程属 profile 组合层 | playwright MCP provider 是 profile 组合层（`- insert:` 段）的 host 行、`config.mode: launch`，preset 文件里没有这一行 → 从 preset 里卸不掉，只能靠 scoped restrict | profile cordis.patch.yml L87-L96；README L5-L7；tool-scope L4-L10 |
| 官方只发 `lib/`、无文档 | 源码注释点名的 docs 在本机不存在，`$APP` 下没有 `docs/`；权威只能是代码与注释 | 02 L213 |
| 升级即失效面 | 事件名（`agent/session-start` 改名为 `agent/created`、`codeRuntime` 改名为 `ptcRuntime`）、payload 形状、section 名（`tools:ptc-only` / `tools:sdk`）、`getSectionOrder`、保留名 `run_code`、disposer 语义、preset mount 审计 | 04 L163-L174 |
| 静默失效 | 自建模块用 `ctx.logger?.warn?.` 吞掉失败，升级后不报错也不生效 | 04 L161 |
| 换 preset 不能救 | `recompose` 只在 agent 尚未产出任何东西时有效；契约原文 `swapping tools mid conversation would leave logged tool calls the new composition cannot make` | 04 L183 |
| skill 侧全有 / 全无 | restrict 掉 `skill` 工具会连带目录与指引一起消失，无法只藏一部分技能 | 04 L182 |

### 5.3 约束：PTC 与 native 会话必须同进程并存

- preset 注释原文 `Native sessions run beside this one in the same process, each seeing its own catalog.`；成因是 preset 里的 service 行必须是 isolate realm，否则发布到 root realm 变成进程级、`dsh-agent-presets` 在 mount 时拒绝——**「preset 想拥有一个进程级单例」这条路在机制上被封死**（02 L174-L175）。
- 所以呈现选择只能 per-scope 覆盖，不能进程级替换；进程级替换正是 `presentAs` 报错文案里点名的 tools 行的 `mode` config field。附带判据：host-plane 所有权的标准是 host row that injects a service，`NodePtcRuntime` 注入 `fs/subprocess/sandbox/sandboxPolicy`，因此属 host（02 L175-L176）。

## 6 本 map 的落地物：`harness/preset/lean/`

### 6.1 它是什么

- **官方 `ptc` preset 的逐字拷贝**，外加**一行** `tool-scope` 模块行；`agent.cordis.yml` 顶部的 provenance 注释写明了拷贝来源与版本（README L5；agent.cordis.yml L1-L10）。
- 新增块位于 `lean surface (this preset's own addition)`：`- id: tool-scope` / `name: ./tool-scope.mjs` 加 deny 前缀与精确名清单；它**不是** service 行，不发布任何东西、随 agent 释放，因此不需要 isolate realm（agent.cordis.yml L283-L303、L288-L289）。
- 元数据：`order: 90`，名称 `Lean（PTC + 收窄工具面）`（preset.yml L1-L3）。

### 6.2 它用哪条接缝

- 用 `agent.ctx.tools.restrict({ deny })`，装在 `agent/created`，`agent/disposed` 时 release（tool-scope L7-L16、L129-L130）。
- 为什么必须是 preset 模块而不是配置开关：要拿掉的工具大多来自 host 组合（profile 的插件集），不是本 preset 文件里的工具行，从 preset 里卸不掉；唯一能删掉「继承面」上的工具、并且对 ptc 折叠后的 wire 同样生效的接缝，是 scoped `restrict`（README L7；tool-scope L4-L10）。
- 为什么是 `agent/created`：restriction 必须装在 system-prompt assembly 瀑布**之外**——`SystemPrompt.assemble()` 在瀑布之前就从 registry 渲染 `tools:sdk` 段，装在瀑布里只会慢一个请求（tool-scope L12-L16）。
- never-deny 名单：`run_code`（PTC 的 transport）与 read / write / edit / glob / grep / pwsh / ask_user_question / todo_write / present / web_search / web_fetch / subagent / subagent_fork；失败模式 fail-visible 而非 fail-silent：读不到 scoped `tools.restrict`、surface 读回为空、`restrict` 抛错、disposer 未确认，都 warn-once 且不假装已收窄（tool-scope L36-L41、L98-L127；README L26）。

### 6.3 已知它不做什么（保守口径）

- **`restrict` 豁免本层注册**：本 preset 自己注册的工具可能活在 deny 名单之外——`consult_expert` 与 `spawn_teammate` 被 README 标为可能属本 preset 自有注册，因此**保守口径把它们从收益里去掉**（README L24；tool-scope L18-L24）。
- 由此产生的口径差：deny 集合逐工具实测合计约 6014 tokens，保守口径约 5508 tokens（README L11-L24）。逐家族实测（数据源：本机最新会话日志里 68 个工具的 SDK 声明，逐工具量得）：

| 家族 | 工具数 | 字符 | ≈tokens |
|---|---|---|---|
| mcp/playwright | 24 | 6185 | 1547 |
| ssh | 6 | 5895 | 1474 |
| team_task | 4 | 4076 | 1019 |
| goal | 3 | 3881 | 971 |
| job | 3 | 1992 | 498 |
| consult_expert | 1 | 1080 | 270 |
| spawn_teammate | 1 | 944 | 236 |
| **合计被 deny** | **42** | **24053** | **≈6014** |

（README L11-L20。系统提示 14452 → 约 8438 tokens，即 −42%；每请求 `tools` 数组不变，`run_code` 524 tokens，README L22。）

- **尚未在真实会话里验证**：模块逻辑、deny 集合与体积收益已在离线用真实数据断言，但「挂载成功并真的少渲染 42 个声明」需要在下一个会话里跑一次 `node harness/scripts/sdk-budget.cjs`，把 `declaredTools` 从 68 变成 26 当作成功判据；回滚方式是删掉 `<DSH_HOME>/.agent-presets/lean/` 整个目录（README L44、L46）。

## 7 未发现 / 无法证实

- **官方文档不存在**：源码注释点名的 `docs/subsystems/ptc-runtime.md`、`dsh-ptc-runtime` 的 README、PTC 模式的 Agent Note 在本机均未发现；这些包只发布 `lib/**`（02 L213）。
- **`mode: both` 无实机样本**：全仓 grep 只命中类型声明 / 默认值 / 叙述字符串，没有任何 composition 或 preset 使用它，§1.2 的 `both` 行为来自代码路径推导；也没有把 native 与 ptc 两种会话的真实 LLM 请求抓下来做字节 / Token 对照（02 L214-L215）。
- **未在本机切到 PTC 会话实跑**：`~/.dsh-community/.agent-presets` 下只有 liangshen 与 value-mode，两者都不含 `tool-presentation` 行；切换会话模式会改动用户环境，超出只读取证纪律（02 L216）。
- **未定位到具体调用点**：preset 注释点名的 API proxy's presenters（02 L217）。
- **PTC 与 bash 的关系未实机验证**：本机 `bash-sandbox` 为 `disabled: true`（Windows 平台），生效者是 pwsh-sandbox；也**未发现任何「默认启用 PTC」的部署配置**，预设只有 `name/description/order`，host 组合的 tools 行不写 mode，即本机默认 native（02 L218-L219）。
- 04 侧：未发现 `dsh-agent-tool-presentation` 除 mount 期以外的运行时入口（04 L189）；未发现任何按任务加载 / 卸载单个 skill 的官方入口（04 L190）；未发现 liangshen preset 真的挂载了 `tool-activate` 行，其 `paging.mjs` / `tool-activate.mjs` 是死代码（04 L191）；未发现 `dsh-agent-presets` 有「运行时把新工具挂进已存在 agent」的公开 API（04 L192）。
- 本仓 issue #14 只有 **1 条评论**，且该评论正文与 issue 正文是同一份取证文档的重复；`--comments` 未给出额外结论（本次只读核对）。

## 来源

- `harness/research/02-ptc-mechanism.md`：L1-L7（取证环境与运行期证据）、L11-L52（mode 语义、谁有权声明、三模式对比、切换增量）、L56-L104（transport、沙箱、预算表）、L108-L134（SDK 生成路径、确定性与体积位置）、L138-L176（可见性解析器、写侧契约、接缝位置与理由）、L180-L207（设计动机）、L211-L219（未发现）。
- `harness/research/04-dynamic-visibility.md`：L7-L9（版本基准）、L61-L84（第 2 节 官方 tool-presentation 与宿主运行时入口）、L86-L95（第 3 节 时序硬约束）、L97-L130（第 4 节 skill 侧入口）、L132-L139（第 5 节 plugin-manager）、L141-L151（第 6 节 可复用接缝）、L153-L161（第 7 节 不可复用点）、L163-L174（第 8 节 升级失效点）、L176-L185（第 9 节 冲突风险）、L187-L193（第 10 节 未发现）。
- GitHub issue `CometDash77/youtubesub#14`：issue 正文（与 `harness/research/04-dynamic-visibility.md` 同文）+ 1 条评论（正文重复），用 `gh issue view 14 --comments` 只读核对。
- `harness/preset/README.md`：L3-L7（lean 是什么、为什么必须是 preset 模块）、L9-L24（逐家族实测表与保守口径）、L26（never-deny 保留面）、L28-L34（装上与默认 preset）、L36-L42（验证脚本）、L44（回滚）、L46（尚未验证部分）。
- `harness/preset/lean/tool-scope.mjs`：L1-L25（WHY 与 WHAT IT WILL NOT DO 注释）、L27-L41（deny 常量与 never-deny）、L43-L55（纯选择函数）、L57-L74（可见名读取）、L76-L131（apply 与 agent/created 装配）。
- `harness/preset/lean/agent.cordis.yml`：L1-L10（provenance 与拷贝来源）、L283-L303（lean surface 行）、L305-L313（tool-presentation 行）。
- `harness/preset/lean/preset.yml`：L1-L3（名称 / 描述 / order）。
- `harness/backups/20260921-152631-before-lean-preset/profile/cordis.patch.yml`：L87-L96（profile 组合层插入的 playwright MCP provider 行，`mode: launch`）。只读核对：该备份与当前 profile 的同名文件 SHA256 一致。
- `harness/reports/README.md`：L1（本报告在报告体系中的落点：Architecture / PTC Compatibility / Improvement）。
