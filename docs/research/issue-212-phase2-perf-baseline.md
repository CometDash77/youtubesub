# #212 Phase 2 性能预算定标：Electron 浮窗现状基线取证

> 票: CometDash77/youtubesub#212 (wayfinder:research) · 父票 #181 · 下游 #214
> 日期: 2026-10-13 · 机器: Win10 19045.6466 · Electron 44.6.0 (Chromium 内核 CDP 合成输入)
> 方法: 真实产品栈（`app/` TS 栈，非 stub）+ CDP 控制驱动 + WS 帧注入；微基准与真机探测双通道
> 继承: #186（PySide6 判据作废，维度延承）· #154（本机实测范式，Win10 acrylic 禁用结论）

## 1. 研究问题

票面三项取证维度（自 #186 延承、按 TS 栈重定）：

1. **空转开销** — 浮窗 idle 与 cue 活跃期间的成本（CPU/内存/帧率）
2. **字幕渲染路径延迟** — cue 更新 → 上屏的端到端延迟
3. **悬停/穿透切换开销** — pointer 进出热区 → 状态翻转的延迟

产出为**档位建议**（供 #214 三态动效定案逐条对照；定案权在 #214，本票只供预算闸）。

## 2. 产物与复现

| 产物 | 路径 |
|---|---|
| 真机探测脚本 | [.scratch/wayfinder/research/phase2-perf/probe-real.mjs](../../.scratch/wayfinder/research/phase2-perf/probe-real.mjs) |
| 页面注入埋点 | [.scratch/wayfinder/research/phase2-perf/instrument.js](../../.scratch/wayfinder/research/phase2-perf/instrument.js) |
| 微基准（Probe M） | [.scratch/wayfinder/research/phase2-perf/micro/](../../.scratch/wayfinder/research/phase2-perf/micro/)（main.cjs / results.json） |
| 最终真机数据 | [.scratch/wayfinder/research/phase2-perf/run-1791855264670/](../../.scratch/wayfinder/research/phase2-perf/run-1791855264670/)（results-watchdog.json / progress.log / skeleton-probe.log） |

探测流程：spawn `app/node_modules/electron/dist/electron.exe .`（私有 APPDATA + YOUTUBESUB_DATA_DIR 隔离，CDP 9223）→ 相位 A idle 10s → B WS 注入 cue 静态 10s（Origin `https://www.youtube.com`，`register/sync/cues`）→ C cue 换文本 40 次 → D 穿透态 hover 热切换 20×2 次 + 解锁点击。CPU 由外部 1s 轮询 `Get-Process` 采样；帧率/Mutation 由页面内 rAF 循环 + MutationObserver 记账。

## 3. 实测结果

### 3.1 四相总表（真机 380×64 产品窗，n=帧样本数）

| 相位 | CPU（全进程 percentCPUUsage 求和） | 内存 | rAF p50 / p95 | >25ms 缺帧 | 备注 |
|---|---|---|---|---|---|
| A idle（无 cue 源） | 3.35% | 331.8MB | 16.70 / 17.50ms | 0 | plans=0 |
| B cue 静态显示 | 11.59% | 350.1MB | 16.70 / 17.30ms | 4（首帧 hitch max 77ms） | planPushes 217/10s |
| C cue 换文本 ×40 | —（合并在 B 流） | — | — | — | 延迟见 3.3 |
| D 穿透态 hover 切换 | 17.56% | 369.9MB | 16.70 / 17.60ms | 0 | hot 20/20 + cold 20/20 全命中 |

四进程拆分（B 相）：Renderer 6.05% / Browser 5.36% / GPU 0% / Utility 0%。内存拆分：Browser ~114MB、GPU ~108MB、Utility ~45MB、Renderer ~83MB。

### 3.2 关键机制发现

1. **tick 33ms 设计意图在 Windows 真机降级为 ~21.7Hz**。三轮复现：planPushes 220/208/217 per 10s，间隔 p50 46/47/46ms ≈ 3×15.625ms（Windows 定时器格），jitter max 58–101ms。代码：tick setInterval 33ms [app/src/main/main.ts:401-407](../../app/src/main/main.ts#L401-L407)。**含义：plan 推送流不能当帧同步源用**——动效必须走 CSS transition/compositor，与推送解耦。
2. **每次 plan 全量 DOM 重建，内容不变也推**。`pushPlan` 每次全量 `paint_plan` [main.ts:85-87](../../app/src/main/main.ts#L85-L87)，renderer `rowsEl.textContent=""` 整树重建 [app/src/renderer/renderer.ts:62](../../app/src/renderer/renderer.ts#L62)；MutationObserver 实测 muts ≈ 4×pushes（876 vs 217）。这是 B 相 +8.2% CPU 的主要来源（renderer 1.66%→6.05%）。
3. **帧步调完全不受内容推送影响**。全相位 rAF p50 恒 16.7ms、p95 ≤17.6ms；唯一 >25ms 缺帧是 B 相开播瞬间（max 77ms，n=4）——cue 注入后首个 plan 的 layout 尖峰，其后归零。
4. **现状动画面为零**：app/ 全域无 transition/@keyframes/will-change（grep 取证）；现有反馈全是即时属性变化（.cm-item:hover、body.ct 切换）。Phase 2 动效是纯增量。

### 3.3 延迟数据

| 指标 | min | p50 | p95 | max | n |
|---|---|---|---|---|---|
| **字幕端到端**（cue 发出 → renderer 上屏，含 WS→pump→tick→IPC→DOM 全链） | 23ms | **70ms** | **188ms** | 248ms | 40/40 |
| **悬停→热区翻转**（hot，进 .hot → set-ignore 日志） | 6ms | **14ms** | — | 43ms | 20/20 |
| **悬停→冷区回穿**（cold，出 .hot → set-ignore 日志） | 4ms | **10ms** | — | 33ms | 20/20 |

字幕延迟的量化解释：50ms pump [main.ts:387-398](../../app/src/main/main.ts#L387-L398) 与 46ms tick 两级定时器级联 + IPC + DOM，p50≈70ms 与两级中值期望一致。悬停链路（elementFromPoint→closest(".hot")→setIgnore [app/src/renderer/renderer.ts:113-128](../../app/src/renderer/renderer.ts#L113-L128)）为同进程渲染路径 + IPC invoke，10-14ms 与微基准 IPC RTT 0.1ms、setIgnoreMouseEvents 21.6µs 相符（差值是 CDP 合成事件测量开销，**此值为上限口径**）。

### 3.4 微基准（Probe M，独立 300×120 探测窗）

| API | 结果 |
|---|---|
| setIgnoreMouseEvents(forward:true) | p50 21.6µs / p95 33.9µs |
| setIgnoreMouseEvents(no-forward) | p50 18.4µs / p95 49µs |
| setPosition / setBounds | p50 492.5 / 480.5µs |
| 托盘菜单重建 | p50 0.073ms（击穿「菜单重建贵」假设） |
| IPC RTT（invoke/handle） | p50 0.1ms / p95 0.2ms / max 0.8ms |
| 页内 DOM 重建（2 行 + 描边样式） | 低于 performance.now 分辨率 |
| CSS opacity transition 期 | Browser 进程峰值 2.06% 后回落 |

单次 API 全部微秒级——**贵在频率与重复，不在单次调用**。

## 4. 档位建议（移交 #214）

现状基线即安全余量的下限锚；建议预算闸（违闸 = 动效方案退回重定）：

| 指标 | 现状基线 | 建议预算闸 | 依据 |
|---|---|---|---|
| 动画帧率 | rAF p50 16.7ms 全相位 | 动效期间 rAF p95 ≤ 18ms 且 >25ms 缺帧 = 0/10s | §3.1；#186「动画帧率下限」 |
| 字幕端到端延迟 | p50 70 / p95 188 / max 248ms | 控制条/动效引入后 p95 ≤ 250ms、p50 ≤ 100ms | §3.3；#186「控制条出现不得增加字幕延迟」 |
| 悬停淡入时长 | —（现状无动效） | 淡入 ≤ 200ms（#186 延承上限） | #186 |
| 穿透/热区切换处理 | hot 14 / cold 10ms（合成上限口径） | 状态切换处理 p95 ≤ 50ms | §3.3 + 微基准 |
| CPU 增量 | idle 3.35% → cue 11.6% → hover 17.6% | 动效稳态增量 ≤ +5%（全进程口径） | §3.1 |
| 内存 | ~350MB（4 进程） | 动效引入后 ≤ +50MB | §3.1 |
| 推送节拍耦合 | 21.7Hz 实测（非 30Hz 设计值） | 动效帧源 = CSS compositor，禁止以 plan 推送为节拍 | §3.2-1 |

架构判据（#186「控制条出现不得增加字幕延迟」）现状天然满足：字幕路径为 main→renderer 单向 IPC（renderer→main 无回程依赖 [app/src/preload/preload.cts:9-28](../../app/src/preload/preload.cts#L9-L28)），控制条动效与字幕更新在 renderer 内正交。

## 5. 限制、坑与埋点缺口

**给后续自动化**：

- **#193 约束**：维护者机器不做可见 GUI 自动化 → 本探测全程 CDP 合成输入。CDP 合成 mousemove 在拖拽场景不稳定（90 连发中段静默 wedge，三轮未定位，progress.log 无 FATAL/UNCAUGHT），拖拽 FPS 未真机实测——其 API 成本已由微基准 setPosition 492µs 覆盖；真实指针拖拽帧率如 #214 需要，另行专项。
- **Electron 44 CDP 无 `Browser.getWindowForTarget`**（已移除）：窗口几何验证改读私有 APPDATA 的 `setting.json`（persistGeometry 落盘 [app/src/main/main.ts:236-273](../../app/src/main/main.ts#L236-L273)）。
- **cue wire 字段是 `start_ms/end_ms`**（[app/src/main/protocol.ts:19-27](../../app/src/main/protocol.ts#L19-L27)）：发 `start/end` 会被 coerce_cue 静默丢弃（end<=start → null）。
- **settings 隔离**：settings 走 `process.env["APPDATA"]` [app/src/main/settings.ts:379](../../app/src/main/settings.ts#L379)；YOUTUBESUB_DATA_DIR 只隔离翻译缓存 [main.ts:330-334](../../app/src/main/main.ts#L330-L334)。探测必须私有 APPDATA，否则拖拽会写真实用户配置。
- **产品窗实际 380×64**（settings.window 持久值，非验收骨架的 650×135）：合成输入坐标必须从 settings.window 动态推算（.hot 为 40×40 right/bottom 8px），否则 noReply 假象。

**埋点现状缺口**（Phase 2 验收自动化前需补）：

- 已有：首帧 painted 锚（rAF×2 → "renderer painted" [app/src/renderer/renderer.ts:35](../../app/src/renderer/renderer.ts#L35)，消费方 [app/acceptance/run-verification.ps1:185](../../app/acceptance/run-verification.ps1#L185)）。
- 缺失：CPU/内存采样（app/src 与 tests 全域无 getProcessMetrics 消费）、帧率/掉帧断言、node --test 无窗口级时序断言（现有 E2E 仅 /health /status 黑盒轮询 [app/tests/browser/browser-e2e-harness.ts:562-659](../../app/tests/browser/browser-e2e-harness.ts#L562-L659)）。本探测的 instrument.js + probe-real.mjs 可作为验收埋点蓝本。

## 6. 结论

现状（零动效 + ~21.7Hz 全量重建推送）帧率健康、延迟由两级定时器量化决定、单次 API 成本可忽略。Phase 2 三态动效的安全落点：**CSS compositor 动画（transform/opacity）+ 现有单向 IPC 拓扑不动**；风险点唯一——rows 全量重建叠加动画时的 layout 抖动未实测，留给 #214 原型验证（对照 §4 帧率闸）。
