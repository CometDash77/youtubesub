# 01 — 当前 Harness 环境完整审计（版本 / 组成 / 插件 / 技能 / 会话存储）

本票（#11）为**只读审计**：除本文件与 GitHub 票面外未修改本机任何文件、配置或环境。所有结论给出**文件绝对路径 + 行号**或**命令 + 真实输出片段**；本机做不到的写在 `## 6 未发现 / 无法证实`。

审计时间基准：**2026-09-21**（以会话文件 mtime 与 `dsh-usage` 日期键为准）。

路径别名（下文一律用别名）：

| 别名 | 绝对路径 |
| --- | --- |
| `$APP` | `C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness Desktop\resources\app.asar.unpacked` |
| `$ASAR` | `C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness Desktop\resources\app.asar` |
| `$RES` | `C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness Desktop\resources` |
| `$DSH` | `C:\Users\Administrator\.dsh-community` |
| `$APPROAM` | `C:\Users\Administrator\AppData\Roaming\@linxin666\dsh-desktop` |
| `$AGENTS` | `C:\Users\Administrator\.agents` |

---

## 0 审计口径与方法（可复核）

1. **版本权威出处三层**：安装目录 `$ASAR\package.json`（打包清单）→ `$RES\runtime-support\known-good.json`（随安装器分发的运行时锁）→ `$DSH\profiles\desktop\package.json` / `desktop-plugins.lock.json`（Profile 侧 link 与版本）。旁证材料 `D:\Documents\vibe\_dsh_diag` 来自 4.1.0，**本票未使用**（当前为 4.2.1）。
2. **读 app.asar 内文件的方法**：Electron 的 `fs` 对 asar 透明，`fs.readFileSync('<...>\app.asar\package.json')` 可直接读到；但 `app.asar` **本体**不能按普通文件读（Electron 拦截），且 `grep`/`read` 工具**进不去 asar**（rg 报 `os error 3`）。因此 `$ASAR` 内的引用均由本票在 `run_code` 里用 `fs` 读出并核验。
3. **会话落盘记录的解码方法**：`$DSH\sessions\<encoded-cwd>\<id>\session.v3.jsonl.zstd` 是**多帧 zstd 拼接容器**（每帧一批 JSONL，帧魔数 `0x28B52FFD`）；解码器实现见 `$APP\node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\index.js:1132-1278`（`zstd-private-decoder` / `zstd-public-decoder`，`ZSTD_MAGIC = 4247762216` 在 `:1287`）。Node 24 的 `zlib.zstdDecompressSync` 只解**第一帧**，必须按魔数切帧逐帧解。本票共解码本机 **33 个 session**，下文 tools/prompt/token 统计都来自这里。
4. **运行本票 `run_code` 的进程**：`process.versions` = `electron 43.4.0 / node 24.18.1 / chrome 150.0.7871.224`，即 PTC runtime 子进程用 **Electron 二进制以 `ELECTRON_RUN_AS_NODE` 方式**运行（`$APP\node_modules\@deepseek-ai\dsh-ptc-runtime-node\lib\index.js:794` `nodeExecutable: config.nodeExecutable ?? process.execPath`）。

---

## 1 Harness 状态

### 1.1 版本号（权威出处）

| 项 | 值 | 出处 |
| --- | --- | --- |
| 桌面壳包名 / 版本 | `@linxin666/dsh-desktop` **4.2.1** | `$ASAR\package.json`（`"name": "@linxin666/dsh-desktop", "version": "4.2.1"`） |
| 桌面版本（随包锁） | **4.2.1** | `$RES\runtime-support\known-good.json:13`（`"version": "4.2.1"`）、`:14` rootVersion |
| 官方运行时包 | `@deepseek-ai/dsh` **0.1.6-alpha.2** | `$RES\runtime-support\known-good.json:19-21`（含 `integrity: sha512-PHR/3ZHpJNWXlDQ3U9weFb7calWbSMJd2GD3z2iPJ8zAKL7ipuzyPy5xGbaXf2OA8hc0SAGJeoUW7nfatCNOYw==`） |
| 官方运行时包版本（逐包实测） | 全部 `0.1.6-alpha.2` | `$DSH\profiles\desktop\desktop-plugins.lock.json` 每项 `version` 字段；`$DSH\profiles\desktop\package.json:5-24` 为 `link:` 指向 `$APP\node_modules\@deepseek-ai\…` |
| 支持矩阵 | `desktopRange: "=4.2.1"`、`upstreamVersion 0.1.6-alpha.2`、`verifiedAt 2026-09-18` | `$RES\runtime-support\supported-runtimes.json`（`entries[0]`） |
| provider | `dsh-cli-provider-v1`，`supportStatus: supported` | `$RES\runtime-support\known-good.json`（`provider` 段） |

版本运行时行为的权威解算：`$ASAR\src\app-version.mjs:11-16` —— 打包态直接取 Electron `appVersion`（即 4.2.1），开发态才读 manifest。

### 1.2 安装方式与更新通道

- **安装器**：electron-builder 生成的 Windows NSIS 安装包，落地到 `%LOCALAPPDATA%\Programs\DeepSeek Harness Desktop`，目录内含 `Uninstall DeepSeek Harness Desktop.exe`（实测目录清单）。**不是** `npm i -g`、不是源码构建（安装目录没有可写的源码树，只有 `resources\app.asar` + `app.asar.unpacked\node_modules`）。
- **更新通道**：`$RES\app-update.yml`（全文）：`owner: ningbainb`、`repo: deepseek-harness-desktop`、`provider: github`、`channel: latest`、`updaterCacheDirName: '@linxin666dsh-desktop-updater'`。即 **GitHub Releases 自更新**（依赖 `electron-updater`，见 `$ASAR\package.json` 依赖表）。
- 安装器内嵌协议位：`$RES\installer-upgrade-v3` = `dsh-desktop-installer-upgrade=3`；`$RES\update-shutdown-v1|v2`（升级停机交接协议版本）。
- 分发身份（产品名 / appId / 协议 / 默认 home 目录名）：`$ASAR\src\distribution-identity.mjs:1-18` —— `appId com.ningbainb.deepseek-harness.desktop`、`productName 'DeepSeek Harness Desktop'`、`profile 'desktop'`、`protocol 'dsh-community'`（legacy `dsh`）、`defaultHomeDirectoryName '.dsh-community'`、`updateProvider.owner 'ningbainb'`。

### 1.3 运行中的 Host / Runtime 组成（实测进程树）

实测命令：`Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness Desktop.exe'" | Select ProcessId,ParentProcessId,CommandLine`。

1. **Electron 桌面壳（Host/GUI）**：PID 7300（主进程，无附加参数）+ `--type=gpu-process`、`--type=utility --utility-sub-type=network.mojom.NetworkService`、`--type=renderer`（`--app-path="…\resources\app.asar"`，`--standard-schemes=dsh-runtime`）。用户数据目录 `--user-data-dir="C:\Users\Administrator\AppData\Roaming\@linxin666\dsh-desktop"`。
2. **DSH Runtime 子进程（真正的 dsh Host）**：PID 14668，父 10528，命令行逐字为：

   ```
   "…\DeepSeek Harness Desktop.exe" --expose-internals
     --require "…\resources\app.asar\src\windows-console-preload.cjs"
     "…\resources\app.asar\src\runtime-launcher.mjs"
     --dsh-cli "…\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh\lib\bin.js"
     --profile desktop
     --patch C:\Users\Administrator\AppData\Roaming\@linxin666\dsh-desktop\runtime-overlays\primary-full-user.yml
     --patch "…\resources\runtime-support\desktop-pipe.patch.yml"
   ```

   即：**同一套 Electron 二进制跑两个角色**（`ELECTRON_RUN_AS_NODE` 式），Runtime 通过 OS 私有管道（`$RES\runtime-support\desktop-pipe.patch.yml` 关掉 `web-startup`/`webserver`/`web-runtime`，插入 `@linxin666\dsh-desktop-pipe-webserver`）与壳通信。
3. **Runtime 的 MCP 子进程**：**8 个** `@playwright\mcp\cli.js --browser chromium --isolated --executable-path "…msedge.exe"`，父进程均为 14668（同一 Runtime）。这 8 个进程是 `mcp__playwright-mcp__*` 这 24 个工具的来源，见 §3。
4. **会话命令执行链**：每次 `pwsh` 工具调用会再起 `@deepseek-ai\dsh-subprocess-local\lib\runner.js` + `powershell.exe`（实测 PID 11132/16112），属 `subprocess` 服务而非新 Host。
5. **启动日志**：`$APPROAM\logs\runtime.log`（1092 行）：`[startup] package-resolution=100ms packages=57`、`[runtime] immutable baseline ready packages=119 fingerprint=8101e21f5e28`、`[startup] profile-ready=578ms packages=57 mode=full`、`[startup] runtime-ready=14467ms`、`[plugins] compatibility diagnostic ready=20ms incompatible=0 unknown=0 unavailable=0`；同日志还能看到一次失败回滚 `[plugin-tx:…] operation=plugin-install phase=ROLLED_BACK`。

### 1.4 Profile 与 Agent 配置

- **DSH_HOME** = `$DSH`（`.dsh-community`）。目录实测：`.agent-presets`、`attachments`、`community`、`dsh-session-archive`、`dsh-usage`、`memory`、`profiles`、`sessions`、`skin-center`、`state`、`storages`、`user-scope`、`worktrees` + `settings.yaml` 等。
- **Profile 根 composition 为空**：`$DSH\profiles\desktop\cordis.yml` 全文 2 行 —— `# Electron-owned DSH profile root; composition is supplied as patch layers.` + `[]`。也就是说**组合完全由 patch 层供给**（layer 顺序 = 安装包内的 bundle patch → Profile `cordis.patch.yml` → Runtime 命令行 `--patch`：先 `primary-full-user.yml`，后 `desktop-pipe.patch.yml`）。layer 语义出处：`$APP\node_modules\@deepseek-ai\dsh-base\cordis.patch.yml:1-13`（「applied as ONE insert over the empty profile root. Later bundle patches and the user's profile cordis.patch.yml address these rows by id, with the last write winning per row」）。
- **桌面管理的 Profile 层**：`$DSH\profiles\desktop\cordis.patch.yml:1` 首行 `# --- dsh-desktop managed (auto-generated; do not edit) ---`；共 107 行，内容包含逐行 `disabled: true` 的官方 web-ui 行 + `insert` 社区行（例：`:12-19` 关掉 `web-ui-task-board`/`web-ui-git-graph`/`web-ui-pet`/`web-ui-ssh`；`:20-48` 插入 `@linxin666\dsh-client-ui-task-board`、`@linxin666\dsh-ssh`、`@ningbainb\dsh-memory`、`@ningbainb\dsh-personal-prompt`、`@ningbainb\dsh-user-scope` 等；`:87-96` 插入 `desktop-browser-provider = @deepseek-ai\dsh-experimental-browser-use-playwright-mcp`，`mode: launch`、`headless: false`、`executablePath: …msedge.exe`）。
- **用户层（Runtime 命令行 `--patch`）**：`$APPROAM\runtime-overlays\primary-full-user.yml`（11 行，全文）：

  ```yaml
  - id: sandbox-policy
    name: '@deepseek-ai/dsh-sandbox-policy'
    disabled: false
    config:
      mode: danger-full-access
  - id: approval
    name: '@deepseek-ai/dsh-user-approval'
    disabled: false
    config:
      policy: never
  ```

  与运行时现场一致：每个 session 的第 2~4 条记录都是 `permission/preset = danger-full-access`、`sandbox/mode = danger-full-access`、`approval/policy = never`。
- **Profile 依赖清单**：`$DSH\profiles\desktop\package.json` 87 行、全部 `link:` 指向 `$APP\node_modules\…`；`desktop-plugins.lock.json`（schemaVersion + `plugins`，**60 项**）每项形如 `{"name":"@deepseek-ai/dsh-agent","requested":"link:…","version":"0.1.6-alpha.2","managedByDesktop":true,"bundled":true,"enabled":true,"compatibility":{"status":"compatible","reasons":[]}}`。
- **Agent 配置（settings.yaml）**：`$DSH\settings.yaml` 共 86 行，关键行：`:9-10` `agent-presets.default: ptc`；`:27-58` `llm-pi-ai.providers.command`（baseURL `https://api.commandcode.ai/provider/v1`，模型 `deepseek/deepseek-v4.1-flash` contextWindow 500000、`z-ai/glm-5.3-flash` 1048576 等）；`:59-72` `model-preferences`（pinned `command/deepseek/deepseek-v4.1-flash`，disabledProviders 含 `openai-codex`）；`:77-79` `agent-default-model`；`:80-85` `subagent-model-selection` 白名单只有 2 个模型；`:13-21` `value-mode.enabled: true`（expert `deepseek/deepseek-v4.1-flash`、executor `z-ai/glm-5.3-flash`）；`:22-23` `memory.enabled: true`。
- **其它 preset 目录**：`$DSH\.agent-presets` 只有 `liangshen`、`value-mode`（用户/插件自带的两个）；官方 preset 在安装包内 `$APP\node_modules\@deepseek-ai\dsh-agent-presets\presets\{minimal,standard,ptc,cordis}`。

### 1.5 当前 agent 用的 preset

**`ptc`**，三处独立证据：

1. `$DSH\settings.yaml:9-10` `agent-presets: default: ptc`。
2. **33/33** 个落盘 session 的首条记录都带 `"agentPreset":"ptc"`（逐 session 解第一帧统计，分布 `{"ptc":33}`），例：`$DSH\sessions\--D-Documents-vibe-youtubesub--\session-de059c2d-…\session.v3.jsonl.zstd` 第 1 行 `{"type":"session","version":3,…,"agentPreset":"ptc"}`。**本机从未出现其它 preset 的 session（含 native 展示模式的 session，见 §3.3）**。
3. preset 本体：`$APP\node_modules\@deepseek-ai\dsh-agent-presets\presets\ptc\agent.cordis.yml`，其 presentation 行在 `:277-280`：`- id: tool-presentation / name: '@deepseek-ai/dsh-agent-tool-presentation' / config: mode: ptc`。同文件 `:145-163` 是 compaction 段（`compaction-basic` + `command-compact` + `tool-result-pruner`，`thresholdChars: 8192 / headChars: 4096 / tailChars: 1024`）；`:91-95` 是 `skill-filesystem` + `tool-skill`。

---

## 2 文件结构：各类实体落在哪

| 类别 | 落点（实测） | 说明 |
| --- | --- | --- |
| **packages（官方运行时）** | `$ASAR\node_modules\@deepseek-ai\…`（打包进 asar）+ `$APP\node_modules\@deepseek-ai\…`（**270 个**包目录） | `$ASAR\package.json` 声明 **140** 个依赖，其中 `@deepseek-ai/*` 103 个、其它 37 个（`electron-updater`、`koffi`、`node-pty`、`ssh2`、`ws`、`yaml`、`pnpm`、`semver`、`@xterm/*`、`fflate` 等）。原生/需解包的部分在 `app.asar.unpacked`。 |
| **packages（社区插件）** | `$APP\node_modules\@linxin666\*`（34 个）、`@ningbainb\*`（4 个）、`@tencent-connect\*`、`dsh-better-sidebar`、`reasoning-slider` | 例：`@linxin666\dsh-web-all`（聚合包，自带 `cordis.patch.yml`，162 行）、`@linxin666\dsh-ssh`、`@linxin666\dsh-client-ui-task-board`、`@ningbainb\dsh-memory`。 |
| **plugins（装配面）** | Profile 侧 `$DSH\profiles\desktop\{cordis.patch.yml, package.json, desktop-plugins.lock.json, .dsh-desktop-links.json}`；每个插件包自带 `cordis.patch.yml`（实测 54 个 `cordis*.yml` 位于 `$APP\node_modules`）；Runtime 侧 `--patch` 两枚 | 装载方式是**声明式 cordis 组合**，不是目录扫描：`--profile desktop` 解析 Profile 后按 id 覆盖/插入行。可用插件清单（60 项）见 lock 文件；其中 `enabled: true` 43 项、`managedByDesktop: true` 58 项、**用户自装 2 项**：`@wenaixi/dsh-superpower`（`compatibility.status = "incompatible"`，peer 缺 `@deepseek-ai/cordis ^4.0.1` / `@deepseek-ai/dsh-skill` / `@deepseek-ai/schemastery ^3.18.1`）与 `dsh-mattpocock-skills-deck`（`unknown: compatibility-undeclared`）。**注意**：lock 的 `enabled` 是插件管理器视角，实际生效以 patch 层为准（例：lock 里 `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` 是 `enabled: false`，但 `cordis.patch.yml:87-96` 用新行 id `desktop-browser-provider` 把它打开了，现场确有 8 个 playwright MCP 子进程）。 |
| **skills** | 运行时发现根（源码）：`<projectRoot>/.dsh/skills`、`<projectRoot>/.agents/skills`、custom dirs、`<DSH_HOME>/skills`、`<agentsHome>/skills`、bundled dir | `$APP\node_modules\@deepseek-ai\dsh-skill-filesystem\lib\index.js:150-188`。本机实测：**只有** `$AGENTS\skills` 存在，**32 个目录**（`.dsh/skills`、`<项目>/.agents/skills`、`$DSH\skills` 三者均不存在）。 |
| **runtime** | 壳：`$ASAR\src\*.mjs`（Electron 主进程，约 130 个模块）；Runtime：`$ASAR\src\runtime-launcher.mjs` 引导 `$APP\node_modules\@deepseek-ai\dsh\lib\bin.js`；PTC 执行器：`$APP\node_modules\@deepseek-ai\dsh-ptc-runtime-node\lib\{index.js,process.js}`；支持矩阵 `$RES\runtime-support\*` | 见 §1.3 进程树。 |
| **configuration** | `$DSH\settings.yaml`、`$DSH\profiles\desktop\{cordis.yml, cordis.patch.yml, package.json, pnpm-lock.yaml}`、`$APPROAM\runtime-overlays\primary-full-user.yml`、`$RES\runtime-support\desktop-pipe.patch.yml`、`$APPROAM\Preferences`（Electron）、`$DSH\user-scope\{principal.json,ownership.json}` | 配置分三层：应用默认 → Profile 层 → 用户 overlay（`--patch` 最后写赢）。 |
| **storage** | `$DSH\storages\{workspace.json, session_projcache\sessions\*.json}`（每 session 13~47 KB 投影缓存）、`$DSH\state\{external-conversation-imports-v2.json (562 185 B), live-stats\}`、`$DSH\dsh-usage\{usage-ledger.json, provider-snapshots.json}`、`$DSH\memory\<principalId>\`（**空**）、`$DSH\attachments\v1\`、`$DSH\worktrees\registry.json`（3 B，空）、`$DSH\dsh-session-archive\{archive-ledger.json,state.json}` | `session_projcache` 是本机唯一的“缓存/索引”实体，不是向量库。 |
| **session** | `$DSH\sessions\<encoded-cwd>\<session-id>\session.v3.jsonl.zstd`；本机 3 个项目目录、**33 个 session** | 编码规则：cwd 的 `\`/`:` 换成 `-`（例 `D:\Documents\vibe\youtubesub` → `--D-Documents-vibe-youtubesub--`）。持久化实现 `@deepseek-ai/dsh-session-persistence-jsonl`。另有归档目录 `$DSH\dsh-session-archive`。 |

### 2.1 架构判定：**第三方（社区）封装桌面版「DSH Desktop」，内核是未改动的官方 `@deepseek-ai/dsh` 运行时**

依据（每条可复核）：

1. **壳与内核分离、壳是第三方作品**：`$ASAR\package.json` —— `name: @linxin666/dsh-desktop`、`description: "Lossless desktop shell for DeepSeek Harness and the complete dsh-web-ui plugin collection"`、`homepage: https://github.com/ningbainb/deepseek-harness-desktop`、`author: "ningbai牛逼"`、`desktopName: com.ningbainb.deepseek-harness.desktop`。更新通道亦指向同一第三方仓库（`$RES\app-update.yml`）。
2. **内核是官方包、且带完整性锁**：运行时入口就是官方 `@deepseek-ai\dsh\lib\bin.js`（进程命令行），版本 0.1.6-alpha.2 与 `known-good.json:19-25` 的 `integrity` + 文件 sha256 一致；官方包**没有被改写**（第 3 点说明兼容性修改走运行时 patch，而不是改包内文件）。
3. **兼容性修改走“运行时补丁注册表”而非改源码**：`known-good.json` 的 `compatPatches.registry = packages/dsh-desktop-compat/src/patch-registry.ts`（sha256 固定），补丁 id 共 7 个：`cancellation-presentation`、`desktop-skin-profile-isolation`、`queued-turn-continuation`、`session-startup-corruption`、`tool-call-arguments-envelope`、`tools-capability-request-side`、`transcript-tool-call-balance`。**它不是用户自建 Fork 的源码树构建**：安装目录只有 asar/unpacked 产物，没有 `apps/dsh-desktop`、`packages/`、`pnpm-lock.yaml` 源仓（那些路径只出现在 known-good.json 的 `authority` 字段里作为上游仓库坐标）。
4. **社区化靠 Profile 而不是靠改内核**：DSH_HOME 名为 `.dsh-community`、深链协议 `dsh-community`（`distribution-identity.mjs:10-12`），社区插件全部以 npm 包 + `cordis.patch.yml` 装配（§2 表）。
5. **一句话结论**：**不是**原生官方 DSH 发行版（安装器与更新通道、包名、appId、作者均非 DeepSeek 官方）；**是** DSH Desktop（第三方社区封装版，包名 `@linxin666/dsh-desktop`，维护者 ningbainb），内核为原样官方 `@deepseek-ai/dsh 0.1.6-alpha.2` + 运行时补丁 + 社区插件 Profile。**不是**用户自建的开源 Fork 源码工程。

### 2.2 本机历史上的一次“内核外手工改动”，当前已被覆盖

- 证据（会话记录，真实存在）：`$DSH\sessions\--D-Documents-~7535~5546WORKWORK--\session-439c4780-70f6-4fce-93cd-45e052460529\session.v3.jsonl.zstd` 的 `user/message seq9`（同文见 `agent/inbox/spliced seq4`）原文：`已完成补丁写入：…\app.asar.unpacked\node_modules\@deepseek-ai\dsh-ptc-runtime-node\lib\index.js … + if (typeof process.versions.electron === "string" && executable.toLowerCase() === process.execPath.toLowerCase()) env.ELECTRON_RUN_AS_NODE = "1"; … 未来 DSH 更新可能覆盖此补丁。` 该 session `createdAt` = **2026-09-18T01:48:59Z**。
- 当前状态：`grep "process\.execPath\.toLowerCase"` 在 `$APP\node_modules` 全树 **0 命中**；`dsh-ptc-runtime-node\lib\index.js` 只在 `:956` 出现 `ELECTRON_RUN_AS_NODE`，语义是**从子进程环境里剔除**它（原始官方行为）。`$APP\node_modules\@deepseek-ai` 下 **270 个包目录 mtime 全部为 2026-09-21T00:55:45~00:55:59Z**，晚于补丁时间 → **该手工补丁已被 4.2.1 安装覆盖，本机现存运行时无此改动**。

---

## 3 Tool System

### 3.1 注册表与 schema 来源

- **注册表服务**：`$APP\node_modules\@deepseek-ai\dsh-tools\lib\index.js`（该包 main/exports 指向 `lib/index.js`）。`:2663-2672` `var ToolRuntime = class extends Service { static inject = ["systemPrompt"]; static Config = z.object({ mode: z.union(["native","ptc","both"]).default("native"), maxParallelSubCalls: z.natural().min(1).default(10) }) }`；`:2702` `super(ctx, "tools")` —— 对外服务名 **`tools`**。
- **注册 API**：`:2876-2885` `register(definition)` —— 必须声明 `output: { schema, render, presentationMeta? }`（`:2879` 否则抛 `TypeError`），`parameters` 是 **JSON Schema**（`:2880` `assertSupportedJsonSchema(output.schema)`），`run_code` 名字保留（`:2883` 抛错），返回精确 disposer（`:2884` `this.layers.effect(…, { label: "tools.register()" })`）。同一 layer 内重名直接抛错（`:2634` `new NamedEntries(name => new Error(…already registered…))`）。
- **schema 真实来源 = 每个注册插件的 JS 定义里的 JSON Schema 字面量**，不是从任何配置文件读的。全机 `tools.register(` 调用点共 **79 处 / 44 个包**（`grep 'tools.register(' -g '*.js'`），分布示例：`dsh-experimental-tool-agent-team` 9、`dsh-schedule` 6、`dsh-tool-subagent-control` 5、`dsh-tool-fs` 4、`dsh-tool-jobs`/`dsh-tool-goal`/`dsh-mcp-resources` 各 3、`@tencent-connect/dsh-qqbot`/`@linxin666/dsh-value-mode`/`@linxin666/dsh-tool-describe-image`/`@ningbainb/dsh-memory` 各 2 …；本机 `dsh-tool-*` 包共 20 个（`dsh-tool-ask-user`…`dsh-tools`）。
- **MCP 工具是唯一“外部来源”**：`$APP\node_modules\@deepseek-ai\dsh-mcp-client\lib\index.js:58` 起定义命名规则 `mcp__<serverName>__<rawName>`（`:97` `const joined = `mcp__\${serverName}__\${rawName}``），`:108` 处注释说明它「Fetch: let the SDK aggregate `tools/list` and build the full next …」。本会话的 `mcp__playwright-mcp__browser_*` 24 个工具即来自 `cordis.patch.yml:87-96` 拉起的 `@playwright/mcp` 子进程（§1.3）。
- **模型侧 schema 投影**：`:2705` `ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope))`（native 投影）；`:2706-2709` 当 `defaultMode !== "native"` 时额外注册两个 prompt section：`collapseSection()` = `tools:ptc-only`（`:2726-2732`，正文 `PTC_ONLY_INSTRUCTION` = 「`run_code` is the only tool you can call directly — a tool call naming any other tool fails.」）与 `sdkSection()` = `tools:sdk`（`:2743-2757`，正文 `render(this.sdkSchemas(context.scope))`）。
- **SDK 文本生成器**：`$APP\node_modules\@deepseek-ai\dsh-tools\lib\types\ts-types.js:270-290` `renderToolsSdk(schemas)` —— 先**按名字字典序排序**（`:271`，注释 `:261-264` 明说「Deterministic … so an unchanged tool set produces byte-identical text across assemblies」，为了 prompt cache 稳定），再由 `jsonSchemaToTs` 把每个工具的 `parameters`/`output` 渲染成 `interface ToolArgsMap` / `interface ToolOutputMap`，并附 `declare const tools: { [K in ToolName]: … }`。同一实现的另一产物在 `lib/index.js:1729-1760`。

### 3.2 discovery 与加载生命周期

- **discovery = 声明式组合装载，没有工具目录扫描**：`dsh` Runtime 以 `--profile desktop` 解析 Profile，按 patch 层（`dsh-base/cordis.patch.yml` → 模式 bundle → `$DSH\profiles\desktop\cordis.patch.yml` → `--patch` 两枚）装配行；每行 `name` 指向一个 npm 包，包被 mount 时在 `apply()`/`start()` 里调用 `ctx.tools.register(...)`。MCP 工具则在 MCP client 插件连上 server 后用 `tools/list` 动态生成（§3.1）。
- **生命周期**：注册发生在插件 mount 期（disposer 交给 cordis 作用域，`:2884`）；**作用域分层**：全局 layer + 每个 agent 的 scope layer，scope 注册**遮蔽**全局（`:2871-2872` 注释「Scoped tools shadow globals」）；派生限制 `restrict({allow,deny})`（`:2893-2908`，未知工具名直接抛错）与守卫 `guard()`（`:2919-2924`）；任一变更触发 `tools/change` 事件（`:2689`），供 prompt 与 UI 重算，HMR/卸载由 disposer 精确回收。
- **每次执行的编排**：`TOOL_RUNTIME_SCHEDULER`（`:2674-2679`）由 `dsh-agent-loop` 的并行调度器驱动；PTC 模式下 harness 只把 `run_code` 作为 transport 暴露（`:2773-2796` `requirePtcTransport()`，且 `run_code` 永不进入全局 layer，「per-agent restrictions must not remove it」）。

### 3.3 本机实测：注册了多少个工具、模型实际看到几个

**模型侧**：**永远只有 1 个工具 schema**。本机 33 个 session 共 **49 条 `request/header` 记录，49/49 的 `header.tools` 长度 = 1，名字 = `run_code`**（reason 字段取值为 `initial`/`resume`/`change`，即 header 变化时才落盘）。这和 `PTC_ONLY_INSTRUCTION` 完全一致。

**程序侧（`tools:sdk` 声明的 SDK 绑定数量，即“本会话可用工具数”）**：按 `system/message` 里 `interface ToolArgsMap` 的成员数实测，本机出现过 **5 档**：

| 工具数 | session 数 | system prompt 总字符 | `tools:sdk` 段字符 | 每工具字符 | 典型组成 |
| --- | --- | --- | --- | --- | --- |
| 35 | 8 | 46 394 | 38 704 | 1 106 | 早期/精简 Profile（无 ssh、无 MCP） |
| 40 | 3 | 49 352~49 366 | 39 573 | 989 | 加 `consult_expert`/`list_agents` 等 |
| 41 | 12 | 50 873~51 030 | 41 237~41 545 | 1 006~1 013 | 加 agent-team 工具 |
| **62** | **8** | **53 301** | **45 443** | **733** | **本票所在的 wayfinder 子代理族**（含 24 个 `mcp__playwright-mcp__*`、`ssh_*` 7 个、`job_list`/`list_agents`） |
| 68 | 5 | 57 790 | 48 273 | 710 | 父/主会话（在上者基础上再加 `spawn_teammate`、`team_task_create/get/list/update`、`wait_agent`） |

即：**“注册了多少工具”不是一个固定数**，而是随 Profile 装配 + 是否挂 MCP server 变化的**每会话集合**，本机实测区间 **35~68**；本票这一会话 = **62**（同一 prompt 的 4 个兄弟票 session 也都是 62）。同时 `$ASAR\package.json` 里可装载的工具来源远多于此（含 20 个 `dsh-tool-*` 包 + agent-team/schedule/qqbot/plugin-manager 等注册点），未装配的行不产生工具。

**实际使用分布**（33 session 的 `tool/ptc-dispatch` 记录共 **2 387** 条；`tool/call` 1 195 条全是 `run_code`）：`read 669`、`pwsh 618`、`edit 311`、`grep 283`、`glob 129`、`write 119`、`web_fetch 116`、`present 32`、`todo_write 20`、`subagent 16`、`ask_user_question 16`、`skill 15`、`job_output 14`、`send_message 12`、`web_search 5`、`describe_image 4`、`job_list`/`list_agents` 各 3、`read_image 2`、`get_goal`/`update_goal` 各 1。**头部长尾极陡**：前 6 个工具占 ~72% 调用，24 个 MCP 工具本机 0 次调用。

### 3.4 10 / 100 / 1000 个工具三档会怎样（基于机制，非空谈）

前提：本机全部 session 都是 `mode: ptc`（`presentAs("ptc")`，`agent.cordis.yml:277-280`），所以“N 个工具”对模型的影响只走 `tools:sdk` 文本，而 **provider 侧 schema 恒为 1 个 `run_code`**（§3.3 的 49/49 证据）。

1. **10 个工具**：`tools:sdk` ≈ **7~11 KB**（按实测 710~1 106 字符/工具），系统提示 ≈ 12~16 KB，约 3~4k tokens。对 500k 窗口（`settings.yaml:44-46`）可忽略；PTC 的程序化调用收益（多步合成一次往返，见 `agent.cordis.yml:1-11` 的设计注释）远大于提示开销。**注册表侧**仍要注意重名即抛错（`:2634`）与 `run_code` 保留名（`:2883`）。
2. **100 个工具**：`tools:sdk` ≈ **71~111 KB**（≈18~28k tokens），系统提示整体 ≈ 80~120 KB。效果：单次请求固定前缀涨到 20k+ tokens，但因为是**字典序确定性渲染**（`ts-types.js:261-271`），前缀可被 provider prompt cache 命中——本机实测缓存确实在扛这个量（`$DSH\dsh-usage\usage-ledger.json` 2026-09-21：`deepseek/deepseek-v4.1-flash` `inputTokens 1 844 147` vs `cacheReadTokens 70 650 112`，`calls 850`；`cacheWriteTokens` 恒为 0）。风险点从“token 成本”转向**可发现性**：模型必须在 100 个名字里正确选型并写出 TS 调用；本机实测 62 工具时头部 6 个工具吃掉 72% 调用、24 个 MCP 工具 0 调用，是这一风险的先兆。**执行侧**：每次子调用都是一次 `tool/ptc-dispatch`（本机 2 387 次），且 `run_code` 在**全新 Node 进程**里跑（`dsh-ptc-runtime-node\lib\index.js:783-785`：`isolation = "process"`、`get executionInstructions() { return "Each call runs in a fresh Node process…" }`），并发上限 `maxParallelSubCalls = 10`（`:2655`）。
3. **1000 个工具**：`tools:sdk` ≈ **0.71~1.11 M 字符 ≈ 175~275k tokens**，占 500k 窗口的 **35%~55%**（`settings.yaml:44-46`），且这是**每请求固定前缀**——在长任务里必然与历史（本机已观测到单步 input 182 120、累计 239 244）叠加，逼近/触发 compaction（默认 `thresholdRatio 0.8` ⇒ 400k 触发，见 §5）。同时：
   - **冲突面**：1000 个扁平名字在同一 layer 注册几乎必然重名 → `register` 直接抛错；唯一可扩展路径是命名空间前缀（MCP 的 `mcp__server__tool` 就是这个设计，`dsh-mcp-client\lib\index.js:58,97`）。
   - **外部进程面**：本机 62 工具时就已并发 8 个 `@playwright/mcp` 子进程；工具数线性增长通常伴随 MCP server 数增长，进程/内存会成为比 token 更早的瓶颈。
   - **缓存面**：一旦某个 MCP server 后连上，`tools:sdk` 文本变化 → 前缀缓存失效重建（这正是排序确定性要保护的东西，`ts-types.js:261-264`）。
   - 结论：**10 档无压力；100 档可行但可发现性与缓存前缀成本成为主要风险；1000 档不可行**——不是 provider 端 schema 爆炸（恒定 1 个），而是 system prompt 被 SDK 文本吃掉 1/3 以上窗口，以及注册/进程/缓存三类放大问题。

---

## 4 Skill System

### 4.1 注册方式与 discovery

- **服务**：`@deepseek-ai/dsh-skill` 存在（`$APP\node_modules\@deepseek-ai\dsh-skill`），提供者以 `ctx.skills.registerProvider(...)` 注册 —— 见 `$APP\node_modules\@deepseek-ai\dsh-skill-filesystem\lib\index.js:45-56`（注释 `/** Register the local filesystem skill provider on ctx.skills. */`）。
- **发现根（源码权威）**：`dsh-skill-filesystem\lib\index.js:150-188`，按 rank 依次是 `<projectRoot>/.dsh/skills`（project-dsh）、`<projectRoot>/.agents/skills`（project-agents）、`config.customSkillDirs`（custom）、`<DSH_HOME>/skills`（user-dsh，`skipSystem: true`）、`<agentsHome>/skills`（user-agents）、`bundledSkillDir`（bundled）。扫描规则是「一层目录：`<name>/SKILL.md` 或 `<name>.md`」（web 侧实现见 `@linxin666\dsh-web-all` 的 `scanSkillRoot`，注释 `* Scan one skill root (one level: <name>/SKILL.md or <name>.md)`）。
- **本机实测**：`$AGENTS\skills` 有 **32 个目录**（与本票给的已知事实一致，例 `ask-matt`、`code-review`、`superpower-*` 系列、`weread-skills` 等）；项目级 `.dsh/skills`、`<cwd>/.agents/skills`、`$DSH\skills` **均不存在**（`fs.readdirSync` ENOENT）。所以本机目录 = **32 个 user-agents 技能**。
- **模型侧的“目录”不是 system prompt 段，而是注入的 user 消息**：`@deepseek-ai\dsh-tool-skill\lib\index.js:246-273` 生成 `<available_skills>…</available_skills>`；实测它落在会话的 **`user/message`** 记录里，形如 `<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n\n<available_skills>…` —— 例 `$DSH\sessions\--D-Documents-vibe-youtubesub--\session-de059c2d-…\session.v3.jsonl.zstd` 的 `user/message seq12`。**33 个 session 里 32 个含且仅含 1 次**该注入（长度 6 734~9 075 字符，合计 221 633 字符），本票执行时正在写入的父 session 尚未落盘故未计入。

### 4.2 是否有 router

**未发现任何 router / 自动匹配 / 向量召回 / 规则路由**。证据：

- `skill` 工具的形参只有一个 `name`（`dsh-tool-skill\lib\index.js:60-65`：`name: "skill"`，`description: "Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill."`，`parameters: { name: { … "The exact skill name from the available skills list." } }`），执行路径是 `ctx.skills.list(lookup).find(s => s.name === args.name)` 精确命中（`:145-148`）。
- 目录本身是一份**扁平摘要清单**（名称 + 一行 description），选择权完全在模型；本机 `skill` 工具实际调用 15 次（`tool/ptc-dispatch` 统计）。
- `dsh-skill-filesystem` 里的 `rank`（`:154-186` 各根的 rank 常量）是**同名技能的优先级/遮蔽规则**（多 provider 合并时的冲突解决），不是任务路由。

### 4.3 加载、生命周期、动态装卸与按任务加载

- **动态发现**：`dsh-skill-filesystem` 配置 `watch: z.boolean().default(true)`、`watchUsePolling`、`watchStabilityThresholdMs`、`watchPollIntervalMs`、`watchMaxProjects: 128`、`watchFollowSymlinks`（`:26-42`），由 `SkillWatchManager`（`:191+`）持有 host watcher，文件变化时调 `control.invalidate`。⇒ **新增/删除/修改 `SKILL.md` 无需重启 Runtime**（本机 `watch` 取默认 true，未在 patch 层覆盖）。
- **按任务加载**：目录只给摘要；正文在模型调用 `skill` 工具时才通过 `ctx.skills.get(name, lookup)` 读出（`dsh-tool-skill\lib\index.js:181`），即**按需加载**（本票开头就是这样拿到 `skill` 内容）。
- **卸载/启停**：provider 以 cordis 注册、返回 disposer（`:45-56` 的 `apply` 返回 disposer 链）；**未发现**按技能名的 enable/disable 配置项（`skill` 工具的 schema 里没有该字段，patch 层也没有相关键）——启停只能靠增删文件或整体装卸 `dsh-skill-filesystem`/`tool-skill` 行。UI 侧有 `@linxin666\dsh-client-ui-skill-explorer`（`cordis.patch.yml` 里的 `web-ui-skill-explorer`，默认 `disabled: true`）做 SKILL.md 的读写管理。
- **一个可观测缺口**：目录以 user 消息形式在**会话开始注入一次**（§4.1 的 32/33 各 1 次）。因此会话中途新增的技能，对 `skill` 工具（watcher 已刷新 provider）可见，但**模型手里的目录快照可能过期**（本机 33 个 session 中未发现同一会话内重复注入目录的记录）。

---

## 5 Context System

### 5.1 实体与配置

| 实体 | 落点/实现 | 关键配置 |
| --- | --- | --- |
| **session** | `$DSH\sessions\<encoded-cwd>\<id>\session.v3.jsonl.zstd`；实现 `@deepseek-ai\dsh-session` + `dsh-session-persistence-jsonl`（多帧 zstd 容器，解码器 `lib/index.js:1132-1278`，魔数 `:1287`） | 首记录 `{type:"session",version:3,cwd,isSeeded,delegationDepth,agentPreset}`；本机 33 个 |
| **history** | 就是同一 JSONL 记录流（无独立 history 库）；实测记录类型 33 种：`turn/start`、`step/start`、`system/message`、`user/message`、`request/header`、`request/context`、`assistant/message`、`tool/call`、`tool/ptc-dispatch(-start)`、`tool/result`、`llm/retry(-started)`、`assistant/attempt`、`agent/inbox/spliced`、`subagent/{descriptor,catalog}`、`workspace/changes`、`todo/write`、`goal/change`、`command/{run,done}`、`session/{title,end-seed}` 等 | 全机统计：`assistant/message` 1 262、`tool/result` 1 194、`step/start` 1 277、`tool/ptc-dispatch` 2 387 |
| **context window** | 模型声明：`$DSH\settings.yaml:36-58`（`deepseek/deepseek-v4.1-flash` 500 000、`z-ai/glm-5.3-flash` 1 048 576 等）；每请求落盘为 `request/context` 记录 | 实测出现 4 组：`command/deepseek/deepseek-v4.1-flash = 500000`、`command/z-ai/glm-5.3-flash = 1048576`、`command/meta/muse-spark-1.3-contributor = 1048576`、`deepseek-official/deepseek-flash = 1000000` |
| **cache** | ① provider 前缀缓存：`assistant/message.usage.{inputTokens,cacheReadTokens,cacheWriteTokens}` + 聚合 `$DSH\dsh-usage\usage-ledger.json`；② DSH 侧投影缓存 `$DSH\storages\session_projcache\sessions\<id>.json`（13~47 KB/会话） | `cacheWriteTokens` 本机恒为 0（该 provider 不单独计写） |
| **memory** | `@ningbainb\dsh-memory` 注册 `memory` 工具 + systemPrompt section `dsh:memory` + 变量 `dsh_memory`（`lib/index.js:1101`、`:1648-1653`、`:1659`）；存储 `$DSH\memory\<principalId>\` | `settings.yaml:22-23` `memory.enabled: true`；**当前存储目录 0 个子项 ⇒ 今天 memory 对上下文零贡献** |
| **retrieval** | **未发现**向量库/embedding/检索包进入 agent 路径；最接近的是 (a) 技能目录（§4）(b) memory 的 search（`memory` 工具 operation=search）(c) MCP resources 列表 | — |
| **compaction** | `@deepseek-ai\dsh-compaction`、`dsh-compaction-basic`、`dsh-command-compact`、`dsh-compaction-tool-result-pruner`、`dsh-compaction-image-offload`；ptc preset 行 `agent.cordis.yml:145-163` | `compaction-basic` 默认 `DEFAULT_THRESHOLD_RATIO = 0.8`、`DEFAULT_RETAIN_RATIO = 0.16`、`auto ?? true`（`dsh-compaction-basic\lib\index.js:15,17,76`）；pruner `thresholdChars 8192 / headChars 4096 / tailChars 1024`（preset `:161-163`） |

### 5.2 实测压力与缓存行为

- **单步输入峰值**：**182 120** tokens（session `session-dab83ba1-…`），累计 `totalTokens` 峰值 **239 244**；对 500k 窗口 = **36% / 48%**。
- **33 会话合计**：`assistant/message` 有 usage 的 1 317 条，`ΣinputTokens = 3 626 782`，`ΣcacheReadTokens = 116 003 254`（缓存读取量是新增输入量的 **32 倍**，说明长前缀几乎全部由缓存承担）。
- **按 provider 日聚合**（`$DSH\dsh-usage\usage-ledger.json`）：2026-09-18 `deepseek/deepseek-v4.1-flash` input 173 992 / output 249 775 / cacheRead 6 243 200 / calls 94；2026-09-19 input 432 235 / cacheRead 20 898 816 / calls 208；2026-09-21 input 1 844 147 / output 1 157 829 / cacheRead 70 650 112 / calls 850。`$DSH\dsh-usage\provider-snapshots.json` 里 `deepseek-official` 余额 `CNY 45.81`（`balanceError: "The operation was aborted due to timeout"`）。
- **compaction 从未触发**：对全部 33 个 session 的完整解码文本做键名扫描，**任何含 `compact` 的记录类型或字段 = 0 命中**；最大上下文 239k 也远低于默认 400k（0.8×500k）触发线。⇒ 本机全部长会话都是「单调增长型」。

### 5.3 无效重复注入 / tool result 污染 / 长任务膨胀

1. **前缀占比失衡（设计使然，但值得记账）**：系统提示 46.4~57.8 KB 中，`tools:sdk` 段占 **38.7~48.3 KB（79%~84%）**，即「工具说明书」是提示的绝对主体（§3.3 表）。这是 PTC 模式的代价，换来的是 provider 侧恒 1 个 schema 与多步合成。
2. **未发现逐轮重复注入**：
   - 技能目录 32/33 会话各注入 **1 次**（6 734~9 075 字符），非每轮；
   - 工作区指令（`AGENTS.md`）也是以 `user/message` 的 `<system-reminder>` 注入 **1 次**（实测 `session-439c4780` 的 `seq10` = 14 247 字符；本仓库 youtubesub 场景 = 742 字符），同 session 的 `seq11` 是「Current runtime context」快照（390 字符）；
   - `system/message` 每会话 1 条（个别 2~4 条，`session-deeded38` 4 条）——即系统提示在会话内**基本只组装一次**，且内容按 `request/header.reason`（initial/resume/change）跟踪变化。**未发现同一内容在相邻轮次被重复塞入的记录。**
3. **tool result 污染**：33 会话共 **1 194** 条 `tool/result`；唯一的治理是 `tool-result-pruner` 对**单条 >8192 字符**的结果做首 4096 + 尾 1024 的裁切（preset `:158-163`）。**未发现**历史级淘汰/摘要式回收——因为 compaction 从未触发（§5.2），所有历史结果实际都留在上下文里。本机直接证据：会话 `totalTokens` 随步数单调上升（`session-dab83ba1` 同一序列 16 818 → 17 639 → 30 044 → … → 239 244）；单会话历史体量（`user/message` + `tool/result` + 助手内容字符和）已达 0.65~4.67 M 字符。
4. **长任务上下文膨胀的真实天花板**：默认 compaction 线 0.8×窗口（500k → 400k）。按本机已观测的 239k/会话且仍在增长的趋势，**同一会话继续跑下去必然触发 `compaction-basic`**；触发后按 `retainRatio 0.16` 保留（约 80k）并做摘要（summarization provider/model 未在 preset 里显式配置，走默认解析）。**注意**：本条是根据源码默认值 + 未触发事实的推断，本机没有 compaction 实际执行的记录可核（见 §6）。
5. **重试放大**：全机 `llm/retry` 49 条 / `llm/retry-started` 49 条 / `assistant/attempt` 56 条（`cordis.patch.yml:71-86` 给 `llm-deepseek` 配了 `maxRetries 4`、退避 750ms→15s、jitter 0.15）；重试不是重复注入（同一前缀由缓存吸收），但会重复计费与重复落盘 `assistant/attempt`。
6. **磁盘重复**：每个 session 各存一份完整系统提示（46~58 KB），33 个会话 ≈ **1.7 MB** 纯提示副本；这是存储重复，不是上下文重复。

---

## 6 未发现 / 无法证实

1. **未发现**原生官方发行标识：安装器、更新通道、包名、appId、作者均指向第三方（ningbainb / `@linxin666/dsh-desktop`）；本机也没有任何源码仓工程（`apps/`、`packages/`、`pnpm-lock.yaml` 在上游坐标里出现，但安装目录不存在）。
2. **未发现**技能 router / 自动路由 / 语义召回的实现；`skill` 工具只接受精确名字。
3. **未发现**技能的按名启停配置（enable/disable、allow/deny 列表）：patch 层、`settings.yaml`、`skill` 工具 schema 里都没有对应键。
4. **未发现** compaction 真实执行过的任何记录（33 个 session 全文 0 命中 `compact`）。§5.3 第 4 条的触发行为只能按源码默认值（0.8/0.16/auto=true）推断，**未能实测**。
5. **未发现**本机存在第二个 Runtime、第二个 Profile 或 native 展示模式的会话：Runtime 只有 1 个（PID 14668），Profile 只有 `desktop`，33/33 session `agentPreset=ptc`。
6. **未发现** `C:\Users\Administrator\.dsh` 目录（不存在），因此 SSH 插件文档里提到的 `~/.dsh/dsh-ssh.json` 在本机**未发现**（本票未进一步追该插件的实际存储位置）。
7. **无法证实**：8 个 `@playwright/mcp` 子进程与「每会话一个」的精确对应关系——只能证实它们**同为 Runtime 14668 的子进程且并发存在 8 个**，无法从进程表断定归属哪一个 session。
8. **无法证实**运行期内存态：例如 §2.2 提到的手工补丁是否曾在某个进程里生效过（同一会话的下文说明「当前 DSH 进程仍加载旧代码」），本票只能核验**磁盘文件现状**（补丁已不存在）。
9. `request/header` 的 `tools` 是落盘的遥测事实（恒 `run_code`），**无法直接观测 provider 请求体的其余部分**（例如逐次 system prompt 是否逐字节相同），因此「未重复注入」的结论以落盘记录与 section 注册代码为据。

---

## 附录 A 复现命令（只读）

```powershell
# 1) 版本（asar 内 package.json；Electron fs 可透明读 asar 内文件）
#    在 run_code 里： fs.readFileSync('<...>\resources\app.asar\package.json','utf8')
# 2) 运行时锁与更新通道
Get-Content '<...>\resources\runtime-support\known-good.json'
Get-Content '<...>\resources\app-update.yml'
# 3) 进程树（Host / Runtime / MCP 子进程，含完整命令行）
Get-CimInstance Win32_Process -Filter "Name = 'DeepSeek Harness Desktop.exe'" |
  Select-Object ProcessId,ParentProcessId,CommandLine | Format-List | Out-String -Width 400
# 4) 会话落盘文件（多帧 zstd）
Get-ChildItem -Recurse "$env:USERPROFILE\.dsh-community\sessions" -Filter session.v3.jsonl.zstd |
  Select-Object FullName,Length,LastWriteTime
# 5) Profile 组成（patch 层）
Get-Content "$env:USERPROFILE\.dsh-community\profiles\desktop\cordis.patch.yml"
Get-Content "$env:APPDATA\@linxin666\dsh-desktop\runtime-overlays\primary-full-user.yml"
# 6) 工具注册点（需在 app.asar.unpacked 实体目录上；rg 进不去 asar）
#    grep 'tools.register(' -g '*.js'  → 79 处 / 44 包
```

（本文件的 stats 全部由本票在 `run_code` 内解码 33 个 session 得到；解码脚本未落盘，方法见 §0。）
