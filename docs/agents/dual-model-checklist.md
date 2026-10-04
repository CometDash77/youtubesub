# 双模型静态核对清单 (DeepSeek-V4.1-Flash × MiMo-V2.6)

指令层 (AGENTS.md / CONTEXT.md / docs/agents/*) 改造的验收标准。纯静态核对: 不跑真实模型、不烧 API。
决议来源: wayfinder [静态核对清单：条目、载体与通过标准 #35](https://github.com/CometDash77/youtubesub/issues/35)。取证: [DeepSeek](deepseek-v4.1-agent-env.md) / [MiMo](mimo-v2.6-agent-env.md)。

## 执行方式

- 时机: (1) 方案自检 — 指令层改造方案定稿前对照本清单过一遍; (2) 落地核对 — 文件改完后逐条核对, 全过才算验收。
- 三态记录: 每条记 通过 / 不通过 / N/A。N/A 必须附一句理由, 不许静默跳过。
- 判法两类: **禁令类** = 静态扫描 (grep), 命中即不通过; **存在类** = 读文件确认目标内容存在且覆盖该条, 写法类抽查实际文本。
- 不过怎么办: 任一条不通过 = 验收不成立, 改动不得关闭执行票; 回改指令层文件后重跑该条, 直到全过。
- 结果载体: 核对结果贴执行票票面, 不写回本文件 (本文件是标准, 结果是快照)。

## 范围与豁免

- 扫描范围: `AGENTS.md`、`CONTEXT.md`、`docs/agents/*.md`。
- 豁免: 本文件 (黑名单与差异分栏的家, 枚举废弃 id 是它的内容) 与 `docs/research/*` (取证记录须原样引用)。
- 产品代码与测试不在扫描范围 (map 出界)。既有段落受增量并列保护, 写作类条目只约束本轮新增内容。

## A. 模型标识 (禁令类)

- A1. DeepSeek 侧模型 id 只写 `deepseek-flash`。黑名单 (扫描命中即不通过): `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-chat`, `deepseek-reasoner`。
  - Good: 环境与指令文件写 `deepseek-flash`。Bad: 写 `deepseek-chat` (2026-07-24 已停用)。
- A2. MiMo 侧模型 id 只写 `mimo-v2.6-flash` (全小写带点)。黑名单: `mimo-v2-6-flash` (仅第三方网关变体), 拿 HF 仓库名 `XiaomiMiMo/MiMo-V2.6-Flash-RL` 当 API id。
  - Good: 写 `mimo-v2.6-flash`。Bad: 写 `mimo-v2-6-flash`。

## B. 载体与加载 (存在类)

- B3. AGENTS.md 是两家共同的一等指令入口, 双模型章节位于其内, 未被移出或降级。
- B4. AGENTS.md 内含显式加载指引: CONTEXT.md 与 docs/agents/* 逐文件列出、标明按需 lazy-load 不预载; 两家走同一路径, 不使用 mimocode.json instructions。
- B5. 根 AGENTS.md 单独读完即自足 (双模型 id 与加载指引不依赖其他文件才成立), 且文件总字节 < 65,536 (DeepSeek 注入预算)。

## C. 写作风格 (存在类, 范围: 本轮新增内容)

- C6. 新增 standing orders 每条 1–3 行, 一 fact 一 home, 详情用链接不复述。
- C7. 新增规范类条目用祈使句短条目, 关键 id / 写法给出 Good/Bad 正反例 (见 A1/A2)。
- C8. 新增内容追求更短路径、更少 token: 无故事、无 worked example、无对链接目标的复述。

## D. 模型能力事实 (存在类: 家 = 本文件分栏; 禁令类: 扫描范围不得出现矛盾表述)

- D9. 上下文两家均 1M。
- D10. 最大输出分栏: DeepSeek 384K / MiMo 128K (131,072) — 不得混写、不得互填。
- D11. thinking: 两家默认开; DeepSeek effort 可控 (low/high/max); MiMo 调工具时官方建议关。

## E. 已知弱点规避 (存在类: 家 = 本文件分栏且与取证一致; 禁令类: 扫描范围不得有相反表述)

- E12. 共性: 多轮带工具请求必须原样回传 `reasoning_content`, 缺失两家均 400。
- E13. 分栏: 结构化输出 — DeepSeek 提示含 `json` 词 + 格式示例; MiMo 四要素完整约束 + schema 校验重试兜底。
- E14. 分栏: thinking 下采样参数 — DeepSeek 忽略 temperature / penalties 且 top_p 钳制; MiMo 强制 1.0 / 0.95。不得用 temperature 断言 thinking 行为。
- E15. 分栏: 图片只进 user 消息 (DeepSeek 硬限制, system/assistant 带图 400); MiMo thinking 开时调工具不稳定, 官方建议调工具时关 thinking。

## F. 指令层文件引用纪律 (范围: 本轮新增内容)

- F16. 新增内容提及已存在文件用 markdown 链接 (相对路径), 指向具体行时附 `#L24` / `:24` 形式; 不以裸反引号路径作唯一引用。
- F17. 执行核对遵守 harness 命令风格: 读文本用 read 不用 cat, 检索用 glob / grep 不用 find / rg, 每条命令检查 `[exit code: N]` 标记。
- F18. 指令文件改动保持增量稳定: git diff 只见新增行, 既有行零改写 (增量并列硬约束)。
