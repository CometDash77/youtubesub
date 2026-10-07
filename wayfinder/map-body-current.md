## Destination

在架构与对外行为不变的前提下，把「字幕桥接到本地 → 断句成可读句子 → 批量与提前翻译 → 译文与原句时间轴对齐」这条链路的实现层整体重写一遍，让代码不再越维护越垃圾。验收锚点是重构前落盘的全量测试黄金基线：重构后全绿，且断言语义不被删改或放宽。

## Notes

- 这是个很小的软件，只做四件事：字幕桥接、小断句、批量/提前翻译、时间轴对齐。地图与票一律用领域语言描述，**不引入代码层面的模块 / 文件 / 结构细节**。
- 架构保持不变：既有分层与全部 ADR 决策保留，不重设计、不换技术栈。
- 验收 = 黄金基线法：重构前落盘全量测试结果（pytest 215 + node 46）；测试只许改形式（去重 / 抽夹具），不许删断言、不许放宽断言；7 条真浏览器黑盒 E2E 原样保留；重构后全绿 + 断言语义逐条 diff 审查。
- 驱动方式：一次做完、一次验收，不分大批次、不立前置规范票。
- 本 map 的 destination 是「原地改造」型（change made in place）：执行带进 map 本身，票全部为 task 型；仍遵守一 session 最多解一票。

## 计划

- [ ] [重构前黄金基线落盘：全量测试存档，黑盒 E2E 原样保留](https://github.com/CometDash77/youtubesub/issues/56)（fronier 起点，阻塞其余四票）
- [ ] [字幕桥接：播放器字幕稳定接到本地的实现重构](https://github.com/CometDash77/youtubesub/issues/57)（blocked by 基线落盘）
- [ ] [断句：原句切成可读句子的实现重构](https://github.com/CometDash77/youtubesub/issues/58)（blocked by 基线落盘）
- [ ] [批量与提前翻译：提前批请求流程的实现重构](https://github.com/CometDash77/youtubesub/issues/59)（blocked by 基线落盘）
- [ ] [时间轴对齐：译文与原句对齐显示的实现重构](https://github.com/CometDash77/youtubesub/issues/60)（blocked by 基线落盘）

五票全部关闭 = 全链重构完成且黄金基线验收通过 = 地图到终点。

## Decisions so far

（暂无——地图刚 charting 完，还没有票被解决）

## Not yet specified

- 重构过程中若冒出需要维护者拍板的行为取舍（某句断句边界、某处显示口径之类），单独立票再议。
- 测试里哪些重复最值得合并成共享夹具：等基线落盘、真正动手时看清楚了再定。

## Out of scope

- 架构重设计、换技术栈——架构不变是本次 destination 的前提。
- docs/、ADR、CONTEXT.md、PROGRESS.md、指令层（AGENTS.md / docs/agents/*）——决策资产与历史记录，不碰。
- 新功能与任何行为变更——行为不变是验收口径的前提。

## 进度：30%

下一步：从「重构前黄金基线落盘」开始逐票推进（后续 session 领票执行）；五票未全部关闭前，本 map 不得 close。

