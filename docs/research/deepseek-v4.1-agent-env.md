# DeepSeek-V4.1 官方 agent 环境规范取证（wayfinder #33）

调研日期：2026-09-22。一手来源优先：api-docs.deepseek.com（官方 API 文档）、deepseek.com（官方站点）、github.com/deepseek-ai/deepseek-harness（官方 Harness 仓库），每条结论附 URL；查不到的明确写「未找到官方成文规范」。用户给的起点 https://www.deepseek.com/en/news/deepseek-v4-1-flash/ 已由主会话核实为新闻发布稿、不含 agent 环境规范，本文不再重复取证。

## 结论速览

- **API 文档层：未找到 AGENTS.md 或「agent 应如何维护代码仓库」的成文规范**——对 api-docs 全站 sitemap（https://api-docs.deepseek.com/sitemap.xml ）逐页核对，API Guides 只有 Vision / Thinking Mode / Multi-round / Prefix / FIM / JSON Output / Tool Calls / Files / Context Caching / Responses / Anthropic，外加一页把 DeepSeek 接进 Claude Code、OpenCode、OpenClaw 的集成指南，没有指令文件或 agent 仓库环境专页。
- **Harness 层有成文规范**：官方 DeepSeek Harness（https://www.deepseek.com/harness ，仓库 deepseek-ai/deepseek-harness ）默认启用 `dsh-agent-instructions` 插件，把用户全局与项目的 AGENTS.md/CLAUDE.md 兼容文件作为 workspace guidance 注入——AGENTS.md 在 DeepSeek 生态是官方一等指令载体，而非社区惯例。
- **官方推荐写法**（harness 仓库 docs/AGENTS.md 文档标准）：根 AGENTS.md 只放 standing orders（每条一到三行、链接到事实的家）、子树 AGENTS.md 只放本子树规则、一个事实只有一个家、不放故事和 worked example。
- **DeepSeek-V4.1-Flash（`deepseek-flash`）能力边界**：1M 上下文、最大输出 384K、原生视觉输入（图片仅限 user 消息）、工具调用含 thinking 模式、JSON Output 与 strict 工具 schema、thinking 默认开且 effort 可控（low/high/max，Anthropic 格式 none 关闭）。
- **官方记录的已知弱点**：JSON 模式偶发返回空内容；携带 tools 的多轮请求必须完整回传 reasoning_content 否则 400；thinking 模式忽略 temperature/presence/frequency_penalty 且 top_p 钳到 0.95 以上；FIM 仅非思考模式；Chat Completions API 不支持中途插入 tool 消息。
- **提示词长度**：API 层未找到成文长度建议或硬限制页；Harness 层给出成文预算——注入的 workspace 指令基线默认 65,536 字节、单文件 1,048,576 字节，超预算先整篇丢弃更宽泛的文件、最后才截断最具体的文件，且注入 append-only 以保 KV Cache 前缀稳定。
- **文件引用方式与命令风格由 Harness 系统提示成文规定**（对所有模型通用、非 DeepSeek 专属偏好）：提及文件必须链接到路径并附 #L24 或 :24 行号、用 read 而非 cat、glob 而非 find、grep 而非 rg、检查 [exit code: N] 标记。
- **模型 id：环境文件里写 `deepseek-flash`**；`deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 已退役、仅临时路由到 V4.1-Flash 并按 Flash 价计费；`deepseek-chat`/`deepseek-reasoner` 已于 2026-07-24 停用。
- **与票面已知事实的出入（须向主会话报告）**：现行一手来源不支持「V4-Pro 已路由到 V4.1-Flash 价格」——Models & Pricing 页显示 `deepseek-v4-pro` 仍按 DeepSeek-V4-Pro-0813 独立定价（峰值 $1.32/M 输入，Flash 为 $0.30），2026-09-10 changelog 称 2026-09-14 之后继续提供 V4 Pro API 服务、计费方式不变；「待 V4.1-Pro 替代」未见官方成文，只有「如有变更另行通知」。这不影响「环境文件写 deepseek-flash」的结论。
- **嵌套 AGENTS.md 的发现依赖结构化文件工具触达、不跟 shell cd**——多模型静态核对清单应把「根 AGENTS.md 单独读完即自足」列为通过标准。

## 官方对 AGENTS.md / 指令文件的态度

API 文档（api-docs.deepseek.com）全站未提及 AGENTS.md（sitemap 全表核对，https://api-docs.deepseek.com/sitemap.xml ）；官方对 agent 接入的成文内容是工具集成指南：Integrate with AI Tools 页教用户把 DeepSeek 接进 Claude Code、OpenCode、OpenClaw，配置里直接使用 `deepseek-flash`（Claude Code 主模型还写了 `deepseek-flash[1m]` 变体）并设置 `CLAUDE_CODE_EFFORT_LEVEL=max`（https://api-docs.deepseek.com/guides/coding_agents ）——即官方认可经由第三方 agent 工具维护仓库，而这些工具本身以 AGENTS.md/CLAUDE.md 为指令入口。

DeepSeek Harness 官方仓库是 AGENTS.md 的成文规范所在：

- `dsh-agent-instructions` 包 README（https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md ）：该插件 gives agents workspace guidance from user-global and project-level AGENTS.md-compatible files；`dsh-base` 默认启用、默认预算 65,536 字节；基线候选为 `AGENTS.md` 与 `CLAUDE.md`，本地覆盖层为 `AGENTS.local.md` 与 `CLAUDE.local.md`；用户全局文件为 `$DSH_HOME/AGENTS.md`（默认 `~/.dsh/AGENTS.md`）；项目根由 `.git` 标记（可配置 projectRootMarkers）；加载顺序为用户全局 → 项目根到会话 cwd 的链、由宽到专，**更具体的指令优先**；同目录内容相同的兄弟文件只渲染一次（`CLAUDE.md` 复制 `AGENTS.md` 会去重）。
- 注入形态：一条持久 user 角色消息，外裹插件所有的 `<system-reminder>` 框，开头原话是 The following workspace instructions may be relevant to your work... They do not override system, developer, or direct user instructions——**指令文件是低权威引导，永不覆盖系统/开发者/直接用户指令**；内容里的字面 `</system-reminder>` 会被转义防注入（README 与会话快照 https://github.com/deepseek-ai/deepseek-harness/blob/master/snapshots/session/agent-instructions/session.v3.jsonl 均可核对实际渲染）。
- 符号链接会被跟随，`CLAUDE.md → AGENTS.md` 镜像按内容去重；这是仓库主明确接受的信任边界取舍，说明见 https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-07-21-follow-instruction-symlinks.md 。
- 嵌套发现：成功的 read/write/edit 触达更深目录后，下一次请求补入该目录的指令文件；变更产生 Updated instructions from 提示、删除产生 removal notice；**bash 里 cd 不触发发现**（shell 语法不是可靠文件系统 seam）；无 watcher，刷新是 touch 驱动。
- 官方 dogfooding：harness 仓库根目录就是 AGENTS.md（https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md ，另有一个仅含 AGENTS.md 四字符的 CLAUDE.md 指针），`.github/`、`docs/`、`packages/`、`scripts/` 等每个子树各有自己的 AGENTS.md。

官方推荐写法（docs/AGENTS.md 文档标准，https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md ）的 tier 表原文要点：根 AGENTS.md = standing orders（agent 每个会话都需要在上下文里的规则，每条一到三行、链接到家），子树 AGENTS.md = 仅本子树的命令；stories、worked examples、situational procedures、以及从链接目标复述的内容都**不属于** AGENTS.md；每个事实只有一个家，别处只放链接。写作风格另有硬规则：一段一行（软换行）、教程/参考文档先分类、先定位再定细节层级。

**未找到的东西**：API 文档与 harness 仓库均未见 CONTEXT.md、docs/agents/* 这类布局的成文支持（harness 根目录 md 全表与 docs/ 全表无 CONTEXT.md）——若本仓库保留这些文件，对 DeepSeek 侧它们只是仓库自定义约定，需要在 AGENTS.md 内显式指引加载；README 亦未记录 MiMo 式的 `@file` 自动解析（harness 不做指令内引用展开，按需读取要靠指令自己写明）。

## DeepSeek-V4.1-Flash（deepseek-flash）能力边界

一手来源：Models & Pricing 页（https://api-docs.deepseek.com/quick_start/pricing ）、2026-09-10 Change Log（https://api-docs.deepseek.com/updates ）、Vision/Thinking/Tool Calls/JSON Output 各指南页。

- **上下文长度 1M，最大输出 384K**（定价页模型表 CONTEXT LENGTH 1M、MAX OUTPUT MAXIMUM: 384K）；并发上限 2500。模型版本标注 DeepSeek-V4.1-Flash，2026-09-10 发布。
- **多模态输入**：原生多模态视觉理解（changelog 原话 native multimodal visual understanding）；Vision 页：`deepseek-flash` 接受 JPEG/PNG/GIF/WebP，三种投喂方式（base64 内联、外链、Files API file_id）；**图片只支持放 user 消息，放 system 或 assistant 返回 400**；单请求最多 600 张图、请求体 48 MiB、单图 32 MiB（Files API 64 MiB）、每张图 token 上限 1024；detail low 会先缩到 512×512（https://api-docs.deepseek.com/guides/vision ）。
- **工具调用**：thinking 与非思考模式均支持（https://api-docs.deepseek.com/guides/tool_calls ）；strict 模式（beta，需 `base_url=https://api.deepseek.com/beta` 且每个 function 设 strict=true）保证工具调用严格符合 JSON Schema，schema 约束包括所有 object 属性必须 required 且 additionalProperties=false、不支持 minLength/maxLength/minItems/maxItems；**中途插入 tool 消息**：Anthropic /messages 与 Responses API 支持，Chat Completions 不支持（只支持中途插 system）。anthropic 兼容层把不支持的模型名自动映射到 `deepseek-flash`，claude-opus* 映射到 `deepseek-v4-pro`（https://api-docs.deepseek.com/guides/anthropic_api ）。
- **结构化输出**：JSON Output 用 `response_format={'type':'json_object'}`，且必须在 system/user 提示里包含 json 一词并给一个目标格式示例、合理设置 max_tokens（https://api-docs.deepseek.com/guides/json_mode ）；更严的约束走工具 strict 模式（beta）。JSON 模式**可能偶发返回空内容**（官方 Known issue，同页原文：the API may occasionally return empty content）。
- **thinking 可控**（https://api-docs.deepseek.com/guides/thinking_mode ）：默认开启、默认 effort high；OpenAI 格式经 extra_body 传 `thinking: {type: enabled/disabled}` 切换，`reasoning_effort` 取 low/high/max（映射表：minimal→low、medium→high、xhigh→high、ultra→max）；Anthropic 格式 `reasoning: {effort: none/low/high/max}`，none 关闭；Responses 格式 `output_config.effort`。思考内容在 `reasoning_content` 字段；**带 tools 的多轮请求必须把历史 reasoning_content 完整回传，否则 API 返回 400**；不带 tools 时回传被忽略。
- **官方评测配置参考**（changelog 2026-07-31 与 2026-08-21 条目）：V4-Flash 系列公开 agent 基准用 DeepSeek Harness minimal mode、max effort、topp=0.95、temperature=1.0 测得；V4.1-Flash 发布条目列出 DeepSWE v1.1 74.2、Terminal-Bench 2.1 90.6、NL2Repo-Bench 65.4 等 agent 基准分，但未附框架说明。

## 官方对提示词长度、文件引用、命令风格的偏好

- **提示词长度**：API 文档未找到成文的提示词长度建议或系统提示词规范页（sitemap 全表无对应页；FAQ 页为 JS 跳转未能抓取正文，如实记录）。可用的官方数字来自 Harness：workspace 指令基线预算默认 65,536 字节（`maxBytes`，dsh-base 默认）、单文件源上限 1,048,576 字节（`maxSourceBytes`）；超预算行为是**先整篇丢更宽泛的文件、再截断最具体的文件**，并发出可见的 Workspace instruction budget 提示（README 同上）。
- **前缀稳定性偏好**：Context Caching 默认开启，缓存命中要求前缀**完全匹配**缓存单元、best-effort 不保证 100%（https://api-docs.deepseek.com/guides/kv_cache ）；Harness 据此把指令注入设计为 append-only、resume 兼容时复用同一基线消息（README KV Cache effect 节）——即官方工程偏好是「指令文件保持稳定、增量追加」，而非频繁改写头部。
- **文件引用方式**：Harness 官方 runtime context 成文规定（https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/web/tests/expected/web-runtime-context/file-reference-prompt.expected.md ）：提及已存在的文件必须链接到工作目录相对或绝对全路径、已知行号附 `#L24` 或 `#L24-L30`、标签用文件名或清晰别名（正文行内引用用 `:24` 形式）、表格和重复提及也要链接、标签里不放完整路径。这是注入给所有模型的系统级约定。
- **命令风格**：Harness 系统提示模板成文规定（https://github.com/deepseek-ai/deepseek-harness/blob/master/snapshots/session/agent-instructions/system-prompt.expected.md ）：每次 bash 结果检查 `[exit code: N]` 标记并排查失败；用 read 工具而非 cat 等 shell 命令读文本；write 覆盖前先 read；edit 做定点替换且先 read；用 glob 而非 find、用 grep（ripgrep）而非 shell grep/rg；跟踪每个后台 job id、收尾前用 job_output 收集。这些是 harness 层通用纪律，官方未记录「DeepSeek 模型特别容易违反某条命令风格」一类弱点。
- **AGENTS.md 篇幅与结构偏好**：见上节 docs/AGENTS.md 标准——standing orders 每条一到三行、一 fact 一 home、链接代替复述、一段一行。

## 官方记录的已知弱点与注意事项

- JSON Output 偶发空内容，官方建议改提示缓解并合理设 max_tokens（https://api-docs.deepseek.com/guides/json_mode ）。
- 带 tools 的多轮对话漏传 reasoning_content → 400 错误（https://api-docs.deepseek.com/guides/thinking_mode ）。
- thinking 模式忽略 temperature、presence_penalty、frequency_penalty（传了不报错但无效）；top_p 在思考模式只认 0.95–1.0、非思考模式固定 1.0（同上页）。
- 图片仅限 user 消息，system/assistant 带图 400（https://api-docs.deepseek.com/guides/vision ）。
- FIM Completion 仅非思考模式可用（定价页模型表 FEATURES 行）。
- Chat Completions 不支持中途插入 tool 消息，需要时改用 Anthropic 或 Responses API（https://api-docs.deepseek.com/guides/tool_calls ）。
- 指令发现不跟 shell cd，bash 改目录不触发嵌套 AGENTS.md 加载；无 watcher，外部编辑要等下一次成功的文件工具调用（README Known Limitations 节）。
- 旧模型名停用时间线：`deepseek-chat`/`deepseek-reasoner` 2026-07-24 停用；`deepseek-v4-flash`/`deepseek-v4-flash-vision-exp` 已退役、临时路由（https://api-docs.deepseek.com/updates ）。

## 模型 id 迁移事实与环境文件写法

一手证据（https://api-docs.deepseek.com/updates 2026-09-10 条目 + https://api-docs.deepseek.com/quick_start/pricing 页脚注 1）：

- 正典 id：**`deepseek-flash`** = DeepSeek-V4.1-Flash，2026-09-10 起 API 可用。
- `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`：对应模型已 retired，为兼容**临时路由**到 V4.1-Flash、按 Flash 价格计费——可调用但属过渡名，环境文件不应再写。
- `deepseek-v4-pro`：仍独立提供（模型版本 DeepSeek-V4-Pro-0813、独立定价、并发 500），changelog 称应用户要求 2026-09-14 之后继续提供服务、计费方式不变、变更另行通知。**票面「V4-Pro 路由到 V4.1-Flash 价格、待 V4.1-Pro 替代」与这两处现行一手来源不符**，以一手来源为准；无论 V4-Pro 命运如何，它都不是 V4.1-Flash 的别名。
- `deepseek-chat`、`deepseek-reasoner`：2026-07-24 已停用（曾在过渡期指向 deepseek-v4-flash 的非思考/思考模式）。
- **环境文件结论：DeepSeek 侧模型 id 一律写 `deepseek-flash`**（V4.1-Flash 的正典名，changelog 原话 Change the model name to deepseek-flash to call the latest V4.1 Flash model）；需要 Pro 才另议 `deepseek-v4-pro`。

## 对《静态核对清单》的直接输入

- 模型 id 行：DeepSeek 侧 = `deepseek-flash`（并列 MiMo 侧 id 由 #34 取证另行决定）；列出废弃 id 黑名单：`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-chat`、`deepseek-reasoner`。
- 载体行：AGENTS.md 是 DeepSeek Harness 默认原生加载的一等载体（64KiB 预算内、由宽到专、更具体优先）；CONTEXT.md / docs/agents/* 无官方背书，须在 AGENTS.md 内写显式加载指令才能进入上下文。
- 结构行：根 AGENTS.md 必须自足（嵌套 AGENTS.md 不被 shell cd 触发发现）；每条 standing order 一到三行并链接到家；总量控制在 64KiB 内且把最重要的放最具体层。
- 行为行：文件引用遵守 harness 链接/行号规则；命令风格与 harness 系统提示一致；结构化输出提示必须含 json 词 + 格式示例；工具 schema 严校验走 strict beta（/beta base_url）；带 tools 的会话回传 reasoning_content；图片只进 user 消息。
- 验证行：不要用 temperature/top_p 断言 thinking 行为（被忽略或钳制）；JSON 输出校验需容空重试；缓存敏感场景保持指令文件稳定、增量修改。

## 来源 URL 列表

- https://api-docs.deepseek.com/updates （Change Log：V4.1-Flash 发布、模型 id 路由、V4 Pro 延续服务、旧 id 停用时间线）
- https://api-docs.deepseek.com/quick_start/pricing （Models & Pricing：deepseek-flash = V4.1-Flash、1M 上下文、384K 输出、能力表、legacy id 脚注、V4-Pro 独立定价）
- https://api-docs.deepseek.com/guides/thinking_mode （Thinking Mode：默认开、effort 映射、开关参数、reasoning_content 回传 400、采样参数忽略/钳制）
- https://api-docs.deepseek.com/guides/tool_calls （Tool Calls：thinking 支持、strict beta、中途插入消息的 API 差异）
- https://api-docs.deepseek.com/guides/json_mode （JSON Output：用法要求与偶发空内容）
- https://api-docs.deepseek.com/guides/vision （Vision：格式、限制、user-only、图片限额与 token 规则）
- https://api-docs.deepseek.com/guides/coding_agents （Integrate with AI Tools：Claude Code/OpenCode/OpenClaw 接入与 deepseek-flash 配置）
- https://api-docs.deepseek.com/guides/anthropic_api （Anthropic API 兼容表与模型名映射）
- https://api-docs.deepseek.com/guides/kv_cache （Context Caching：前缀完全匹配、best-effort）
- https://api-docs.deepseek.com/guides/multi_round_chat （无状态 API、需自行拼接历史）
- https://api-docs.deepseek.com/sitemap.xml （全站页面清单，用于「未找到」类结论的穷尽性依据）
- https://www.deepseek.com/harness （DeepSeek Harness 官方首页：一切皆插件、运行模式、开源链接）
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md （指令加载机制、预算、候选、模板、已知限制）
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/AGENTS.md （AGENTS.md 文档标准：tier 表与写法规则）
- https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md （官方仓库根 AGENTS.md 实例）
- https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-07-21-follow-instruction-symlinks.md （符号链接跟随与 CLAUDE.md 镜像去重决策）
- https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/web/tests/expected/web-runtime-context/file-reference-prompt.expected.md （文件引用风格成文原文）
- https://github.com/deepseek-ai/deepseek-harness/blob/master/snapshots/session/agent-instructions/system-prompt.expected.md （命令风格系统提示原文）
- https://github.com/deepseek-ai/deepseek-harness/blob/master/snapshots/session/agent-instructions/session.v3.jsonl （system-reminder 注入的实际会话记录）
- https://www.deepseek.com/en/news/deepseek-v4-1-flash/ （新闻发布稿，主会话已核不含环境规范，仅作起点记录）