# 02 — PTC 模式的设计意图与机制取证（native / ptc / both、run_code transport、SDK 生成、可见性控制）

本票读**本机权威源码**取证。所有结论都给出 `$APP\node_modules\@deepseek-ai\…` 下的文件与行号，或命令 + 真实输出片段；查不到的写「未发现」。全部引用包均为同一版本 **0.1.6-alpha.2**（逐包读 `package.json` 的 `version` 字段确认；Profile 的 link 清单见 `C:\Users\Administrator\.dsh-community\profiles\desktop\desktop-plugins.lock.json:7`）。

- `$APP` = `C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness Desktop\resources\app.asar.unpacked`
- 运行时入口：`@deepseek-ai/dsh-tools` 的 `main`/`exports["."].default` = `lib/index.js`（`$APP\node_modules\@deepseek-ai\dsh-tools\package.json:14,19`），所以**实际执行的是 `lib/index.js`**；同包 `lib/types/*.js` 是同一份源码的另一个产物体（`lib/types/ptc.js` 与 `lib/index.js:895-1477` 内容对应），下文按类型名引用 ptc 语义时用 `lib/types/ptc.js`，并标注 `lib/index.js` 的对应行。
- 一手现场证据（本票执行期间真实产生）：本票的每次 `run_code` 若内部抛错，错误栈来自 `…\@deepseek-ai\dsh-ptc-runtime-node\lib\process.js:902 / 968 / 932 / 1086 / 264`。即：**agent 的每一次 `run_code` 调用确实由 `dsh-ptc-runtime-node` 的 Node 子进程引导文件执行**，不是同进程 `eval`。

---

## 1 mode: native | ptc | both 的语义与实现差异

### 1.1 谁有权声明 mode

**部署级（host plane）**
- `$APP\node_modules\@deepseek-ai\dsh-tools\lib\index.js:2665-2672`：`ToolRuntime.Config = z.object({ mode: z.union(["native","ptc","both"]).default("native"), maxParallelSubCalls: z.natural().min(1).default(10) })`；构造器 `:2703` `this.defaultMode = config.mode ?? "native"`。
- 本机 host composition 装载 tools 行时**不写 mode**，注释明说这是故意的：`$APP\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml:483-486`（"Presentation mode is a deployment choice; omitting it here keeps the schema default (native)"）。

**agent 级（agent plane）**
- `$APP\node_modules\@deepseek-ai\dsh-agent-tool-presentation\lib\index.js:31-35` 的 `Config = z.object({ mode: z.union(["native","ptc","both"]).required() })`；`:41-49` 的 `apply`：
  - `mode === "native"` → 直接 `ctx.tools.presentAs("native")` 并 return（**不 inject ptcRuntime**，所以 native 行能在没有 PTC runtime 的部署里 mount，注释 `:24-28`）；
  - 否则 `ctx.inject(["ptcRuntime"], (runtimeCtx) => runtimeCtx.tools.presentAs(config.mode))` —— 没有 TypeScript runtime 的部署**在 mount 期**就失败，而不是第一次请求时。
- `presentAs` 只能从 scoped ctx 调用，且同一 scope 只能声明一次：`…\dsh-tools\lib\index.js:2808-2824`（`:2810` 非 scope 抛错；`:2813` 已声明过则抛 "one composition selects one presentation"）。公开类型：`…\dsh-tool-cordis\lib\index.js:9267-9268` `export type ToolPresentationMode = 'native' | 'ptc' | 'both'`、`:4884` `presentAs(mode: ToolPresentationMode): () => void`。
- 本机唯一使用者：`$APP\node_modules\@deepseek-ai\dsh-agent-presets\presets\ptc\agent.cordis.yml:277-280`（`config: mode: ptc`）。**未发现**任何 composition 使用 `both`。

### 1.2 三个模式让模型看到的东西（严格按代码路径）

| 观测量 | native | ptc | both |
|---|---|---|---|
| API 请求的 `tools` 数组 | 每个可见工具一条 schema | **只有 `run_code` 一条** | 全部 + `run_code` |
| `tools:ptc-only` 提示段 | 空（且若部署默认 native，该 section 根本没注册） | 渲染 | **空**（native 直呼是合法的） |
| `tools:sdk` 生成 SDK 段 | 空（同上未注册） | 渲染 | 渲染 |
| 其它工具能否被模型直接调用 | 能 | **不能**（返回 `UNKNOWN_TOOL`） | 能 |
| 其它工具能否在程序内被调用 | 不适用 | 能 | 能 |

逐条证据：

- 请求 tools 数组：`…\dsh-tools\lib\index.js:2829-2846` `wireSchemas(scope)`
  - native：`return { schemas: [...view.visible.values()].map(d => this.schemaOf(d, false)), knownNames: [...view.knownNames] }`（`:2832-2835`）
  - ptc：先 `requirePtcRuntime(mode)`（`:2836`）再 `schemas.filter(s => s.name === RUN_CODE_NAME)`，`knownNames: [RUN_CODE_NAME]`（`:2838-2841`）——**其余工具连"已知名字"都不再出现**；`knownNames` 随后被 `orderTools` 用来校验配置的 `toolOrder`（`$APP\node_modules\@deepseek-ai\dsh-system-prompt\lib\index.js:84-88, 352`），即任何命名了非 `run_code` 工具的 `toolOrder` 在 ptc scope 下会直接抛错（本机 `~/.dsh-community` 内 grep 未发现 `toolOrder` 配置，故当前不受影响）。
  - both：`schemas` 全量 + `knownNames: [...view.knownNames, RUN_CODE_NAME]`（`:2842-2845`）；`run_code` 之所以已进 `schemas`，是因为 `view()` 在非 native 模式把它塞进 visible（`:2977`）。
- section 注册与否：`…\dsh-tools\lib\index.js:2705-2709` 构造器只在 `defaultMode !== "native"` 时注册 `collapseSection()` 与 `sdkSection()`；`:2819-2822` `presentAs` 在 `mode !== "native"` 时注册同样的两段（scope 级）。两者文本都按**调用 scope** 重算：`sdkSection().text` 对 native 返回 `""`（`:2748-2750`），`renderPrompt` 丢弃空 section（`…\dsh-system-prompt\lib\index.js:114-116`）。所以"PTC 部署里 opted-out 的 agent 仍看得见全局注册，但会渲染成空段"（注释 `:2737-2741`）。
- `tools:ptc-only` 文本：`…\dsh-tools\lib\index.js:2517` `PTC_ONLY_INSTRUCTION = "run_code is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program."`（原文首尾带反引号，见该行）；`:2726-2732` `collapseSection()` 的 `text` 只在 `modeFor(context.scope) === "ptc"` 时非空，`:2723` 注释明确 "both renders empty: native calls do execute there, so the rule is false"。
- 直呼拒绝（**能力层，不只是提示层**）：`…\dsh-tools\lib\index.js:3096-3098` `collapses(name, scope, nested) = !nested && modeFor(scope) === "ptc" && name !== "run_code"`；命中时 `:3171-3181` 生成 `ToolNotFoundError(name, "only run_code is callable directly — call name from inside a run_code program instead")`，最终表现为 `UNKNOWN_TOOL`（`:3002-3003` 注释：与"定义不存在"同一出口，因此不可被绕过）。`nested` 由 `exec.parent` 是否存在判定（`:3138`、`:3055`）——即 `run_code` 的 SDK 子调用**天然豁免** collapse。
- `modeFor(scope)` 的解析：`…\dsh-tools\lib\index.js:2765-2772` 沿 scope 链**从近到远**取第一个非空 `mode`，否则回落 `defaultMode`。注释 `:3087-3091` 解释为什么 collapse 必须读 `modeFor` 而不是 `defaultMode`：native 部署下由 preset 指定 ptc 的 agent 正是 `dsh-agent-tool-presentation` 存在的理由，读默认值会留下"宣布一套、执行另一套"的旁路。

### 1.3 切换 mode 后 prompt / API 请求具体多了少了什么

- 请求体组装链：`…\dsh-system-prompt\lib\index.js:311-333`（`assemble`：收集 global + scope 的 `toolProviders`，投影 `{name, description, parameters}`，`orderTools`）→ 返回 `assembly.tools`（`:352`）→ `$APP\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js:888-905`（每步 `preStep` 组装）、`:1011-1028`、`:1164-1215`（`buildRequest`：`:1170` `...tools.length > 0 ? { tools } : {}` 写进 request header，`:1212` 写进真实请求 `tools` 字段）。→ **ptc 模式下 API 的 `tools` 字段只有 1 条（run_code）**。
- prompt 侧面：`renderPrompt(assembly)` 把 section 拼成一个字符串（`…\dsh-system-prompt\lib\index.js:114-116`），`…\dsh-agent-loop\lib\index.js:1012,1017-1025` 把它 project 成 `system/message` 提交。section 顺序由 `SECTION_ORDERS` 固定（`…\dsh-system-prompt\lib\index.js:10-44`）：`PTC_ONLY: 800`（`:15`）、各 `TOOL_*: 1000-3100`、`TOOLS_SDK: 5000`（`:38`）。ptc 相对 native **多了**：order 800 的一行强制规则 + order 5000 的一整块生成 SDK。
- `tools:sdk` 注册为 `interpolate: false`（`…\dsh-tools\lib\index.js:2747`），所以生成文本里的花括号变量写法不会被插值（`…\dsh-system-prompt\lib\index.js:114-116` 明确 `interpolate === false` 保留字面文本）。`collapseSection` 的顺序注释（`…\dsh-tools\lib\index.js:2711-2723`）解释了为什么必须 800 且必须在工具自己的指南段之前：每个工具都注册了**只讲自己、但从不说明怎么被调用**的指南段（例如 `$APP\node_modules\@deepseek-ai\dsh-tool-fs\lib\index.js:323` 的 read 指南、`:736` 的 edit 指南），若没有这条规则，模型会发出原生调用、拿到一个提示词刚刚声明过的工具的 `UNKNOWN_TOOL`，从而判定部署自相矛盾。
- ptc 下 `run_code` 的 schema/描述**不是静态的**：`$APP\node_modules\@deepseek-ai\dsh-tools\lib\types\ptc.js:636-646` 用 `Object.defineProperty` 装了惰性 `description` getter，`:647-656` 装了惰性 `parameters` getter，均按 `peekRuntime()` 当前语言解析（flavor 表 `:46-49`、`resolveFlavor` `:97-114`，其中 `:109-112` 对未知语言 fail-loud）。描述里还会拼入：runtime 提供的 `executionInstructions`（`:640-642`）、cwd 说明（`:643`）、以及**仅在宿主提供沙箱时**才出现的升级指引（`escalationGuidance` `:79-82`）。`controlParameters`（`:64-78`）会把真实的 `Default <defaultMs>; capped at <maxMs>` 写进 timeoutMs 描述，并在 runtime 无 `sandboxMode` 时**不暴露** `sandbox_permissions`/`justification`。→ 同一台机器上，除了 native/ptc 之别，宿主装不装 PTC runtime、runtime 语言、超时配置、沙箱能力都会改变模型看到的 `run_code` 描述。

---

## 2 run_code 的 transport

### 2.1 每次调用 = 一个全新的 Node 子进程（不是同进程、不是 vm）

- 提供方：`$APP\node_modules\@deepseek-ai\dsh-ptc-runtime-node\lib\index.js:764` `class NodePtcRuntime extends PtcRuntime`；`:782-783` `language = "typescript"; isolation = "process"`；`:784-786` 面向模型的说明 "Each call runs in a fresh Node process. Node APIs are available through await import(...) … process.env starts empty."。
- 服务契约：`$APP\node_modules\@deepseek-ai\dsh-ptc-runtime\lib\index.js:147-159` `PtcRuntime` 是纯 `Service`（`super(ctx, "ptcRuntime")`），`get sandboxMode / get timeout / get executionInstructions` 为可选项；`:140-146` 注释要求实现方 "bridge structured-cloneable bindings … treat programs as hostile peers, isolate runs from one another, and terminate and await in-flight runs during disposal"。
- 启动路径：`…\dsh-ptc-runtime-node\lib\index.js:846-864`（`run`）→ `:865-1175`（`execute`）。
  - `:930` `stripTypeScriptTypes(STRIP_PREFIX + spec.program + STRIP_SUFFIX)`（`import { stripTypeScriptTypes } from "node:module"`，`:1`；`STRIP_PREFIX/SUFFIX` = `async function __dsh_program__() {` / `}`，`:755-756`，`:933` 再切掉这两端）——**只做类型剥离，不编译、不做类型检查**，与 SDK 文本 "erasable syntax only — no enum or namespaces" 一致（`…\dsh-tools\lib\index.js:1691`）。
  - `:941` `ctx.subprocess.resolveExecutable(this.config.nodeExecutable, …)`；`:945-949` `argv = [executable, "--max-old-space-size=<maxOldGenerationSizeMb>", …bootstrapArgs(...)]`；`:961-973` `ctx.subprocess.spawn({ argv, cwd, env, stdio: { stdin:"ignore", stdout:"pipe", stderr:"pipe", control:"pipe" }, graceMs, signal })`。
  - `bootstrapArgs`（`:349-366`）：`bootstrapPath` 优先；否则映射 `./process.js`；打包态走 `--eval` 拼 `openInheritedControlChannel()` + `runNodeMain(...)`。
- 进程边界协议：4 字节大端长度前缀 + JSON frame（`…\dsh-ptc-runtime-node\lib\index.js:222-338` `JsonChannel`；子进程侧同实现见 `…\lib\process.js:207-323`）。子进程先发 `ready`，宿主**收到 ready 之后**才发 `boot`（宿主 `:1038-1056`，孩子 `:1075-1084`）——所以"代码 + 绑定名字表"是在进程立起来之后才跨边界的。子进程一侧用 fd 7 打开继承来的控制通道：`…\lib\process.js:5`（`DSH_SUBPROCESS_CONTROL_ENV`）、`:13-23`（`new Socket({ fd: 7, … })`，并在打开前把该环境变量删掉）。
- 程序本体在**子进程里**求值：`…\lib\process.js:1027-1030` `const AsyncFunction = (async () => {}).constructor; new AsyncFunction(...namespaces.map(n => n.global), ...errorClassParameters, "console", "'use strict';\n" + data.code)(...)` → 顶层 `await`/`return` 可用；`console` 是注入的 shim。
- 绑定调用往返：程序里 `await tools.x(args)` → 子进程 `postMessage({type:"call", id, global, name, args})`（`…\lib\process.js:949-988`）→ 宿主 `JsonChannel` 收到 `"call"`（`…\lib\index.js:1092-1141`）→ 宿主侧的 `fn` 就是 `…\dsh-tools\lib\types\ptc.js:424-565` `binding(schema)`，它经 `registry[TOOL_RUNTIME_SCHEDULER]`（`:442`）走完整 `prepare/dispatch/finalize|finish` 管线（`:506-523`）→ `{type:"reply"}` 回子进程（`…\dsh-ptc-runtime-node\lib\index.js:1114-1139`）。
- 因此 **`run_code` 的 transport 是"新进程 + 双向长度前缀 JSON 控制管道 + 宿主侧 registry 子调度"**，与 vm/worker 方案无关。对照：`$APP\node_modules\@deepseek-ai\dsh-workflow-ptc\lib\index.js:579-595`（`PtcWorkflowEngine.inject` 含 `ptcRuntime`/`sandboxPolicy`，并要求 `ctx.ptcRuntime.language !== "typescript"` 时抛错；`:424-425` `timeoutMs: null`）把 workflow 脚本放进 PTC runtime 里跑，其 guest 源码注释同样声明 "process isolation and cancellation belong to PTC, not the VM"（见 `…\dsh-workflow-ptc\lib\index.js:12` 内嵌源码的 `realm.ts` 注释段）。

### 2.2 沙箱边界在哪

- PTC runtime 的依赖声明：`…\dsh-ptc-runtime-node\lib\index.js:765-770` `static inject = ["fs", "subprocess", "sandbox", "sandboxPolicy"]`。
- 边界就是**宿主 `ctx.sandbox.confine`**：`:950-953` `confined = policy.mode === "danger-full-access" ? void 0 : await this.ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, signal);`；`:955` 记录 `sandbox.enforcement = confined.enforcement`；`:962` 用 `confined?.argv ?? argv` 去 spawn。
- 与 pwsh/bash **是同一对服务、同一写法**：`$APP\node_modules\@deepseek-ai\dsh-pwsh-sandbox\lib\index.js:118-123` 同样是 `inject = ["subprocess","sandbox","sandboxPolicy"]`，`:151-160` `if (mode === "danger-full-access") return { ...await super.run(spec), sandbox: { mode, denied: false } }`，`:252-253` `confine(spec, policy, signal) { return this.ctx.sandbox.confine(this.argv(spec), policy, signal); }`。bash 侧对应件是 `@deepseek-ai/dsh-bash-sandbox`（host composition 三行并列：`$APP\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml:221-229`；同一 `dsh-sandbox-local`（`:212-213`）与 `dsh-sandbox-policy`（`:215-219`））。
- 升级通道也是同一个 approval 服务，只是名词不同：`…\dsh-tools\lib\types\ptc.js:308-318` `approveEscalation({ requestedMode, justification, effectiveMode, subject: 'program' }, …)` 对**整个程序**一次性授权（`runtime.run` 把 `policy` 传下去，`:593`）；pwsh 用 `subject: "command"`（`$APP\node_modules\@deepseek-ai\dsh-tool-pwsh\lib\index.js:249-253`），逐条命令授权。措辞与"one execution only / 嵌套工具各自策略 / 不会自动重放"由 `escalationGuidance`（`…\dsh-tools\lib\types\ptc.js:79-82`）写进工具描述。
- 沙箱事实如何回到模型：`…\dsh-ptc-runtime-node\lib\index.js:1079` 用 `confined.denialSignatures.some(sig => failure.message.toLowerCase().includes(sig.toLowerCase()))` 判定 `sandbox.denied`；`:870-871` 组装 `{ mode, denied, enforcement? }`；`…\dsh-tools\lib\types\ptc.js:284-288` 在渲染时补 "File sandbox enforcement is partial on this host." 与 denied 的升级提示。对照 pwsh 用"退出码 + stderr 匹配"（`…\dsh-pwsh-sandbox\lib\index.js:236`）。
- 子进程环境被清空到只留启动变量：`…\dsh-ptc-runtime-node\lib\index.js:478-485` `STARTUP_ENVIRONMENT_NAMES = {PATH, PATHEXT, SYSTEMROOT, WINDIR, TEMP, TMP}`；`:956` 宿主侧把其余键映射为 `undefined`（并额外剔除 `ELECTRON_RUN_AS_NODE`）；孩子侧 `…\lib\process.js:1063-1064` 再删一遍并把 `processState.env` 换成 `Object.create(null)`。
- 进程内的"软隔离"（不替代 OS 沙箱）：绑定命名空间用 null-prototype + `Object.defineProperty`（`…\dsh-tools\lib\types\ptc.js:566-580`；孩子侧 `…\lib\process.js:949-988`），使名为 `__proto__` 的工具变成普通 own key；`console` 只暴露 5 个方法（`…\lib\process.js:773-797`）；程序里 `process.stdout/stderr.write` 被劫持进日志缓冲（`:810-823`）；输出用预序展平的 `encodePtcJsonWire/decodePtcJsonWire`（`:541-704`）而非 `structuredClone`，以免受平台嵌套深度限制（宿主侧同构实现 `…\lib\index.js:588-751`）。
- **隔离强度不是 PTC 自己实现的**：它取决于 host 装载的 `@deepseek-ai/dsh-sandbox-local`（`…\dsh-base\cordis.patch.yml:212-213`）；`PtcRuntime.sandboxMode` 契约上可返回 `undefined` 表示"该 provider 不支持限制"（`$APP\node_modules\@deepseek-ai\dsh-ptc-runtime\lib\index.js:152-153`）。

### 2.3 timeout 与资源限制从哪来

全部来自 `NodePtcRuntime.Config`（`…\dsh-ptc-runtime-node\lib\index.js:771-781`），即 host composition 里 `id: ptc-runtime` 那一行的 config（本机 `$APP\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml:376-377` 未写 config，故取默认值）：

| 键 | 默认 | 作用点 |
|---|---|---|
| `timeoutMs` | 120000 | `resolve()` 的默认预算（`:837` 经 `clampTimeout`）；`:820` `timeout.defaultMs = min(timeoutMs, maxTimeoutMs)` |
| `maxTimeoutMs` | 600000 | 上限（`:821`、`:837`、`:849` 二次校验）；均须 `<= MAX_TIMER_DELAY_MS`（`:797-801`；常量在 `$APP\node_modules\@deepseek-ai\dsh-timeout\lib\index.js:27`） |
| `maxOutputBytes` | 67108864 | 宿主 `OutputLedger`（`:370-437`，`:866`）与孩子 `LogBuffer`（`…\lib\process.js:729-772`）双重记账；超限 → `kind: "output-limit"` |
| `maxOldGenerationSizeMb` | 512 | `:944` `--max-old-space-size=` |
| `maxMessageBytes` | 134217728 | 控制帧长上限（`:266`）与排队写上限（`:293`），须能塞进 uint32（`:803`） |
| `maxPendingCalls` | 128 | 未回复的绑定调用数 + 累计字节（`:1109-1112`） |
| `graceMs` | 3000 | 终止后等待 stdout/stderr 排空的上限（`:446-473` `drainOutput`、`:897`） |
| `nodeExecutable` / `bootstrapPath` | `process.execPath` / 空 | `:794`、`:806-807`、`:349-366` |

- 预算的落地：`:883-886` `wallTimer = setTimeout(() => { timedOut = true; controller.abort("execution deadline reached"); }, spec.timeoutMs)`；`:917-925` `onAbort` 把结果分成 `kind:"timeout"`（消息带毫秒数）与 `kind:"abort"`。程序面显示的 timeout 语义是 "including nested tool and approval waits"（`…\dsh-tools\lib\types\ptc.js:71`），因为它是整段程序的墙钟。
- 子调用并发上限：`…\dsh-tools\lib\index.js:2653-2658, 2671` 的 `maxParallelSubCalls`（默认 10），`:379` 用于 `inFlight.size < maxParallel`；exclusive 分类的调用必须独占（`:365-366`、`:378-386`），分类来自失败即独占的 `registry.executionMode(input)`（`…\dsh-tools\lib\index.js:3054-3062`，`…\dsh-tools\lib\types\ptc.js:491`）。
- `run_code` **自身没有** `timeoutMs` 字段，因此 `dsh-tool-call-timeout-policy` 对它是 no-op（`$APP\node_modules\@deepseek-ai\dsh-tool-call-timeout-policy\lib\index.js:123-124`：`timeoutMs === undefined` 时直接 `next()`）——工具调用层的超时不会与程序预算叠加。
- 生命周期：runtime 被 dispose 时 abort 全部 live run 并 await（`…\dsh-ptc-runtime-node\lib\index.js:808-813`）；`run()` 在 finally 里把自己从 live 集合摘掉（`:860-863`）。

### 2.4 与 pwsh / bash 沙箱的关系（一句话版）

**同一策略源、同一 confine 提供方、同一 approval 通道**（`ctx.sandbox` + `ctx.sandboxPolicy` + `ctx.approval`），**不同的执行器与授权粒度**：pwsh/bash 用 `ctx.shell` 执行器（`SandboxPwshExecutor extends PwshLocalExecutor`）逐条命令授权；`run_code` 用 `ctx.subprocess` + fd7 控制管道，把"整段程序（其所有直接文件操作）"当作一次 `subject: "program"` 的授权对象。**PTC 不新开一条绕过沙箱的路**。

---

## 3 generated SDK 如何生成并进入 prompt

### 3.1 生成路径（registry → 文本 → system prompt）

1. **取可见集**：`$APP\node_modules\@deepseek-ai\dsh-tools\lib\index.js:3025-3035` `sdkSchemas(scope)` = 对 `view(scope).visible` 中除 `run_code` 外的每个定义取 `{ ...schemaOf(definition, true), output: snapshotJsonValue(definition.output.schema) }`。注意与 native 的差别：`schemas()`（`:3021-3023`）只投影三字段。
2. **选渲染器**：`:2743-2757` `sdkSection().text` → `const runtime = this.requirePtcRuntime(mode); const render = SDK_RENDERERS[runtime.language]; return render(this.sdkSchemas(context.scope));`；表在 `:2518-2521` `{ typescript: renderToolsSdk, python: renderToolsSdkPy }`。`:2861-2869` `requirePtcRuntime` 就是那个可执行的错误（"mode \"ptc\" requires a PTC runtime — load a ctx.ptcRuntime implementation (e.g. @deepseek-ai/dsh-ptc-runtime-node) or set tools mode to \"native\""）；未知语言同样 fail-loud。`:2497-2511` 的模块注释记录：加一门后端语言 = 三处并行改动 + docs 里"点名而非派生"的散文（**该 docs 在本机未发现，见 §7**）。
3. **渲染（TypeScript 版）**：`:1729-1755` `renderToolsSdk(schemas)`
   - 先按名字典序排序（`:1730`），注释 `:1719-1724` 明说目标是确定性："unchanged tool set produces byte-identical text across assemblies"；
   - 逐工具产出 `/** description */` + `name: <TS 类型>;`（`:1734-1736`，`docLines$1` `:1498-1502`，`jsonSchemaToTs` `:1680-1687`），输出侧另起 `ToolOutputMap`；
   - 组装：`interface ToolArgsMap` / `interface ToolOutputMap` / `type ToolName = keyof ToolOutputMap` / `declare class ToolCallError extends Error { readonly name; readonly toolName: ToolName }` / `declare const tools: { [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]> }`（`:1738-1753`）；
   - 前后包固定说明：`SDK_INSTRUCTIONS$1`（`:1689-1691`，"only names supplied as separate tool schemas may be called directly"）、条件性的 bash 示例 `renderBashExample`（`:1705-1716`，只在 argv 形态真的被 schema 接受时才渲染）、`SDK_PROGRAM_INSTRUCTIONS`（`:1692-1699`，含 `await tools.name(args)`、`ToolCallError`、`Promise.all` 并发语义、"every other intermediate result stays out of the conversation"）。
   - TS 投影实现：`renderSupportedSchema`（`:1555-1671`，显式工作栈、非递归），支持子集由 `assertSupportedJsonSchema` 把关；`oneOf` → 联合类型（`:1577-1586`）、数组 → `T[]`（必要时加括号，`:1588-1593`）、`const/enum` → 字面量（`:1508-1513`）、`additionalProperties !== false` 的对象补 `& Record<string, JsonValue>`（`:1608`）、空 properties → `Record<string, JsonValue>` / `Record<string, never>`（`:1651`）、非法或不支持 → `"unknown"`（`:1623-1626, 1661-1666` 不抛错，`:1684-1686` 兜底）。
4. **进 prompt**：`sdkSection()` 经 `ctx.systemPrompt.section(...)` 注册（`:2707-2708` 全局 / `:2821` scope），`name: "tools:sdk"`、`order: getSectionOrder("TOOLS_SDK") = 5000`、`interpolate: false`（`:2743-2747`）→ `renderPrompt` 拼进 system prompt 字符串（`…\dsh-system-prompt\lib\index.js:114-116`）→ `…\dsh-agent-loop\lib\index.js:1012,1017-1025` 提交为 `system/message`。
5. **声明与执行同源**：`run_code` 执行时用**同一个 view** 造绑定：`$APP\node_modules\@deepseek-ai\dsh-tools\lib\types\ptc.js:576-580` `for (const schema of registry.schemas(exec.agent)) { if (schema.name === RUN_CODE_NAME) continue; Object.defineProperty(functions, schema.name, ...) }`，注释 `:572-575`："the same view the SDK section declared, so a program can bind exactly what its prompt promised; sub-dispatch re-resolves per call through the same view"。→ 提示词里声明的名字集合与程序里可绑定的名字集合**不可能漂移**（`registry.schemas` 与 `sdkSchemas` 都走 `view(scope)`，`…\dsh-tools\lib\index.js:3021-3026`）。

### 3.2 与 native function-calling schema 在体积与位置上的差别

| 维度 | native | ptc |
|---|---|---|
| **位置** | API 请求的 `tools` 字段（`…\dsh-agent-loop\lib\index.js:1170,1212`），每请求一份 | 系统提示词的 `tools:sdk` 段（order 5000），请求 `tools` 只剩 run_code |
| **条数** | 每个可见工具 1 条 | 1 条（run_code）+ 1 个声明块 |
| **形状** | JSON Schema `{name, description, parameters}`（`…\dsh-tools\lib\index.js:3037-3046`） | TypeScript 接口 + JSDoc + `ToolName` 联合 + 调用签名 |
| **是否携带输出形状** | 不携带（`schemas()` 只投影三字段，`:3021-3023`） | **携带**（`sdkSchemas` 追加 `output`，`:3027-3033`）；Python 版注释明说这是刻意的：`$APP\node_modules\@deepseek-ai\dsh-tools\lib\index.js:1765-1770` "under mode: 'ptc' the native tool schemas are omitted from the request, so this generated SDK is the model's ONLY source for each tool's argument names, required fields, types, descriptions, and canonical output shapes" |
| **体积** | 各工具 JSON Schema 之和；且每个工具另有自己的 prompt 指南段（如 `…\dsh-tool-fs\lib\index.js:323, 588, 736`），信息与 schema 有重叠 | 声明块通常**更长**（JSDoc 排版 + `?:` 可选标记 + `JsonValue` 泛化 + 输出类型 + 固定说明文字），而且它还要承担"ptc 下唯一信息来源"的完备性要求 |

**结论（不夸大）**：ptc 不是"更省 token"，而是**换了位置和集合**——(a) 每请求的 `tools` 字段从 K 条降到 1 条；(b) 输出形状进入了上下文（native 从不提供）；(c) 声明块落在稳定系统前缀里，而 native 的 schema 落在每请求字段里。`…\dsh-agent-loop\lib\index.js:1019` 的 `toolsChanged(assembly.tools)` 会因 `tools` 变化而开启新的请求序列（`startsSeries`），所以"哪些东西在请求序列内保持字节稳定"确实是这套设计关心的量。PTC preset 里 plan-mode 段的注释也印证同一取向："The tool catalog stays the same across modes for request-cache stability."（`…\dsh-agent-presets\presets\ptc\agent.cordis.yml:126`）。
**本票未做**：没有抓取两种模式的真实请求体做字节/Token 对比（见 §7）。

---

## 4 Tool Registry 如何控制可见性；host plane / agent plane 接缝在哪、为什么

### 4.1 一个解析器喂三处消费者

`$APP\node_modules\@deepseek-ai\dsh-tools\lib\index.js:2659-2661`（模块注释）："Tool registry and execution pipeline. Scoped registrations shadow globals; **one visibility resolver feeds presentation, lookup, and dispatch**."

- `view(scope)`（`:2957-2983`）是唯一解析点：global 层 + scope 链上每一层（不含本层）的工具合成"继承面"→ 对继承面逐层应用 `layer.admits(name)`（`:2641-2643`，allow/deny 交集）→ 再叠加**本层 own 注册**（不受 restriction 过滤，`:2973-2976`，理由见 `:2942-2953` 注释：delegation 会把子代理的结构化输出工具注册进子代理自己那层，过滤器不能把它砍掉）→ 非 native 时追加保留的 `run_code`（`:2977`）。返回 `{ visible, knownNames, restrictableNames }`。
- 三个消费者：
  - **presentation**：`schemas()`（`:3021-3023`）→ `systemPrompt.assemble` → API `tools`；`sdkSchemas()`（`:3025-3035`）→ SDK 段。工具包自身也用同一解析结果决定自己的指南段是否渲染：`$APP\node_modules\@deepseek-ai\dsh-tool-fs\lib\index.js:323,588,736`、`…\dsh-tool-fs-search\lib\index.js:779,1088`、`…\dsh-tool-web\lib\index.js:259,734`、`…\dsh-file-reference-local\lib\index.js:346` 全是 `text: ({scope}) => ctx.tools.get("read", scope) === undefined ? "" : …` 这种形状（**工具不可见 → 它的提示词段自动消失**）。
  - **lookup**：`get(name, scope)`（`:2993-2995`）。
  - **dispatch**：`resolveExecution`（`:3009-3014`，叠 mode collapse）与 `executionMode`（`:3054-3062`，失败即独占的并发分类）。
- 写侧控制：
  - `register`（`:2876-2885`）：`run_code` 名字被保留，注册即抛（`:2883`；`lib/types/ptc.js:236-237, 475` 同样声明它是 "presentation infrastructure under non-native modes, outside the filterable global/scoped capability layers"）。
  - `restrict({allow?, deny?})`（`:2893-2908`）：必须从 scoped ctx 调（`:2895`）、空过滤抛错（`:2898`）、不能命名 `run_code`（`:2903`，"restrict end-capability tools instead"）、不能命名未知或 scope-local 名（`:2904-2906`）。实例消费者：`$APP\node_modules\@deepseek-ai\dsh-experimental-browser-use-runtime\lib\types\mcp.js:61-65` 用 `ctx.tools.schemas(agent).filter(...)` + `ctx.tools.restrict({ deny: [...] })` 给单个 agent 屏蔽继承来的 MCP 工具。
  - `guard`（`:2919-2934`）：单调否决，global 优先，然后 scope 链最远优先。
  - 子调度豁免：`collapse` 只看 `exec.parent`（`:3096-3098`、`:3138`、`:3055`）；工具/策略也能反过来识别嵌套调用，例如 `$APP\node_modules\@deepseek-ai\dsh-tool-fs-search\lib\index.js:506-520`（`acceptedDirectCallValue` 在 `exec.parent !== void 0` 时直接放弃 spill 投影）。

### 4.2 接缝的确切位置

**host plane（`$APP\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml`，进程级、与任何 session 无关）**
- `:483-486` `- id: tools / name: '@deepseek-ai/dsh-tools'`，**不写 mode**（注释："Presentation mode is a deployment choice; omitting it here keeps the schema default (native)"）→ 这一行的 `defaultMode` 就是 registry 的默认呈现。
- `:376-377` `- id: ptc-runtime / name: '@deepseek-ai/dsh-ptc-runtime-node'` → `ctx.ptcRuntime` 也是 host-plane 服务。
- `:212-213` `sandbox`、`:215-219` `sandbox-policy`、`:221-229` `bash-sandbox/pwsh-sandbox`：策略栈都是 host-plane。

**agent plane（preset 文件，mount 到某 agent 的 scope ctx）**
- `$APP\node_modules\@deepseek-ai\dsh-agent-presets\presets\ptc\agent.cordis.yml:277-280`：`- id: tool-presentation / name: '@deepseek-ai/dsh-agent-tool-presentation' / config: { mode: ptc }`。
- 该行的全部实现就是一次 scoped 声明：`$APP\node_modules\@deepseek-ai\dsh-agent-tool-presentation\lib\index.js:41-49` → `ctx.tools.presentAs(mode)`（ptc/both 时先 `ctx.inject(["ptcRuntime"])`）。
- `presentAs` 把答案写进**这一 scope 的 `ToolLayer.mode` 单格**：`…\dsh-tools\lib\index.js:2623-2639`（字段声明 `:2626-2632`，注释 "One cell rather than an entry table: two answers to 'which form does the model see' is a contradiction, not a merge"）、写入与回滚 `:2808-2824`。解析 `modeFor(scope)`（`:2765-2772`，最近 scope 优先，否则 `defaultMode`）。
- 这一格同时决定四件事：请求里的 tools 集合（`:2829-2846`）、`view()` 是否追加 `run_code`（`:2977`）、两段提示词文本（`:2730`、`:2748-2756`）、直呼是否被拒（`:3096-3098`）。
- 提示词 section 也随之落在这个 scope（`:2819-2822`）。

**"接缝"就是这一个函数调用 `ctx.tools.presentAs(mode)`**：左边是 host 拥有的、进程级的 registry（含 `run_code` transport 定义本身，`…\dsh-tools\lib\index.js:2782-2796` `requirePtcTransport()`）；右边是 agent 拥有的、scope 级的呈现选择（外加两段 scope 级 prompt section）。

### 4.3 为什么这样切（三条都能在源码/注释里读到）

1. **registry 的消费者在 agent 之外，所以它不能搬进 preset。** 注释：preset `:8-11`（"the agent loop's scheduler and the API proxy's presenters are its consumers"）、`dsh-agent-tool-presentation\lib\index.js:3-13`（"it cannot move into a preset"）。可核实的消费者：`…\dsh-agent-loop\lib\index.js:527,625`（`ctx.tools.executionMode`）、`…\dsh-tools\lib\index.js:2674-2679` 的 `[TOOL_RUNTIME_SCHEDULER]`（由 agent-loop 的并行调度器使用，`…\dsh-agent-loop\lib\index.js:574,586,590`）、`…\dsh-cordis-host-runner\lib\index.js:543,582-583`（插件沙箱按 scope 暴露 `ctx.tools.register/schemas/get`）、`…\dsh-tool-call-timeout-policy\lib\index.js:123`、`…\dsh-spill-policy\lib\index.js:73`、`…\dsh-mcp-client\lib\index.js:153`、`…\dsh-mcp-resources\lib\index.js:55-75`。注：preset 注释点名的 "API proxy's presenters" 我只能核实到 `presentCall/presentResult` 的**声明侧**（`…\dsh-tools\lib\index.js:843-875` 把它们装到 definition 上，渲染意图词表见 `…\dsh-tools\lib\types\presentation.js:1-7`）与工具包里的定义处；**未能定位到本机哪一个 host 包在调用它们**（见 §7）。
2. **preset 里的 service 行必须是 isolate realm，否则第二个 session 会撞车。** preset `:19-25`：没有 realm 就发布到 root realm，变成进程级；`dsh-agent-presets` 在 mount 时拒绝。也就是说"preset 想拥有一个进程级单例"这条路**在机制上被封死**。而 presentation 恰好是天然的 per-agent 数据，放进 `ToolLayer` 就自动获得 scope 生命周期与 `:2811-2823` 的精确 disposer。
3. **必须在同一进程里让 ptc 与 native 会话并存。** preset `:10-11`："Native sessions run beside this one in the same process, each seeing its own catalog." → 只能 per-scope 覆盖，不能进程级替换（否则就是 `presentAs` 报错文案里的 "`mode` config field on the tools row"，`:2810`）。
4. 附带一条可操作判据：preset 注释给出"什么叫 host-plane 所有权"的标准——**"host row that injects a service 就是 host-plane"**（preset `:45-51` 用 `shell-env` 举例：它注入 `DSH_WEB_URL`/`DSH_WEB_MODE`，所以必须在 host）。`NodePtcRuntime` 注入 `fs/subprocess/sandbox/sandboxPolicy`（`…\dsh-ptc-runtime-node\lib\index.js:765-770`），同理属于 host。

---

## 5 为什么 PTC 把多次 function call 折叠成一个 TypeScript 程序

先给**源码自己写下的动机**，再给**我对传统 function-calling agent framework 结构性缺陷的归纳**（后者是分析，不是源码陈述）。

**源码动机**
- `…\dsh-agent-presets\presets\ptc\agent.cordis.yml:4-6`："The `tool-presentation` row turns the remaining registry into a generated SDK, **so a sequence that would be five round trips becomes one**."
- `…\dsh-tools\lib\types\ptc.js:1-6`："Programs call the registry's agent-visible tools through nested executions scheduled under the native concurrency contract; **each sub-dispatch is logged for reconstruction, while only the outer curated result enters model history**."
- `…\dsh-tools\lib\index.js:1697`（写进 SDK 的说明）："every other intermediate result stays out of the conversation, so extract just what you need."
- `…\dsh-tools\lib\index.js:2513-2517`：这条 collapse 规则必须显式写进提示词，否则 "a rule the model can only discover by being denied is one it corrects too late"。
- `…\dsh-agent-presets\presets\ptc\agent.cordis.yml:237-241`：PTC 模式下 `tool-workflow` 被关掉，注释 "Do not publish a second model-authored orchestration surface beside run_code in PTC mode"。

**结构性缺陷 → DSH 的处置**

1. **往返放大 / 上下文单调增长。** 传统形态下 N 次工具 = N 次模型往返，每轮都要重发整段会话，且每个中间结果永久进入 history。PTC 把 N 个 sub-dispatch 压进一次 `run_code`，子调用只落会话事件（`tool/ptc-dispatch`、`tool/ptc-dispatch-start`，`…\dsh-tools\lib\types\ptc.js:470-502`，注释 `:466-468` 说明日志是"append snapshots the final copy again, so the log stays detached"），模型可见的只有外层渲染结果（`:281-289`，只有 `logs` + `result` + 可选的 `sandbox` 三元组被返回，`:610-614`）。图片类子结果例外，改为 `exec.deferContext(...)` 附加进上下文（`:524-529`），`additionalContexts` 同样转发（`:530-532`）。
2. **控制流无法表达。** 循环、条件分支、提前返回、扇出-汇聚在"工具调用序列"里只能由模型逐轮重推；PTC 给的是真程序（顶层 `await/return`：`…\dsh-ptc-runtime-node\lib\process.js:1027-1030`；SDK 指令 `…\dsh-tools\lib\index.js:1692-1699`），扇出直接写 `Promise.all`，而**并发语义仍由宿主裁决**：驱动循环按 `head.classify()`（`…\dsh-tools\lib\types\ptc.js:377-380`，实现是 `registry.executionMode(input)`，`:491`）决定是并行槽位还是独占，独占调用必须等池空并挡住后续启动（`:365-366`、`:378-388`）——即"程序里能并行"，但"并行的安全性仍由工具自己声明的 `isConcurrencySafe` 决定"（`…\dsh-tools\lib\index.js:3054-3061` 失败即独占）。
3. **编排状态只能靠模型记忆。** 中间变量（文件名列表、上次输出）在传统形态下要么重述进下一轮 prompt，要么丢失；PTC 里就是普通局部变量（同一个 `AsyncFunction` 作用域），程序之外的宿主只看到精炼后的 `return`/`console.log`。
4. **失败处理粒度粗。** 传统形态下工具失败只能整轮重试。PTC 有程序内 `try/catch`：子调用失败变成 `ToolCallError`（宿主 `…\dsh-tools\lib\types\ptc.js:559-563`；注入 `:587-590`；子进程侧构造 `…\dsh-ptc-runtime-node\lib\process.js:891-903`），程序自身异常/超时/输出超限统一成 `CodeRunFailedError`（`…\dsh-tools\lib\types\ptc.js:122-127`），消息里带 captured logs 与 sandbox 事实供模型自纠（`:604-608`）。
5. **编排面重复。** 若既有 `workflow`（脚本编排）又有 `run_code`（程序编排），模型就有两条"自己写编排"的路。PTC 模式显式只留一条：`workflow-ptc`/`tool-workflow`/`tool-ralph` 都 `disabled: true`（preset `:229-252`）。而标准模式下的 `workflow` 本身也跑在 PTC runtime 上（`…\dsh-workflow-ptc\lib\index.js:579-595` 注入 `ptcRuntime`+`sandboxPolicy`，`:424-425` `timeoutMs: null` 表示 workflow 运行不设程序预算），所以这条"二选一"是刻意的产品决策，不是能力缺失。
6. **折叠不必牺牲治理。** 子调度仍走完整工具管线（`prepare → dispatch → finalize|finish`，`…\dsh-tools\lib\types\ptc.js:506-523`，符号 `…\dsh-tools\lib\index.js:2526, 2674-2679`）：pre/guard/around/post/result、approval、会话日志、失败分类一律保留；被折叠掉的只有"模型直接点名别的工具"（`:3180`）。同时 `both` 模式保留直呼能力，说明"折叠"是**可选的呈现**，不是能力开关（`:2723`、`:2842-2845`）。
7. **折叠后的新代价被显式管理**（这点很能说明设计取向）：单次运行的墙钟预算与复杂度必须重新设界，于是有了 §2.3 那一整组上限，以及"程序结果必须是 lossless JSON"的边界（子进程 `snapshotPtcJsonValue`，`…\dsh-ptc-runtime-node\lib\process.js:434-535`；宿主 `decodePtcJsonWire`，`:1084-1088`）。

---

## 6 一句话：为什么 DeepSeek Harness 要这样设计

**因为 agent 的真实工作是"对工具的控制流"，而不是"一串碰巧相邻的工具调用"——所以它把控制流下沉给模型写的一段程序（`run_code`），同时把工具注册表、沙箱、审批、会话日志留在宿主的单一可见性解析器后面，再用一个 per-scope 的呈现格（`ToolLayer.mode`）把这两半缝在同一进程里，从而在"不放松治理、不重复编排面"的前提下把 N 次模型往返换成 1 次。**

支撑位置：`$APP\node_modules\@deepseek-ai\dsh-tools\lib\index.js:2659-2661`（one visibility resolver feeds presentation/lookup/dispatch）、`:2765-2772`（per-scope mode 解析）、`:2829-2846`（同一 mode 决定请求 tools 集合）、`:2977`（非 native 才追加 run_code transport）、`:3025-3035`（SDK 与绑定同源于 `view(scope)`）；`…\dsh-tools\lib\types\ptc.js:1-6, 424-565`（子调度走原生管线、只有外层结果进历史）；`…\dsh-agent-presets\presets\ptc\agent.cordis.yml:4-25, 272-280`（折叠动机 + agent-plane 呈现选择 + host-plane 注册表）；`…\dsh-agent-tool-presentation\lib\index.js:3-49`（接缝模块本体）。

---

## 7 未发现 / 无法证实

1. **被源码注释引用的文档在本机不存在**：`…\dsh-tools\lib\index.js:2497-2511` 点名 `docs/subsystems/ptc-runtime.md`（及其中文对）、`dsh-ptc-runtime` 的 README 对、`…\dsh-tools\lib\index.js:1688` 指名 "the PTC mode Agent Note's 'What the model sees'"。这些包只发布 `lib/**`（`$APP\node_modules\@deepseek-ai\dsh-tools\package.json:36-41` 的 `files`），`$APP` 下没有 `docs/` 目录。→ 本票只能以**代码与代码注释**为权威，无法核对文档原话。
2. **`mode: both` 无实机样本**：全仓 grep 只命中类型声明/默认值/叙述字符串（`…\dsh-tools\lib\index.js:1767`、`…\dsh-tool-cordis\lib\index.js:9268`、`…\dsh-tools\lib\types\index.js:221`），没有任何 composition 或 preset 使用它。§1.2 中 `both` 的行为来自 `wireSchemas`/`collapseSection` 的代码路径推导，**不是实机观测**。
3. **未做真实请求体对比**：没有把 native 与 ptc 两种会话的真实 LLM 请求抓下来做字节/Token 对照；§3.2 的体积结论是结构性的（位置、条数、字段集合），**不是测量值**。
4. **本票未在本机切到 PTC 会话实跑**：`C:\Users\Administrator\.dsh-community\.agent-presets` 下只有 `liangshen` 与 `value-mode`，两者都不含 `tool-presentation` 行（grep 全目录零命中），PTC 只能通过内建 preset（`…\dsh-agent-presets\presets\ptc\preset.yml`，菜单名 "PTC 模式"，order 2）使用。切换会话模式会改动用户环境，超出本票只读纪律，故未执行。
5. **preset 注释点名的 "API proxy's presenters" 未定位到具体调用点**（preset `:8-10`）：我能核实 `presentCall/presentResult` 的声明侧（`…\dsh-tools\lib\index.js:843-875` 把回调装到 definition；渲染意图词表 `…\dsh-tools\lib\types\presentation.js:1-7`）和众多工具包里的定义处（如 `…\dsh-tool-fs\lib\index.js:452,665,817,1112`），但在本机 grep `\.presentCall\b` 只命中 `dsh-tools` 自身（`lib/index.js:843,871`、`lib/types/schema.js:285,327`、`lib/types/presentation.js:3`）。**"某个 host 包在渲染时会调用它"这一点未能证实**；已核实的 registry 外部消费者是 agent-loop 的调度器、timeout-policy、spill-policy、mcp-client/mcp-resources、cordis-host-runner 插件沙箱，以及各工具包自己的 `ctx.tools.get(name, scope)` 提示词门。
6. **PTC 与 bash 的关系未实机验证**：`bash-sandbox` 在本机是 `disabled: true`（`…\dsh-base\cordis.patch.yml:221-223`，Windows 平台），`pwsh-sandbox` 才是生效者；"与 bash 同一对服务"的结论来自 `dsh-bash-sandbox` 与 `dsh-pwsh-sandbox` 同构的注入/调用形态推断，**未逐行核对 bash 侧文件**。
7. **未发现任何"默认启用 PTC"的部署配置**：`presets/ptc/preset.yml` 只有 `name/description/order` 三个字段；host composition 的 tools 行不写 mode（`:483-486`）。即本机默认是 native，PTC 需要用户显式选择预设。
