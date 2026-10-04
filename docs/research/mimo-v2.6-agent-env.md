# MiMo-V2.6 官方 agent 维护环境规范取证（wayfinder #34）

调研日期：2026-09-22。一手来源优先（mimo.mi.com / mimo.xiaomi.com / 官方 GitHub、HuggingFace），每条结论附 URL。

## 结论速览

- **未找到小米官方成文的「agent 应如何维护代码仓库」环境规范**；找到的是若干官方强建议：以 `AGENTS.md` 为一等指令入口（MiMo Code 文档成文支持并建议 `/init` 生成后提交 Git），以及一批「工具接入配置」指南页。
- MiMo Code 官方文档有专门的「规则」页，对 AGENTS.md 的初始化、层级、优先级、外部引用写法给出完整推荐（见下文）。
- 官方自家仓库 XiaomiMiMo/MiMo-Code 根目录就维护着一份约 103 行的 AGENTS.md，可作为官方推荐写法范本。
- `mimo-v2.6-flash` 参数一手来源已找到：1M 上下文、最大输出官方写 128K（=131,072 token，与第三方「131K」一致）、Function Call、Structured Output、Deep Thinking（默认开）。
- 模型 id 官方要求全小写 `mimo-v2.6-flash`；`mimo-v2-6-flash` 未见任何官方页面使用，属第三方网关变体。
- 官方明确记录的弱点/注意点：thinking 模式下工具调用不稳定（建议调工具时关 thinking）、多轮工具调用必须回传 `reasoning_content`（否则 400 且指令遵循下降/幻觉）、thinking 模式强制 temperature=1.0/top_p=0.95。
- 官方立场（MiMo Code 发布稿）：不要依赖模型自觉记笔记，要用工程手段（检查点子代理、预算化注入）保障上下文管理。
- mini-harnesses（系统提示/工具/上下文管理解耦）在 V2.6 发布稿中宣布开源，但在官方 HF collection、HF datasets、GitHub 组织仓库与代码搜索中**未定位到独立公开资产**，可能包含在技术报告 PDF 中；未见其配套的成文 agent 环境规范。
- 平台文档站（platform.xiaomimimo.com，正文经 mimo.mi.com/llms-full.txt 可抓）只有 AI 工具接入指南，没有 agent 维护仓库的专项指南页。

## 官方对指令文件（AGENTS.md 类）的态度

MiMo Code 官方文档有专门的「规则（rules）」页（https://mimo.xiaomi.com/zh/mimocode/rules ），核心内容：

- 用 `AGENTS.md` 为 mimocode 提供自定义指令，「类似于 Cursor 的规则功能」，文件内容会纳入 LLM 上下文。
- 推荐用 `/init` 初始化：扫描项目结构与编码约定后生成 AGENTS.md；已有文件则在基础上补充。
- 明确 TIP：**应将项目的 AGENTS.md 提交到 Git**（团队共享）。
- 层级：项目根 `AGENTS.md`（项目级）与 `~/.config/mimocode/AGENTS.md`（全局、个人规则、不进 Git）。
- Claude Code 兼容回退：无 AGENTS.md 时读 `CLAUDE.md`；全局回退 `~/.claude/CLAUDE.md`；可用环境变量禁用。
- 启动时查找优先级：本地向上遍历的 AGENTS.md/CLAUDE.md → 全局 AGENTS.md → `~/.claude/CLAUDE.md`；同类中第一个匹配优先，有 AGENTS.md 就不用 CLAUDE.md。
- 官方示例的 AGENTS.md 结构：项目标题 + 项目简介、`## Project Structure`、`## Code Standards`、`## Monorepo Conventions`（要点式、具体可执行）。
- 自定义指令合并：`mimocode.json` 的 `instructions` 数组可纳入任意 markdown（含远程 URL、glob 如 `packages/*/AGENTS.md`），**所有指令文件都会与 AGENTS.md 合并**；monorepo 官方建议用 instructions glob 而非手动堆砌。
- 外部文件引用：mimocode 不会自动解析 AGENTS.md 里的 `@file` 引用；官方给出两种做法——(a) 用 instructions 字段（推荐），(b) 在 AGENTS.md 里显式写指令教模型按需 Read，并强调 **lazy loading（不要预载全部引用，按任务需要加载；加载后视为强制指令）**、「保持 AGENTS.md 简洁，引用详细指南」。

平台文档的 MiMo Code 接入页（https://mimo.mi.com/static/docs/tokenplan/integration/mimo-code.md ）进一步「强烈推荐」首次使用运行 `/init`：自动生成 AGENTS.md，「MiMo Code 会使用该文件更好地理解项目上下文，提升交互质量」。

官方仓库 dogfooding：https://github.com/XiaomiMiMo/MiMo-Code 根目录自带 `AGENTS.md`（约 103 行）与 `CLAUDE.md`。该 AGENTS.md 结构为 `## Conventions`（要点式硬规则，如包管理命令、默认分支、并行工具、合成值而非机器特定值）、`## Core Focus`（指明维护重心在 TUI 与 engine core）、`## Style Guide`（原则 + Good/Bad 代码示例）、`## Testing`、`## Type Checking`。写法特征：祈使句短条目、给正反例、只写本仓库差异化的约定。

MiMo Code README（https://github.com/XiaomiMiMo/MiMo-Code/blob/main/README.zh.md ）相关态度：

- 指令类资产走「技能」体系：项目 `.mimocode/skills/<name>/SKILL.md`，并同时扫描开放标准目录 `~/.agents/skills` 与项目 `.agents/skills/`。
- 持久化记忆三件套：`MEMORY.md`（项目记忆：知识/规则/架构决策）、`checkpoint.md`（结构化状态快照）、`notes.md`、`tasks/<id>/progress.md`，恢复会话时自动注入。
- 智能上下文管理：自动检查点、上下文重建、**预算化注入（token budget 按重要性排序控制 checkpoint/memory/notes 注入量）**、压缩点可调（`/context-limit`，可按模型设定 `compaction.max_context`，只能调低不能调高）。
- 自定义 Workflow 放 `.mimocode/workflows/` 或 `.claude/workflows/`。

**不存在的东西**：官方文档未提及 `CONTEXT.md`、`docs/agents/*` 这类布局；它们是本仓库自定义约定，MiMo 侧若要读取需经 `instructions` 字段显式纳入或在 AGENTS.md 内写加载指令（见上）。

## mimo-v2.6-flash 准确参数（一手来源）

来源：

- 模型表 https://mimo.mi.com/static/docs/quick-start/summary/model.md （`mimo-v2.6-pro` / `mimo-v2.6-flash` 同一格）
- HF 模型卡 https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL
- 深度思考页 https://mimo.mi.com/static/docs/quick-start/usage-guide/text-generation/deep-thinking.md
- 超参页 https://mimo.mi.com/static/docs/api/guidance/model-hyperparameters.md

核对结果：

- **上下文：1M**。模型表「Context Window: 1M」；HF 模型卡「Context Length: 1M tokens」「1M tokens for long repositories, tool traces, and multi-session agent runs」；架构表「Max Context Length: 1M」。与第三方页（docs.empiriolabs.ai、vercel ai-gateway）一致。
- **最大输出：官方写 128K**（模型表「Maximum Output: 128K」）。第三方所称「131K」即 131,072 token（128×1024），官方 API 文档示例代码里也出现 `MAX_TOTAL_TOKENS = 131072`，两者一致；静态清单写「128K（131,072）」最稳妥。
- **能力清单**（模型表）：Full-modal Understanding、Text Generation、**Deep Thinking**、Streaming Output、**Function Call**、**Structured Output**、Web Search。限流：RPM 100 / TPM 10M。
- **thinking 默认开**：深度思考页「Default Status — Enabled by default: `mimo-v2.6-flash`、`mimo-v2.6-pro`、`mimo-v2.6-pro-ultraspeed`、`mimo-v2.5-pro`、`mimo-v2.5`」；`thinking.type` 可 `enabled`/`disabled` 切换（注意该字段非 OpenAI 标准参数，OpenAI SDK 需放 `extra_body`）。
- **采样默认**：thinking 模式下 temperature/top_p 不支持自定义，强制为推荐默认 **1.0 / 0.95**；超参页给出 v2.6-flash temperature 默认 1.0（范围 [0,1.5]）、top_p 默认 0.95（范围 [0.01,1.0]）；HF 模型卡同样写「Recommended sampling: temperature=1.0, top_p=0.95」。
- **模型 id 全小写约定**：V2.6 发布稿明确「调用 API 时请使用全小写模型名 mimo-v2.6-pro、mimo-v2.6-flash、mimo-v2.6-pro-ultraspeed」（https://mimo.mi.com/docs/zh-CN/news/latest/v2-6 ）；Batch API 文档亦要求「model name must be in lowercase」。**未找到任何官方页面使用 `mimo-v2-6-flash`**（无点号写法只见于第三方网关 slug，如 empiriolabs 的路径段）；HF 仓库名 `XiaomiMiMo/MiMo-V2.6-Flash-RL` 是权重仓库名，不是 API 模型 id。
- 规格补充（HF 模型卡）：Flash = 309B 总参 / 15B 激活的稀疏 MoE；原生全模态（文本/图像/视频/音频）；附技术报告 `MiMo_V2_6_technical_report.pdf`。

## 官方对提示词风格、上下文管理、工具呈现的偏好

- **系统提示极简推荐**：平台文档「Quick Integration Examples」强烈推荐的 system prompt 只有身份 + 日期 + 知识截止两句（中英文各一版），并无长篇人格设定（https://mimo.mi.com/llms-full.txt ）。
- **结构化输出提示词四要素**（Structured Output 文档，同见 llms-full.txt）：明确要求「只返回 JSON、无解释/注释/Markdown 代码块」；给出完整字段+类型+嵌套模板；枚举与数值范围约束；预先定义 null 处理规则；生产环境仍需 jsonschema 校验 + 重试/兜底。原话：「提示约束越清晰完整，模型 JSON 输出越贴近预期」。
- **上下文管理靠工程不靠自觉**（MiMo Code 发布稿 https://mimo.mi.com/static/docs/news/latest/mimocode.md ）：官方批评「让 AI 自己记笔记」的做法依赖模型自觉；做法是主 agent 专注任务、独立子代理负责保存状态、窗口将满时生成干净摘要。一句话立场：「不要只依赖模型的自我意识，用工程来保障」。
- **RL 目标导向短路径**：V2.6 发布稿与模型卡都写 Grader（GRS/GAR）「引导模型以更短路径、更少 Token 完成任务」「steers toward shorter paths and fewer tokens per task」——官方期望 agent 轨迹精简、少废话。
- **Multi-Harness 泛化**（V2.6 发布稿）：mini-harnesses 把「系统提示、工具与上下文管理解耦」，Multi-Harness Training 把多样性与整洁性纳入 RL，提升「在不同框架、包括未见框架上的泛化能力」——即官方认为指令/工具/上下文三者应解耦组合，而不是揉进一个大提示。
- **框架解耦的工程实现**：官方 uni-agent 仓库（https://github.com/XiaomiMiMo/uni-agent ）把 agent 拆成 `Agent`/`Tool`/`Task`/`Sandbox` 可独立定制的抽象，可接入 Claude Code、Mini-SWE-Agent 等任意 harness；这与本仓库「指令层 / 工具层分离」方向一致。
- **同模型 A/B 立场**（MiMo Code 发布稿）：官方认为 harness 本身能显著改分（同 MiMo 模型：MiMo Code SWE-Bench Pro 62% vs Claude Code 57%，Terminal Bench 2 73% vs 68%）；且为 MiMo 系列模型专门做了 Harness 系统（模型-框架协同）。
- **工具呈现**：无单独成文的「工具描述怎么写」规范；官方唯一相关硬建议见下节（调工具时关 thinking）。

## 官方记录的已知弱点 / 注意事项

均出自 llms-full.txt 对应官方页面：

- **thinking 模式下工具调用不稳定**（API Integration FAQ）：`tool_calls` 出现在 `reasoning_content` 里即表明「模型在 thinking 开启时调用 tool 导致输出不稳定、不完整」；**官方建议调用工具时禁用 thinking**，并按超参页调整以获得更稳定体验。
- **多轮工具调用必须完整回传 `reasoning_content`**（深度思考页 + FAQ）：Agent 产品多轮对话中，历史含 tool_calls 的 assistant 响应必须原样带回 reasoning_content，否则 **API 直接 400**；且「历史 reasoning_content 缺失会让上下文不完整，可能导致指令遵循下降、幻觉增加」。受影响产品按协议列出（OpenAI 兼容：TRAE、Cursor、Roo Code、Codex、GitHub Copilot CLI、Zed、AutoGen、Goose 等）。
- **thinking 模式忽略 temperature/top_p**：传了也强制 1.0/0.95（超参页）。
- **输出预算共享**：`max_completion_tokens` 同时限制思考与最终答案，思考长会挤占答案空间，官方建议给足预算（深度思考页）。
- **MiMo Code 的 `/thinking` 只是显示开关**，不能开/关模型思考本身（MiMo Code 接入页 FAQ）。
- 结构化输出仅保证语法合法 JSON，不保证字段/类型符合 schema（Structured Output 文档）。

## 平台文档站的 agent / coding 指南页

- platform.xiaomimimo.com 文档为 hash 路由 SPA，可抓正文聚合在 **https://mimo.mi.com/llms-full.txt** （约 1.1MB，含每个页面的 URL 与标题）。
- 文档站确有一组 AI 工具页（tokenplan/integration/ 下）：Overview of AI Tools（https://mimo.mi.com/static/docs/tokenplan/integration/tools-overview.md ）、MiMo Desktop / MiMo Code / OpenCode / Claude Code / Codex / OpenClaw / Hermes Agent / Kilo Code / Chatbox AI / Cherry Studio / Qwen Code / CodeBuddy / Cline 各自的 Configuration 页。内容全部是「换 Base URL、选模型、登录」级别的**接入配置**，不含 agent 行为规范。
- MiMo Code 产品文档站 https://mimo.xiaomi.com/zh/mimocode/ 下有 agents（代理配置）、rules（AGENTS.md）、skills、config-files、interaction 等页，属于产品用法文档，不是模型侧的仓库维护规范。
- **结论：没有「agent 应如何维护代码仓库」的专项指南页——未找到官方成文规范。** 最接近的成文规范就是 rules 页的 AGENTS.md 写法建议 + MiMo Code 接入页的 `/init` 强推荐。

## mini-harnesses 与 V2.6 开源内容

V2.6 发布稿（https://mimo.mi.com/docs/zh-CN/news/latest/v2-6 ）「全面开源」节列出：

- **7k+ 高质量 RL 任务环境**（软件工程、漏洞复现、知识型工作、网页设计开发四类）；
- **端到端 RL 训练框架**：基于 verl、uni-agent、mini-swe-agent；
- **轻量可组合 Harness：开源极简 mini-harnesses，将系统提示、工具与上下文管理解耦**，用于构建多样可控的训练配置（Multi-Harness Training）。

官方给出的唯一开源链接是 HF collection https://huggingface.co/collections/XiaomiMiMo/mimo-v26 —— 但经 HF API 核实该 collection 仅有 3 个条目：MiMo-V2.6-Pro-RL、MiMo-V2.6-Flash-RL、MiMo-V2.6-Distill-Qwen-9B（模型权重 + 技术报告）。XiaomiMiMo 名下 HF datasets 只有音频数据集；GitHub 组织仓库列表（MiMo、MiMo-Code、mimoagent、uni-agent、verl fork、awesome-mimo-agent 等）与 `gh search code "mini-harnesses"` 均未命中官方 mini-harnesses 资产。**结论：mini-harnesses 已宣布开源但独立资产位置未定位到（可能含于技术报告 MiMo_V2_6_technical_report.pdf 或后续放出），且无论发布稿还是资产内均未见配套的 agent 仓库维护成文规范。** 与之最接近的表述只有发布稿那句「系统提示、工具与上下文管理解耦」。

## 对「静态核对清单」决策的含义（供 #34 输入）

- AGENTS.md 是 MiMo Code 的一等指令入口且官方要求进 Git——双模型改造应保留 AGENTS.md 作为共享指令层，这对 DeepSeek 侧（AGENTS.md 已是社区事实标准）与 MiMo 侧同时有效。
- CONTEXT.md 与 docs/agents/* 无 MiMo 官方对应物：若要被 MiMoCode 读取，按官方推荐用 `.mimocode/mimocode.json` 的 `instructions` glob 显式纳入（会与 AGENTS.md 合并），或在 AGENTS.md 内写 lazy-load 指令；官方明确「AGENTS.md 保持简洁、详细指南外链」。
- 模型标识字段一律 `mimo-v2.6-flash`（全小写带点）；`mimo-v2-6-flash` 非官方 id，仅可当第三方网关别名备注；HF 仓库名与 API id 分开记。
- 参数核对项建议写：上下文 1M；最大输出 128K（131,072）；Function Call ✓；Structured Output ✓；thinking 默认开且调工具时官方建议关；thinking 下 temperature/top_p 固定 1.0/0.95。
- 提示风格核对项：短小明确的祈使句条目 + Good/Bad 正反例（MiMo-Code 自家 AGENTS.md 范式）；结构化输出按官方四要素写约束；轨迹与指令追求「更短路径、更少 token」。
- 上下文管理核对项：官方立场是工程化保障（检查点/预算注入/可调压缩点），不依赖模型自觉——双模型通用，可写成静态检查项。
- 按模型分栏的差异项：reasoning_content 回传与 400 错误是 MiMo（及同类 thinking 模型）特有约束，DeepSeek-V4.1-Flash 侧需单独核实是否有同类要求，不能混写。

## 来源 URL 列表

一手（小米官方）：

- https://mimo.mi.com/docs/zh-CN/news/latest/v2-6 （V2.6 发布稿：全小写 id、mini-harnesses、7k+ 环境、RL 框架）
- https://mimo.mi.com/llms-full.txt （平台文档全量聚合：模型表、深度思考、结构化输出、FAQ、超参、AI 工具接入页）
- https://mimo.mi.com/static/docs/quick-start/summary/model.md （模型能力与长度表）
- https://mimo.mi.com/static/docs/quick-start/usage-guide/text-generation/deep-thinking.md （thinking 默认开、reasoning_content 回传要求）
- https://mimo.mi.com/static/docs/api/guidance/model-hyperparameters.md （temperature/top_p 默认与强制值）
- https://mimo.mi.com/static/docs/tokenplan/integration/mimo-code.md （/init 强推荐、AGENTS.md 生成）
- https://mimo.mi.com/static/docs/tokenplan/integration/tools-overview.md （AI 工具总览）
- https://mimo.mi.com/static/docs/news/latest/mimocode.md （MiMo Code 发布稿：工程化上下文管理立场、同模型 A/B）
- https://mimo.xiaomi.com/zh/mimocode/rules （AGENTS.md 官方规范页）
- https://mimo.xiaomi.com/zh/mimocode/agents （代理配置文档）
- https://github.com/XiaomiMiMo/MiMo-Code （官方仓库：README.zh.md、根目录 AGENTS.md/CLAUDE.md）
- https://github.com/XiaomiMiMo/uni-agent （Agent/Tool/Task/Sandbox 解耦框架）
- https://github.com/XiaomiMiMo/awesome-mimo-agent （官方工具接入教程集合）
- https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Flash-RL （模型卡：1M、309B/15B、采样建议、技术报告）
- https://huggingface.co/collections/XiaomiMiMo/mimo-v26 （V2.6 官方 collection，仅 3 个模型库）

第三方（仅参数交叉佐证）：

- https://docs.empiriolabs.ai/models/mimo-v2-6-flash （1M 上下文 / 131K 输出 / thinking 默认开）
- https://vercel.com/ai-gateway/models/mimo-v2.6-flash （同上）
