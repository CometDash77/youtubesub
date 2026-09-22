# youtubesub 翻译配置与管线规格（SPEC）

状态: **锁定** —— 来源 map [#2 配置可信、测试连接与 kiss-translator 同级翻译管线（规格）](https://github.com/CometDash77/youtubesub/issues/2) 的 10 张决策票已全部关闭、迷雾清空（2026-09-22）。

规范层级（三层，**内容冲突 = bug，发现即改到一致**）：

1. **本文件（SPEC 总纲）** —— 跨主题不变式、对齐边界、分阶段顺序、验收口径、工作项索引；单一入口。
2. **主题规格单（issue）** —— 实现与测试细节的家：[#22](https://github.com/CometDash77/youtubesub/issues/22) / [#23](https://github.com/CometDash77/youtubesub/issues/23) / [#24](https://github.com/CometDash77/youtubesub/issues/24) / [#38](https://github.com/CometDash77/youtubesub/issues/38) / [#39](https://github.com/CometDash77/youtubesub/issues/39)（均 `ready-for-agent`）。
3. **ADR（`docs/adr/`）** —— 每条决策的理由与后果账本（ADR-004 ~ ADR-011）。

单写者约定（#20 决议）：任何决策变更的唯一入口 = **先改 ADR / 规格单 → 再同步本文件对应节**；本文件不接受并行直写。

## 目标与范围

两部结构：

- **第一部 配置可信与测试连接** —— 用户能确认配置保存在哪、是否已保存、重启后有没有回显；一键测试连接给出可信结论。
- **第二部 翻译管线四主题** —— 规则断句 / 提前批翻译 / 智能上下文 / 提示词管理，对齐 kiss-translator **行为**（它是 GPL-3.0：clean-room 重写，只对齐行为与常量，不抄代码与文本）。

map 只产决策不交代码；**实现从主题规格单起步，按本文「分阶段实现顺序」推进，以本文 DoD 验收**。

Out of scope（维持排除，出处 map #2）：

- 跨设备 / 云同步配置（连带：配置导出/分享功能出现时，导出格式必须加密 —— ADR-011 的翻盘点）。
- 改动 YouTube 抓取链路（userscript 侧）。
- kiss 的统计断句器与 AI 断句路径（ADR-006 判定排除）。
- kiss 的视频级摘要与占位符系统（#8 判定不引入 —— ADR-010）。

## 跨主题不变式清单（硬契约）

每条都有回归测试或机检钉住（见各规格单 Testing Decisions）；删除任何一条 = 回归缺陷。

1. **缓存 identity** = SHA-256(`version`, `provider{base_url, model, protocol, mock}`, `client_key`, `instructions`, `prompt`)，**永不含 api_key**；方案版本 v2，`mock` 是 provider 维度 —— ADR-008。
2. **上下文进 identity**：`context_groups` 开关翻转或邻组原文变化必改 identity；**位置确定性** —— 首尾缺省、seek/批/单发任意路径同一组 identity 逐字节相同 —— ADR-009。
3. **换 / 删 / 改预设必改 identity 与翻译命名空间**（零失效逻辑，分叉即正确）—— ADR-010。
4. **同路径不变式**：测试连接与生产同 cfg、同 `translate_group`（含重试退避），唯一差异是不读写缓存 ⇒ **红灯 = 生产也会红** —— ADR-005 / #23。
5. **测试绕开队列与缓存**：与 `max_concurrent` 无关、绿灯不来自缓存；**绝不自动触发**；取消 = 放弃等待不中断请求（额度不退，generation 丢弃过期回写）—— #5 / #23。
6. **组装三段次序写死**：最终 system = 预设正文 → 上下文标签行（开关开且有邻组）→ N|line 对齐指令（`expected_lines > 1`）；**user 消息恒为纯当前句**；协议段程序生成、不进编辑框 —— ADR-010。
7. **批契约**：批只在窗口填充爆发点产生（≤8 组 / ≤8000 字符切块）、全局连续编号 + 精确全覆盖、失败整批作废交 URGENT、**批不落盘**；批内每组保留上下文以维持「同一组批/单发 identity 逐字节相同」；**在途请求一律不中断** —— ADR-007。
8. **单文件配置证据链**：配置只在 `%APPDATA%\SubOverlay\setting.json` 单文件单路径；页脚常驻路径 + 打开配置目录；`_meta.saved_at` **仅 OK 写入**（文件 mtime 不可信、**文件存在 ≠ 配置过**）—— #4。
9. **API Key 四不 + 明示**：不进日志、不进 `/status`、不进报告、不进 identity；**屏上不显明文**（回显 =「已保存 N 字符 · 留空 = 不改动 · 输入 = 覆盖」）、**盘上明文但挑明**（面板/README/MANUAL 三处明示）—— #4 / #5 / #40，ADR-005 / ADR-011。
10. **Mock 永不显绿**：测试连接三值 `pass / fail / mock`，mock 零网络请求 + `MOCK_MASKS_REAL_CONFIG` 警告；Mock 同时是缓存 identity 维度 —— #5 / #23，ADR-008。
11. **断句判据不可配置、只有一套**：旧启发式整块删除不并存；手动轨承诺断点一致、ASR 轨共用判据但不承诺 —— ADR-006 / #22。
12. **`provider.max_concurrent` 接上**：读取钳制 **[1, 16]**、默认 5、**重启生效**（worker 池构造时固定）、面板有入口 + 「改后重启生效」标注 —— #21。
13. **保存语义**：OK 是唯一写 `provider / prompt / display` 的动作（写盘即关窗）；几何拖动仍自动整份写但**不产生任何「已保存」反馈**；Cancel 有未保存改动时二次确认 —— #4。

## 与 kiss-translator 的对齐边界

| 主题 | 照搬（行为/常量） | 不照搬（+ 原因） | 来源 |
|---|---|---|---|
| 规则断句 | 空格语系六条判据（真实静音基准 + 1000ms、15 词逗号门、10s 时长、无回退、非语音剔除、记号开头强制断）；无空格分支（5 字符/50% 质量闸门 → 30 字符 + 1000ms）；长句二次切分 + 46 词连词表、阈值写死 100 | 统计/AI 断句器（Out of scope）；判据可配置化；伪造词级时间戳 | #3 / #6，ADR-006，#22 |
| 提前批翻译 | 90 秒时间窗口 + 组数硬上限 20（先到者）；爆发点同步切块（≤8 组 / ≤8000 字符）；精确全覆盖校验 | 30 秒扫描节流（事件原生增量更平滑）；seek 不处理在途（在途不中断）；通用 BatchQueue 20/10000；整片预批 | #3 / #9，ADR-007，#24 |
| 智能上下文 | 「上下文与当前句分隔、全在 system、user 纯净」原则；前后各 1 组窗口 | `contextSize=3` 与对话历史机制（要求批次并发降 1，其字幕路径自己也不用）；**上下文不进缓存键**（#3 登记的缺陷，我们刻意相反） | #3 / #7，ADR-009，#38 |
| 提示词管理 | 预设锁代码、不可删、只能复制成自定义；自定义存配置数组 | 10 条 4 分类（多用途）；13 个占位符体系；视频摘要；boundary-v3 断句正文（它切句、我们只翻） | #3 / #8，ADR-010，#39 |
| 配置 UX / 测试连接 | （kiss 无对应）本项目自研 | — | #4 / #5 |

## 第一部 配置可信与测试连接

### 1.1 配置可信 UX（#4 的 7 条决策 + #21 + #40）

1. **保存反馈 = 重开时回看**：OK 写盘即关窗；下次打开显示一行「上次保存 HH:MM:SS · 配置路径」；从未保存明说「从未保存过配置」。
2. **页脚常驻配置路径**（可选中复制）+「打开配置目录」按钮。
3. **API Key 永不回显明文**：placeholder「已保存 N 字符 · 留空 = 不改动 · 输入 = 覆盖」；未设置明说；旁附「清除」（二次确认）；`base_url` / `model` 正常回显。
4. **面板顶部三态条**：未配置（琥珀）/ Mock（蓝）/ 已配置（绿，带 host · model）。
5. **浮窗三态状态行**：未配置「未配置翻译 · 右键 → 设置」且**不渲染译文行**（黄像素机检 = 0）；Mock「Mock 模式 · 译文为本地回声」；已配置静音。
6. **写盘时机**：OK 是唯一写业务配置的动作；几何拖动自动写但无反馈。
7. **`_meta.saved_at` 仅在 OK 写入**（mtime 不可信的实测结论）。
8. **#21**：`max_concurrent` 接到 `Engine` workers，钳制 [1,16]，面板 SpinBox +「改后重启生效」。
9. **#40**：API Key 明示三处 —— 面板行说明、README 一句、`docs/MANUAL-ACCEPTANCE.md` 一句。

原型蓝本：`prototype/config-ux`（commit `e2ba9ce`，含 4 张三态 PNG 与 proposal.md）。

### 1.2 测试连接（#5 → 规格 #23 + ADR-005）

- **两步契约**：第 1 步 `GET /models` 三态只定位、不判失败、不挡路；**门槛在第 2 步** —— 真发一句最小翻译、结构合法非空译文才 pass；本地静态校验才短路（网络结果含 401 也不挡第 2 步）。
- **错误码闭集**两步共用，新增 `TIMEOUT` / `NETWORK`（修掉「网络故障显示成 WORKER」）。
- **报告 = 单一事实源**（code + message，失败保留已成功层，Key 永不出现），挂 `/status` 新字段 `connection_test`，不落盘、不建日志子系统。
- 工作线程 + 单飞 + 进度滴答；快照语义（测点击那一刻的输入）；结果带 `attempts`。

### 1.3 本部实现清单

| 实现项 | 承接 | 备注 |
|---|---|---|
| 面板/浮窗三态 UX（七条决策全量） | SPEC 实现清单（源自 #4，无独立规格单） | 蓝本 `e2ba9ce`；黄像素机检、Key 不落明文机检 |
| 测试连接两步契约全量 | [#23](https://github.com/CometDash77/youtubesub/issues/23) | Implementation + Testing Decisions 为准 |
| `max_concurrent` 接线 + 面板 | SPEC 实现清单（源自 #21） | 测试：workers 来自配置的表驱动钳制 + 面板离屏断言 |
| API Key 明示三处 | SPEC 实现清单（源自 #40） | 不改任何安全不变式 |

## 第二部 翻译管线

### 2.1 规则断句（#6 → ADR-006 + 规格 #22 及子项 #25–#30）

判据整体替换为 kiss「规则断句」分支的行为等价实现（clean-room）；翻译单位 = 句子组与对齐协议**不动**（ADR-004 的该部分继续有效）；已知接受的行为变化（中文手动轨闸门触发时一行一组、非语音无译文、组变长致降级更频繁）与继承缺陷（语言前缀二分误伤混排、连词表仅英文）见 ADR-006。细节与表驱动用例：[#22](https://github.com/CometDash77/youtubesub/issues/22)，拆分子项 [#25](https://github.com/CometDash77/youtubesub/issues/25)–[#30](https://github.com/CometDash77/youtubesub/issues/30)。

### 2.2 提前批翻译（#9 → ADR-007 + 规格 #24）

预取 90 秒 + 组数上限 20（不做倍速缩放）；事件原生增量 + seek 去抖 400ms；爆发点批请求（≤8 组 / ≤8000 字符、连续编号精确全覆盖、整批作废、批不落盘、在途不中断）。残余风险：批失败粒度 = 整批、稳态成本不降、三上限待真 Key 校准。细节：[#24](https://github.com/CometDash77/youtubesub/issues/24)。

### 2.3 智能上下文（#7 → ADR-009 + 规格 #38）

窗口固定前后各 1 组（取邻组原文）；线上标签行进 system、user 纯当前句，`" || "` 仅身份层；identity 含上下文；可配置面 = 唯一布尔 `prompt.context_groups`，其预取门控语义解耦（预取归 2.2）。范围外：视频摘要（见 Out of scope）。细节：[#38](https://github.com/CometDash77/youtubesub/issues/38)。

### 2.4 提示词管理（#8 → ADR-010 + 规格 #39）

内置 3 条（`default` / `literal` / `natural`）锁代码不可删不落盘；自定义存 `prompt.presets`、`prompt.system` 迁移单向一次；UI = 下拉 + 复制/重命名/删除 + 内置只读 + 只读生效预览 + `context_groups` 复选框；预览/测试连接/生产共用同一组装函数；无占位符系统。细节：[#39](https://github.com/CometDash77/youtubesub/issues/39)。

## 分阶段实现顺序

| 阶段 | 内容 | 依赖理由 |
|---|---|---|
| **1. 配置可信与测试连接** | 1.1 全部（#4 七条 + #21 + #40）+ 1.2（[#23](https://github.com/CometDash77/youtubesub/issues/23)） | 无外部依赖；先建用户信任，且测试连接是后续所有阶段的**校准工具** |
| **2. 规则断句** | [#22](https://github.com/CometDash77/youtubesub/issues/22) + [#25](https://github.com/CometDash77/youtubesub/issues/25)–[#30](https://github.com/CometDash77/youtubesub/issues/30) | 独立于 provider；**组边界定型**是预取/批/上下文的输入，必须先于阶段 3 |
| **3. 调度与上下文** | [#24](https://github.com/CometDash77/youtubesub/issues/24) + [#38](https://github.com/CometDash77/youtubesub/issues/38) | 依赖阶段 2 的组边界稳定；两者共享 identity 不变式，一起验收 |
| **4. 提示词管理** | [#39](https://github.com/CometDash77/youtubesub/issues/39) | schema 迁移 + 面板改动；排在阶段 1 之后避免与面板 UX 改动相互 rebase |
| **M. 真实 Key 校准**（里程碑，贯穿验收） | 测试连接 20s 上限、批三上限（组数/批组/批字符）、内置提示词措辞（`literal` / `natural` 效果） | **唯一可翻盘点清单** —— 本机无真实 Key，全部只做了 mock 验证；翻盘走「先改 ADR/规格单 → 同步 SPEC」 |

## 验收口径（Definition of Done）

实现被视为「走完本规格」当且仅当（判定人 = 实现 PR 的 reviewer，逐条勾）：

- [ ] 5 张主题规格单（#22 / #23 / #24 / #38 / #39）的 **Testing Decisions 用例全部落地且绿**（pytest 全套 + userscript 测试，套数只增不减）。
- [ ] **每条跨主题不变式都有回归断言**（本文清单 13 条，逐条可指到测试名）。
- [ ] `docs/MANUAL-ACCEPTANCE.md` 手测条目**更新并逐条通过**：面板三态、浮窗三态与黄像素=0、测试连接三值、API Key 明示三处、`max_concurrent` 重启语义、「上次保存」回看。
- [ ] **阶段 1–4 按序完成**，每阶段合入时上一阶段验收不回退。
- [ ] **里程碑 M 的真 Key 校准项全部勾销**（或明确记录翻盘决议 —— 那将先改 ADR/规格单再改本文）。
- [ ] 若实现触碰指令层（AGENTS.md / CONTEXT.md / docs/agents/*），[双模型静态核对清单](docs/agents/dual-model-checklist.md) 逐条通过。
- [ ] 冲突审计：SPEC / 规格单 / ADR 三层无内容冲突。

## 实现工作项索引

| 工作项 | 承接票 | 依赖 | 阶段 |
|---|---|---|---|
| 面板 / 浮窗三态 UX（#4 七条决策） | 本文 1.1 + 1.3（无独立规格单） | — | 1 |
| 测试连接两步契约 | [#23](https://github.com/CometDash77/youtubesub/issues/23) | — | 1 |
| `max_concurrent` 接线 + 面板 | 本文 1.1.8（#21，无独立规格单） | — | 1 |
| API Key 明示三处 | 本文 1.1.9（#40，无独立规格单） | — | 1 |
| 断句入口接入轨道语言 | [#25](https://github.com/CometDash77/youtubesub/issues/25) | [#22](https://github.com/CometDash77/youtubesub/issues/22) | 2 |
| 段间拼接分隔符对齐 | [#26](https://github.com/CometDash77/youtubesub/issues/26) | [#22](https://github.com/CometDash77/youtubesub/issues/22) | 2 |
| 空格语系六条判据替换 | [#27](https://github.com/CometDash77/youtubesub/issues/27) | [#22](https://github.com/CometDash77/youtubesub/issues/22) | 2 |
| 非语音段剔除 | [#28](https://github.com/CometDash77/youtubesub/issues/28) | [#22](https://github.com/CometDash77/youtubesub/issues/22) | 2 |
| 无空格语系质量闸门 + 30 字符 | [#29](https://github.com/CometDash77/youtubesub/issues/29) | [#22](https://github.com/CometDash77/youtubesub/issues/22) | 2 |
| 长句二次切分 + 连词表收口 | [#30](https://github.com/CometDash77/youtubesub/issues/30) | [#22](https://github.com/CometDash77/youtubesub/issues/22) | 2 |
| 字幕断句判据对齐（总规格） | [#22](https://github.com/CometDash77/youtubesub/issues/22) | — | 2 |
| 提前批翻译契约 | [#24](https://github.com/CometDash77/youtubesub/issues/24) | 阶段 2 组边界定型 | 3 |
| 智能上下文契约 | [#38](https://github.com/CometDash77/youtubesub/issues/38) | 阶段 2 组边界定型 | 3 |
| 提示词管理（迁移 + UI + 组装函数） | [#39](https://github.com/CometDash77/youtubesub/issues/39) | 阶段 1 面板 UX | 4 |
| 真实 Key 校准（20s / 批三上限 / 提示词措辞） | 里程碑 M（本文 DoD） | 阶段 1–4 全部 | M |
