# AGENTS.md

## Agent skills

### Issue tracker

Issues live as GitHub issues in `CometDash77/youtubesub`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five default triage roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) plus the `bug` / `enhancement` category roles. See `docs/agents/triage-labels.md`.

### Domain docs

multi-context. See `docs/agents/domain.md`.

## 工具调用禁止事项

### 禁止单独传 `justification`

- 调用 `run_code`、`pwsh` 等带 `sandbox_permissions` 的工具时，**禁止只传 `justification` 而不传 `sandbox_permissions`**——这会触发运行时校验失败：`Error: invalid escalation: justification is only valid together with sandbox_permissions`（出自 `@deepseek-ai/dsh-sandbox` 的 `validateEscalationArgs`：`sandbox_permissions` 与 `justification` 必须成对出现，且 `justification` 非空）。
- 规则：两个参数要么**同时传**，要么**都不传**。没有需要沙箱升级的场景（普通读写、工作区内操作、已处于 `danger-full-access` 策略、审批已禁用）一律**两个都不传**；看到该报错后禁止原样重试，必须去掉 `justification` 再调用。

## 双模型维护环境（DeepSeek-V4.1-Flash 与 MiMo-V2.6）

本项目由两家 agent 共同维护，指令层对两家同等生效。

- 模型 id：DeepSeek 侧一律写 `deepseek-flash`，MiMo 侧一律写 `mimo-v2.6-flash`；废弃与非官方写法黑名单见[双模型静态核对清单](docs/agents/dual-model-checklist.md)。
- 按需读（lazy-load，不预载；读到即视为强制指令）：[CONTEXT.md](CONTEXT.md)（项目上下文与术语）、[issue-tracker](docs/agents/issue-tracker.md)（issue 操作）、[triage-labels](docs/agents/triage-labels.md)（标签映射）、[domain](docs/agents/domain.md)（领域文档）、[双模型清单](docs/agents/dual-model-checklist.md)（验收标准）。
- 指令层（AGENTS.md / CONTEXT.md / docs/agents/*）任何改动，合并前逐条过[双模型静态核对清单](docs/agents/dual-model-checklist.md)（纯静态核对，不跑模型）。
- 两家能力边界、已知弱点与差异分栏以清单为准；一手取证：[DeepSeek 侧](docs/research/deepseek-v4.1-agent-env.md)、[MiMo 侧](docs/research/mimo-v2.6-agent-env.md)。
- 边界：`harness/` 是 DeepSeek Harness 运行时专属（另有维护 map），不在双模型维护范围内，MiMo 侧不改 `harness/`。
