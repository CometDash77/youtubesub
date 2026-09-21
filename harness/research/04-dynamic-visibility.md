# 04 按任务加载能力：tool-presentation 与 liangshen preset 的动态可见性机制取证

票：#14（wayfinder:research）。全部结论来自本机实读文件，行号为实读行号；未查到的写「未发现」。

## 0. 取证环境（版本与绝对路径）

- Desktop 版本 **4.2.1**：`C:\Users\Administrator\.dsh-community\community\migrations\desktop-v4.2.0.json` L2-L4（`"desktopVersion": "4.2.1"`、`"state": "COMMITTED"`、`committedAt: 2026-09-21T01:02:19.889Z`）。
  - 存在冲突记录：`C:\Users\Administrator\.dsh-community\community-home.json` L6 仍写 `"desktopVersion": "4.1.0"`（verifiedAt 2026-09-18），是上一轮校验的残留，不代表当前版本。
- 所有 `@deepseek-ai/*` 包版本 **0.1.6-alpha.2**。逐包实读 `<pkg>/package.json` 的 `version` 字段：dsh、dsh-tools、dsh-agent、dsh-skill、dsh-tool-skill、dsh-agent-presets、dsh-ptc-runtime、dsh-plugin-manager、dsh-agent-tool-presentation 全部为 0.1.6-alpha.2。
- `$APP` = `C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness Desktop\resources\app.asar.unpacked`
- profile 的依赖是 `link:` 指向 `$APP\node_modules\...`（`...\.dsh-community\profiles\desktop\package.json` L2 起），因此 **$APP 就是当前运行的权威源**；`D:\Documents\vibe\_dsh_diag` 未被用于任何结论。
- 用户侧技能根 `C:\Users\Administrator\.agents\skills` 下 `SKILL.md` 实测 **32** 个（glob `SKILL.md` 命中 32 条）。

## 1. liangshen preset 四个模块分别做什么、接哪些服务

四个模块都是 **preset 本地插件**（`agent.cordis.yml` L157-L173 以 `./xxx.mjs` 挂载），共用一个「事件回放 + 消息注入」模式。

### 1.1 paging.mjs（232 行，纯函数，零 Cordis 依赖）

- 不 `import` 任何包，无 `apply`/`inject`：全文只有注释与 `export function/const`（L22 起）。
- 职责：`DEFAULT_PAGED_TOOL_PATTERNS = ['mcp__*']`（L22）、LRU 上限 3（L25）、`TOOL_ACTIVATE_NAME = 'tool_activate'`（L28）、`patternNamespace/namespaceOf`（L66/L77）、`partitionWireTools`（L91）、`withheldToolNames(..., reserved = ['run_code'])`（L122）、`replayActivations(events, capacity, patterns)`（L182）、`summarizeInactive`（L219）。
- 状态真源是 session 事件流：`replayActivations` 只读 `event.type === 'tool/result'`（L186）与 `'tool/call'`（L200），失败的 `tool/result` 通过 `callId` 排除（L188、L202）。

### 1.2 tool-catalog.mjs（1023 行）

- `inject = ['systemPrompt']`（L88）；`apply(ctx, config)` L493。
- 接的服务（**不是**通过 inject 静态注入，是运行时 `ctx.get`）：
  - `ctx.get('tools')`（L654 `const registry = () => ctx.get('tools')`）
  - `ctx.get('ptcRuntime')`（L659 `transportReady`）
  - `ctx.get('systemPrompt')`（L851，用于声明后重新 assemble）
  - `agent.ctx.tools.presentAs(mode)`（L679）
  - `agent.ctx.tools.restrict({ deny })`（L602）
  - `agent.ctx.tools.schemas(agent)` / `sdkSchemas(agent)`（L734-L747、L749-L779）
- 接的官方事件（5 个）：`agent/created`（L793）、`agent/disposed`（L804）、`tools/post-execute`（L819，`{ prepend: true }`）、`system-prompt/assemble`（L828）、`agent/pre-step`（L996）。
- 机制：每 scope 只声明一次 presentation（`agentDeclared` WeakSet L542）；ptc 折叠 wire 时把 paging 表达成 **registry restriction**（L601-L616，因为折叠后 wire 只剩 `run_code`，只过滤数组等于什么都没过滤，见 L36-L44 注释）；restriction 装在 assembly 之外（L46-L54、L620-L651），并存的 `run_code` 保留名不参与过滤（paging.mjs L122）。

### 1.3 tool-activate.mjs（176 行）

- `inject = ['tools']`（L41）；`apply` 里 `ctx.tools.register({ name: 'tool_activate', ... })`（L82-L176），返回 disposer（未保存）。
- 读 tool schema 的兜底顺序：`[agent?.ctx?.tools, ctx.tools, ctx.get('tools')]`（L66），方法 `schemas` → `sdkSchemas`（L69）。
- 从 `exec.agent.session` 读事件：`session.events` 或 `session.snapshotEvents()`（L44-L48、L152-L157），并用 `exec.callId` 排除自身这次调用（L151-L157）。
- 激活动作本身不写任何内存状态：它是这次 `tool/call` 的持久化事件，catalog 侧在 `tools/post-execute` 重放（L11-L16 注释）。

### 1.4 working-context.mjs（214 行）

- `agent/pre-step`（L178）里把 plan 模式、活跃 namespace、in-progress todos 折成一行 `[Working Context: ...]` 注入；内容不变则不重复发布（L199-L203）。
- 依赖 `agent.session` 的 `snapshotEvents()`/`events`（`sessionEvents` 同 paging 侧写法）。

### 1.5 minimal-prompt.mjs（870 行，附带）

- `inject = ['systemPrompt']`（L96）；事件：`system-prompt/assemble`（L740）、`tools/result`（L793）、`agent/pre-step`（L807）、`session/event`（L861，处理 `compaction/end` 恢复）。
- 通过**过滤 assembled.sections** 把系统提示收窄到白名单：`PERSONA_SECTION_NAMES`（L103）、`PLAN_POLICY_SECTION_NAME = 'plan:policy'`（L106）、`PTC_SECTION_NAMES = ['tools:ptc-only','tools:sdk']`（L113）、`WORKSPACE_INSTRUCTIONS_SECTION_NAME`（L122）。
- 只用 `node:fs/promises`、`node:os`、`node:path`（L88-L90）+ `ctx.logger`，不读额外服务。

### 1.6 重要事实：现装配置下 paging 是关闭的

- `agent.cordis.yml` L157-L173 实际只挂了 3 个 preset 本地行：`minimal-prompt`（L157）、`tool-catalog`（L164，`pagedToolPatterns: []` 见 L169）、`working-context`（L172）。
- **全文件没有任何 `tool-activate` 行**：`grep -n "^- id:"` 的 20 行清单里只有 `- id: persona/minimal-prompt/tool-catalog/working-context/agent-instructions/...`，没有 tool-activate；只有头部注释 L151-L156 描述它。
- `pagedToolPatterns: []`（L169）意味着 `withheldToolNames` 恒为空 → restriction 不装，paging 与 `tool_activate` 在当前配置下**完全未生效**。磁盘上的 `paging.mjs`/`tool-activate.mjs` 目前是死代码（可当参考实现，不是运行先例）。

## 2. 官方 tool-presentation 是否支持运行时改变可见集合（q3）

### 2.1 preset 行本身是静态的

`$APP\node_modules\@deepseek-ai\dsh-agent-tool-presentation\lib\index.js` 全文 51 行（包内只有 `lib/index.js`、`package.json`、`LICENSE` 三个文件）：

- `const inject = ['tools']`（L29）；`const Config = z.object({ mode: z.union(['native','ptc','both']).required() })`（L31-L35）；
- `apply(ctx, config)`（L41-L49）：`native` → `ctx.tools.presentAs('native'); return`（L42-L45）；否则 `ctx.inject(['ptcRuntime'], (runtimeCtx) => runtimeCtx.tools.presentAs(config.mode))`（L46-L48）。
- 该包**未导出任何运行时切换 API**，只在 mount 时声明一次。

### 2.2 但宿主 API 支持运行时改变（入口在 dsh-tools）

`$APP\node_modules\@deepseek-ai\dsh-tools\lib\index.js`：

| 能力 | 签名位置 | 运行时语义 |
| --- | --- | --- |
| `tools.presentAs(mode)` | L2808-L2824 | 要求 scoped ctx（L2810 抛错）；同 scope 二次声明抛 `conflicts with ... already declared for this scope`（L2813）；**返回 disposer**（L2811 `ctx.effect(...)`、L2823），dispose 后 `layer.mode = void 0`（L2815-L2817）→ 可释放后按新 mode 重声明 |
| `tools.restrict(filter)` | L2893-L2908 | 要求 scoped ctx（L2894-L2895）；`allow`/`deny` 至少一个（L2898）；**返回 disposer**（L2907）；不能点名 `run_code`（L2903）；未知名抛错（L2906） |
| `tools.register(def)` | L2876-L2885 | 进调用方 scope 的层（L2884 `layers.effect(this.ctx, ...)`），**返回 disposer** |
| `view(scope)` | L2957-L2983 | 继承面 → 逐层 `admits` 过滤（L2971）→ 本层注册**豁免 restriction**（L2973-L2976）→ 非 native 追加 `run_code`（L2977） |
| `schemas(scope)` / `sdkSchemas(scope)` | L3021-L3022 / L3025-L3035 | 每次调用按 scope 现算 |

- 注册表变更通知：`layers` 构造时 `() => this.ctx.emit('tools/change')`（L2688-L2690）；wire 由 `ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope))`（L2705）在每次 assemble 重算。
- **结论：可见工具集合可以运行时改变**，入口是 `agent.ctx.tools` 的 `register` / `restrict` / `presentAs`，三者都返回 disposer；`presentAs` 的「模式」也能运行时换，但一个 scope 同时只能有一个声明，换之前必须先 dispose。

## 3. 时序硬约束：改动只能下一轮生效

`$APP\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js` L883-L906 `preStep()`：

- L888 先 `await this.loopCtx.systemPrompt.assemble(...)`
- L892 之后才 `await this.dispatch.waterfall('agent/pre-step', {...})`

→ 在 `agent/pre-step` 里注册/限制工具，**只影响下一次 assemble**（即下一轮请求）。要与本轮 wire 一致，必须在 assemble 之前动手；liangshen 正是因此把 restriction 装在 `agent/created`（L793-L800）与 `tools/post-execute`（L819-L822）——见 tool-catalog.mjs L46-L54、L620-L651 的注释。

另外：`agent.ctx` 是真正的 per-agent scoped context，官方构造点为 agent-loop L759-L760（`this.scope = createScope(loopCtx, this); this.ctx = this.scope.ctx`）。

## 4. skill 侧有没有官方动态加载入口（q5）

### 4.1 有：`ctx.skills` 是与 tools 同构的 scoped 注册表

`$APP\node_modules\@deepseek-ai\dsh-skill\lib\index.js`（566 行）：

- `SkillLayer`（L95-L107）、`SkillRegistry`（L119）、`layers = new ScopedLayers((scope) => new SkillLayer(scope), () => { this.invalidateCache() })`（L122-L124）。
- `registerProvider(create)` L147-L183：provider 注册进调用方 scope 的层，返回 disposer。
- **`register(skill)` L193-L215（运行时技能注册）**：`scopeOf(this.ctx)` 决定层（L195-L196），写 `layer.runtime`（L210），**返回 disposer**（L209-L214）；同层同名 first-wins 并 warn（L197-L200）。
- 读取全部是 scope 敏感的：`snapshot(options)` L234、`list` L224、`get` L250；合并顺序 `[this.layers.global, ...this.layers.chainLayers(options.scope)]`（L299），cache key 含 scope 链与 revision（L270、L395-L401）。
- 变更广播：`invalidateCache()` → `notifyChange()` → `ctx.events.dispatch('emit', ['skills/change'])`（L376-L412）。

### 4.2 消费侧会自动重发目录（无需自研注入）

`$APP\node_modules\@deepseek-ai\dsh-tool-skill\lib\index.js`：

- `agent/pre-step`（L203-L236）每次 `ctx.skills.snapshot({ cwd, signal, scope: agent })`（L207-L210），digest 变化则发布/替换目录消息（L219-L235）。
- **但 catalog 是「全有/全无」**：L52-L55 注释 + L207 `ctx.tools.get(skillTool.name, agent) === skillTool ? ... : { skills: [], complete: true }` —— 只要 `skill` 工具被 restriction 或 scoped shadow 掉，schema 与目录指引**一起消失**。

### 4.3 静态粒度控制只有 SKILL.md frontmatter

`$APP\node_modules\@deepseek-ai\dsh-skill-filesystem\lib\index.js` L850-L861：支持 `disable-model-invocation`（→ `modelInvocable: false`，L853-L856）与 `user-invocable`；旧键 `disableModelInvocation`/`modelInvocable` 被显式拒绝（L850-L851、L861）。这是**文件级、进程级**开关，不是按任务。

### 4.4 「32 个技能全量注入目录」的机制

- `dsh-skill-filesystem` `roots(cwd)` L150-L188：project `.dsh/skills`(rank100)、project `.agents/skills`(200)、`customSkillDirs`(300)、`$DSH_HOME/skills`(400)、`~/.agents/skills`(500)、`bundledSkillDir`(BUNDLED_SKILL_RANK=600，来自 dsh-skill L23)。
- `apply`（L46-L61）通过 `ctx.skills.registerProvider(...)` 注册；默认 `watch: true`（L35），chokidar 监视（L372-L420），文件变动 `control.invalidate()`（L242-L243、L469）→ 目录自动更新。
- 实测用户根 `C:\Users\Administrator\.agents\skills` 有 32 个 `SKILL.md`；另叠加 bundled deck 的 `profiles\desktop\node_modules\dsh-mattpocock-skills-deck\bundled-skills\*/SKILL.md`。
- 每个 skill 的可见性还会被 `isModelInvocable` 过滤（dsh-tool-skill L217）。

### 4.5 未发现

- **未发现**任何「按任务/按需加载单个 skill」的官方 API 或事件（dsh-skill 566 行与 dsh-tool-skill 396 行全文读毕，公开面只有 `register`/`registerProvider`/`list`/`snapshot`/`get` 与 `skills/change`）。
- **未发现** per-skill 的可见性开关（只能整体隐藏 `skill` 工具，或自己 `agent.ctx.skills.register` 塞 runtime skill）。

## 5. `dsh-plugin-manager/tools`（ptc preset 里 `disabled: true`）能提供什么（q4）

- 包导出 `./tools` → `$APP\node_modules\@deepseek-ai\dsh-plugin-manager\lib\types\tools.js`（74 行），注册**单个**工具 `plugin_manager`（L12）。
- `inject = ['tools','pluginManager','sandboxPolicy']`（L6）；动作枚举 `list_plugins / list_bundles / set_plugin / set_bundle / install_bundle / remove_bundle`（L15）；每次调用强制 `danger-full-access` 审批（L28-L32 `approveEscalation`）。
- 语义是**当前 profile 的插件与 bundle 管理**（`manager.listPlugins()`/`setPluginEnabled()`/`installBundle()`/`removeBundle()`，L43-L66），进程级、跨全部 session，不是 per-agent/per-task。
- 生效方式：`setPluginEnabled`/`setBundleEnabled` 调 `reload()`（`lib\index.js` L845-L852、L867）；`reload` 在有 `ctx.hmr` 时热应用，否则 `return []` 并由调用方标 `restart-required`（L1130-L1141，L941）。
- 内置 preset 中的行：`...\dsh-agent-presets\presets\ptc\agent.cordis.yml` L285-L287（`disabled: true`）、`presets\standard\agent.cordis.yml` L264-L266（`disabled: true`）、`presets\cordis\agent.cordis.yml` L282-L283（未 disabled）。与票面一致。
- **结论：与「按任务动态加载能力」不相关**。打开它只是给 agent 一个需要高权限审批的 profile 级插件管理工具，且会污染全局而非当前任务。

## 6. 可复用点

以下全部是官方公开接缝，且都**返回 disposer**，可以「加载—卸载」成对使用：

1. `agent.ctx.tools.register(def)` → 卸载：调用返回的 disposer。scope 内可见（dsh-tools L2876-L2885、L2973-L2976）。
2. `agent.ctx.tools.restrict({ deny })` → 卸载：disposer（dsh-tools L2893-L2908）。
3. `agent.ctx.tools.presentAs(mode)` → 还原：disposer（dsh-tools L2808-L2824）。
4. `agent.ctx.skills.register({ name, description, content, ... })` → 卸载：disposer（dsh-skill L193-L215）；`ctx.skills.registerProvider`（L147-L183）用于整provider 级。
5. 事件名全部真实存在（逐条 grep 官方包计数）：`agent/created` 29 处、`agent/disposed` 28、`tools/post-execute` 26、`tools/result` 23、`system-prompt/assemble` 12、`agent/pre-step` 25、`session/event` 123、`skills/change` 5、`tools/change` 17。官方发射点举例：`agent/created` 见 dsh-agent `lib\index.js` L545（`ctx.serial(entry.carrier, 'agent/created', { agent, source, signal? })`），`agent/disposed` 见 L514-L518。
6. 用 session 持久事件流当状态真源（`session.snapshotEvents()` / `session.events`）：resume/compaction 可重放，不需要进程内存。liangshen `paging.mjs` L182-L212 是完整可搬运的参考实现。
7. `paging.mjs` 是纯函数、零依赖，可整段复用（尤其 `replayActivations` 与 `withheldToolNames`）。

## 7. 不可复用点 / 是 hack 的地方

1. **现装 liangshen 的 paging 是关掉的**（`pagedToolPatterns: []`，`agent.cordis.yml` L169；且无 tool-activate 行）。它只能当参考实现，不能当「已经在跑的先例」。
2. 依赖 preset 私有约定与进程内状态：`agentDeclared`/`agentDeclareFailed`/`agentPaging`/`agentDisposers`（tool-catalog.mjs L542-L550）都是自建 WeakSet/WeakMap，不是官方契约。
3. `tools.schemas()`/`sdkSchemas()` 只是**schema 投影**，被 liangshen 当作 wire 表面来估算与记录（L734-L779、L938-L953）。真正的 wire 是 assemble 返回的 `assembled.tools`（L881-L883）。用投影代替 wire 是它自己的近似。
4. 过滤 `assembled.sections` 靠硬编码 section 名（minimal-prompt L754、L103/L106/L113）——这是对内部命名空间的依赖。
5. 手工调 `sp.assemble(context)` 重跑一次 assembly 来让声明当轮生效（tool-catalog L850-L866），是绕过「声明只能下一轮生效」的自救；`reassembling` WeakSet（L826）自证这是补丁式处理。
6. `tool_activate` 的激活状态完全依赖「工具调用事件 + 结果是否 error」这种语义推断（paging.mjs L182-L212），官方没有对应契约。
7. 五个模块全部用 `ctx.logger?.warn?.` 可选链吞掉失败（tool-catalog L523、minimal-prompt L733 等）→ 升级后失效是**静默**的。

## 8. 会在 DSH 升级时失效的点

1. 0.1.6 cohort 已经改过一次命名，且 liangshen 自己留了证据：
   - `agent/session-start` → `agent/created`（tool-catalog L784-L792 注释）
   - `codeRuntime` → `ptcRuntime`，包 `dsh-code-runtime` → `dsh-ptc-runtime`（tool-catalog L655-L658）
   - `anchorTools` 退役、`ptcPresentation` 布尔映射为枚举（L529-L533）
   这些都是硬编码字符串/事件名，再改一次即静默失效。
2. `agent/created` 的**参数形状**：payload 是对象、必须解构 `{ agent }`（tool-catalog L789-L792 明确写「读错就静默不生效」）。官方发射点 dsh-agent L545 确认当前是 `{ agent, source, signal? }`。
3. 内部 section 名与顺序 API：`tools:ptc-only`、`tools:sdk`（dsh-tools L2728、L2745）、`plan:policy`、`deployment:persona*`、`ctx.systemPrompt.getSectionOrder('TOOLS_SDK')`（dsh-tools L2746）。
4. 保留名 `run_code`：`tools.register` 禁止注册（dsh-tools L2883）、`restrict` 禁止点名（L2903）、paging 侧默认保留（paging.mjs L122）。
5. `ScopedLayers.effect` 的 disposer 语义与「一个 scope 一个 presentation」约束（dsh-scope L189-L218；dsh-tools L2813）。
6. preset mount 的硬审计：任一行不可用即整体 mount 失败（`N row(s) did not activate`），任何行把服务发布到 root realm 即被拒（`a preset service must sit behind an 'isolate' realm or move to the host composition`）——`dsh-agent-presets\lib\types\mount.js` L335-L368，尤其 L360-L368。把「动态加载器」做成 preset 行会被这两条约束住。

## 9. 与官方接缝的冲突风险

1. **一次只能一个 presentation 声明**：若同时挂 `@deepseek-ai/dsh-agent-tool-presentation`（内置 ptc preset 的做法，`presets\ptc\agent.cordis.yml` L277-L280 `config.mode: ptc`）又在自己插件里 `presentAs`，会抛 `tools.presentAs("...") conflicts with "..." already declared for this scope`（dsh-tools L2813）。liangshen 的选择是**自己不挂那一行**、由 tool-catalog 自己声明（对比 `agent.cordis.yml` L164-L170 没有 tool-presentation 行）。两条路不能并存。
2. **restriction 豁免本层注册**：restriction 只过滤「继承面」，own layer 注册的工具永远过滤不掉（dsh-tools L2942-L2947 注释、L2973-L2976 实现）。所以「按任务卸载能力」如果要卸载 preset 自己注册的工具，必须自己持有 `register()` 的 disposer，不能用 `restrict` 代替。
3. **时序天花板**：`agent/pre-step` 在 assemble 之后（agent-loop L888 vs L892）。「这一轮决定这一轮可见集合」在官方语义下不成立；要在 assemble 前动手（`agent/created`、`tools/post-execute`，或自己更早的 hook）。
4. **不能靠 restrict 关掉 PTC 传输**：`run_code` 是保留名（dsh-tools L2903、paging.mjs L122）。要关只能 `presentAs('native')`。
5. **skill 侧全有/全无**：restrict 掉 `skill` 工具会连带目录与指引一起消失（dsh-tool-skill L52-L55、L207-L214），无法「只藏一部分技能」。
6. **不能靠换 preset 实现按任务加载**：`agentPresets.recompose` 只在 agent 尚未产出任何东西时有效——`...\dsh-tool-cordis\lib\index.js` L283-L294 的契约原文：`Only valid while the agent has produced nothing: swapping tools mid conversation would leave logged tool calls the new composition cannot make.`
7. `dsh-agent-presets` 的 discovery 是 unmemoized（`...\dsh-tool-cordis\lib\index.js` L127-L139：`Discovery is unmemoized: list() and resolve() re-read the roots on every call`），也就是**新写一个 preset 立刻可见**——但只对新建的 agent 生效，不能热切到已产出的会话。
8. 运行时 plugin 热载只有 `dsh-plugin-manager` + `ctx.hmr` 这条**进程级**通路（`dsh-plugin-manager\lib\index.js` L1130-L1141），没有 per-agent 版本；`dsh-tool-cordis` 只提供**只读**的 `cordis_inspect_list` / `cordis_inspect_query`（`dsh-tool-cordis\lib\index.js` L9913、L9929），且只在内置 `cordis` preset 挂载（`presets\cordis\agent.cordis.yml` L260-L261），不是动态加载器。

## 10. 未发现 / 无法证实

- 未发现 `@deepseek-ai/dsh-agent-tool-presentation` 除 mount 期以外的任何运行时入口（包内仅 3 个文件，`lib/index.js` 51 行全文读毕）。
- 未发现 skill 侧任何按任务加载/卸载单个 skill 的官方入口（见 4.5）。
- 未发现 liangshen preset 真的挂载了 `tool-activate` 行；磁盘上的 `tool-activate.mjs`/`paging.mjs` 在当前 `agent.cordis.yml` 下不参与运行。
- 未发现 `dsh-agent-presets` 有「运行时把新工具挂进已存在 agent」的公开 API（只有 `mount`/`composeFrom`/`recompose`，`recompose` 受 9.6 限制）。
- 未核实（超出本票范围）：`web-ui-liangshen` 插件（`profiles\desktop\cordis.patch.yml` L60-L61）与这些 preset 文件之间是否有写入关系；本票只取证文件本身。

