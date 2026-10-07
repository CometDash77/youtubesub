# CONTEXT — youtubesub (自包含, 新 session 从这里读起)

## 事实
- 用户工作目录 D:\Documents\vibe 建项目时为空; 落地目录为 `d:\Documents\vibe\youtubesub`. 现为 **git 仓库** (origin: github.com/CometDash77/youtubesub, 分支 master; 早期"不是 git 仓库"的记录已过时)。
- 本机: Windows 10, Node 22.23.1, Python 3.12.10 (pytest 9.1.1 / websockets 16.1.1 / requests / PySide6_Essentials 6.11.2 已装)。无 Rust/.NET。
- 浏览器: Chrome **153.0.8010.48** 位于 `C:\Program Files\Google\Chrome\Application\chrome.exe`; Edge 153。
  Chrome User Data 里**没有 Tampermonkey** (未装任何扩展) -> "真 Tampermonkey" 场景需要用户手动装。
- DNS 污染, 直连 YouTube 失败; 代理 `127.0.0.1:10809` 可用 (实测 youtube.com 200)。环境变量已设 HTTP(S)_PROXY 与 NO_PROXY=localhost,127.0.0.1,::1,...。
  凡访问公网的 HTTP 客户端必须代理感知; loopback 流量不走代理 (测试里用 `http.client` 最稳, `urllib` 会读代理环境变量)。
- 实测: 裸 `https://www.youtube.com/api/timedtext?v=...&lang=en` (无 pot) -> 200 且 **0 字节** -> 印证必须页内复用播放器带 pot 的请求。

## 访谈结论 (grill-with-docs, 已锁定)
- 桌面栈: Python + PySide6.
- 浏览器端: Tampermonkey 用户脚本.
- AI 凭证: 用户稍后提供真实 Key/BaseURL/Model; 在此之前用 Mock 翻译服务验证链路, AI 成功场景记为部分验证。

## 术语 (跨票共用; 讨论时按此用词)
- **预取 (prefetch)**: 调度行为 —— 在播放点到达之前把前方尚未播出的句子组送去翻译, 使到达时译文已就绪或已在途。
- **批量 (batch)**: 请求形态 —— 把多个句子组放进**同一次** provider 请求。
- **智能上下文**: 默认开启的提示词上下文，由视频标题、简介和带时间戳的全轨字幕组成；每批共享固定分节 system prompt，过长轨道按播放点双锚截断。旧 ADR-009 的 ±1 邻组语义已被取代；批次与预取仍是正交概念。详见 [ADR-009](docs/adr/ADR-009-context-window-and-cache-identity.md)、[ADR-010](docs/adr/ADR-010-prompt-presets-and-composition.md) 与 [ADR-007](docs/adr/ADR-007-batch-request-contract.md)。
- 两者正交、可独立取舍。注意参照实现 kiss-translator 的 `batchSize=20` 是它 DOM 段落翻译的通用参数, **与字幕预取无关** (取证见 #3); 讨论"批大小"时先确认说的是哪一个。
- **翻译命名空间 (provider namespace)**: 一个 cache identity 值 —— 把逐句字段 (clientKey / prompt) 留空后算出来的那个, 只由 provider 配置 + 系统提示词决定。同一命名空间内按各句自己的 identity 命中缓存, 跨命名空间绝不命中。`mock` 是它的一个维度 (ADR-008), 所以"勾 Mock 跑过的句子"与"真实 provider 的同一句"是两个命名空间; 命名空间变动时内存里的旧译文同样作废。

### 浮窗右键菜单（#172；术语 + 文案，不含实现）
- 菜单挂在 [desktop/app.py:481](desktop/app.py#L481) 的 `_menu()`, **托盘与浮窗右键共用同一个 QMenu 对象**（[desktop/app.py:444](desktop/app.py#L444) / [desktop/app.py:448](desktop/app.py#L448)）—— 改任何一条文案要同时看托盘侧断言。
- 菜单条目（2026-10-04 起全中文，每条自带"点一下会怎样"）：`隐藏浮窗` / `显示内容：原文 / 译文 / 双语（点一下换下一种）` / `上下顺序：原文 ↔ 译文（点一下对调）` / `字号调大` / `字号调小` / `背景调浓` / `背景调淡` / `鼠标穿透（开启后点不到浮窗，Ctrl+Alt+U 解锁）`（开态改为 `鼠标穿透：已开启（Ctrl+Alt+U 解锁）`）/ `设置……` / `调试……` / `退出程序`。
- 「背景调浓 / 调淡」= 改的是 `display.bg_opacity`（浮窗底板不透明度），不是窗口透明度；「鼠标穿透」= 既有 click-through（`Ctrl+Alt+U` 是唯一解锁回路）。
- 文案三处照抄在别处，改菜单文案必须同步：[README.md:19](README.md#L19)、[docs/MANUAL-ACCEPTANCE.md:54](docs/MANUAL-ACCEPTANCE.md#L54)、[start-desktop.cmd:4](start-desktop.cmd#L4)。
- 注：浮窗菜单是**独立表面**，地图「设置调试合并 map」的整窗文案判据不覆盖它。
- 更正（2026-10-06，地图 #164 / 落地票 #170 已落地）：菜单里的 `设置……` / `调试……` 是**同一个**「设置与调试窗口」的两个入口，分别落到设置页与调参页（见「设置与调试窗口」一节）。

### 调试窗口（地图「调试设置前端 map」；术语，不含实现）
- **调试窗口**: 桌面端一个独立、非模态的窗口，含调参页与排障页两页。作用范围仅限该窗口本身，现有「AI 翻译设置」对话框与浮窗不在其内。
- **调参页**: 调试窗口里的**可写**一页 —— 改设置并落盘生效。归属「调参页字段清单与保存 / 生效语义」票。
- **排障页**: 调试窗口里的**只读**一页 —— 观测运行状态与错误，不改任何配置、不新增任何后端信号。它消费的是**公开的 `/status` 接口**，因此它观察到的"连不上"是关于服务是否活着的结论，而不是它的前提。
- **事件留痕**: 排障页在**本页内存**里记下的事件（状态翻转，带时间戳），关窗即弃。**不是「日志」**（不落盘、跨会话不留）、**不是「快照」**（不导出、不归档）。已知边界：只看得见**本页打开之后**的事件。
- 更正（2026-10-06，地图 #164 / 落地票 #170 已落地）：**上一条起，上面那个「两页调试窗口」与「AI 翻译设置对话框」的划分已作废** —— 模态对话框作为外壳被删除，能力搬进新的一页，窗口本身成为桌面端**唯一**的设置 / 调试入口面。上面四行保留作历史；当下的说法见本节末尾的「设置与调试窗口」几条。
- **设置与调试窗口**: 桌面端**唯一**的设置 / 调试入口面 —— 一个非模态无边框窗口，三页「设置 / 调参 / 排障」（`PAGES = ("settings", "tuning", "diag")`，[desktop/suboverlay/debug_window.py:35](desktop/suboverlay/debug_window.py#L35)）。菜单两个入口开的是**同一个实例**、只落到不同初始页。设置页在 [desktop/suboverlay/settings_page.py](desktop/suboverlay/settings_page.py)（原来的 `SettingsDialog` 已整份搬进去并删除）；浮窗仍不在其内。
- **设置页**: 三页里的**可写**一页 —— 凭据（接口地址 / 密钥 / 模型名 / 接口协议 / Mock 模式）、提示词（用哪套 / 内容 / 实际发出去的预览 / 携带上下文）与「测试连接」。它的写通道恰好是 8 个字段（`SettingsPage.STATE_KEYS`，[desktop/suboverlay/settings_page.py:59](desktop/suboverlay/settings_page.py#L59)）；`provider.*` / `prompt.*` **不进** `TUNING_FIELDS` 权威表（表外键 `apply_edits` 会 raise，[desktop/suboverlay/settings.py:221](desktop/suboverlay/settings.py#L221)）。
- **调参页（16 项）**: 三页里的**可写**一页 —— 按三组渲染权威字段（显示 / 网络与服务 / 实验（未校准））。`display.font_size` 自 #167 起也在表内，所以调参页现在 16 项、字号不再属于设置页。
- **整窗页脚**: 「保存 / 取消」只有窗口级一份（页内不再各有确定 / 取消）。保存 = 两页各自把改动套用到**同一份** settings 后**只写盘一次**（原子写盘 `settings.save`）；取消 = 两页都回到那份 settings 的当前值，不写盘、不动浮窗。`Ctrl+S` = 保存且**不关窗**，`Esc` = 关窗。
- **脏状态**: 「脏 = 会落盘的编辑」。调参页用 `settings.collect_edits`（值相等不算脏，不是 dirty flag）；设置页自建 8 字段快照（`presets` 用 json 规范化后比较）。窗口级只暴露 `is_dirty()` / `dirty_counts()`（[desktop/suboverlay/debug_window.py:170](desktop/suboverlay/debug_window.py#L170)）；排障页**永不参与**。关窗时若还脏，先弹三选一（默认「回去继续改」，见 [desktop/suboverlay/debug_window.py:61](desktop/suboverlay/debug_window.py#L61)）—— 选它时什么都不停，因为排障页重启取数的挂点只有 `showEvent`。
- **再快照挂点**: `DebugWindow.showEvent`（首次显示时）重新取基线 —— 窗口实例被 App 永久复用，构造时那一次快照早就过期。
- **事件留痕**: 排障页在**本页内存**里记下的事件（状态翻转，带时间戳），关窗即弃。**不是「日志」**（不落盘、跨会话不留）、**不是「快照」**（不导出、不归档）。已知边界：只看得见**本页打开之后**的事件。


### 浮窗外观键（#174；术语 + 键表形状，不含实现）
- **外观键族（6 键，全落 `display.*`）**: 字体族 1 键 + 颜色 4 键（原文 / 译文各一对：字身色 + 描边色）+ 预览字号 1 键。键名与形状由 [#174](https://github.com/CometDash77/youtubesub/issues/174) 定案（细节只在该票的 Answer 区）；本块只钉用语。
- **字身色（`orig_text_color` / `trans_text_color`）** 与 **描边色（`orig_stroke_color` / `trans_stroke_color`）**: 地图「浮窗外观细调与透明实时预览 map」里的「内填充 / 外填充」指的就是**字的填充色**与**描边圈的颜色**，**不是**两层底板 —— 底板仍是 `display.bg_color` + `display.bg_opacity`，没有第二层。
- **预览字号（`preview_font_size`）**: 只影响「调参 → 显示」组顶部那块透明预览画布，**不动浮窗**；浮窗字号仍是 `display.font_size`（译文行按既有 1.25 比例放大，不改）。
- 颜色一律存**三元素 int list（RGB，无 alpha）**: 与既有 `display.bg_color` 同形，取色器与 `_clamp_channels` 直接可用；alpha 不入键，底板浓淡只由 `display.bg_opacity` 表达。
- **回退式兼容**: 老配置没有这 6 个键是**正常状态**，不是损坏 —— 浮窗按今天硬编码的观感画，调参页显示表默认值，保存时只写真正被改过的键；不强制迁移。
- **失败态红（`#FF5A5A`）不在键族内**: 译文失败那几行恒红，是既有契约（[desktop/tests/test_overlay_labels.py:154](desktop/tests/test_overlay_labels.py#L154)），用户自定义字色只管正常那几行。 译文的状态占位行（等待 / 翻译中 / 未配置）算正常行、吃 `trans_text_color`；原文侧占位行吃 `orig_text_color`；失败行描边照常吃 `trans_stroke_color`。
- 用语落定后：`display.stroke`（描边宽度）不再只管「黑边」—— 描边色可调，宽度为 0 时看不到描边。上一条「调参页（16 项）」在 6 键落地前仍是当下事实，落地后为 22 项。

## 许可证边界
- dkitle: Rust 端无 LICENSE (GitHub license:null) -> 只参考设计, 不抄代码; 其 userscript 有 @license MIT 头, 可改写适配。
- yt-dual-subs: MIT -> 可改写复用 (保留版权). transly: MIT -> 设计吸收为主, 建议 clean-room Python 重写。
- LiveSubs / local-screen-translator: Apache-2.0 -> 可复用 (保留声明, 改动注明)。

## 研究报告 (recon 要点已折入 docs/DESIGN.md)
- dkitle: 线协议 + 桌面时钟模型 (primary). 缺陷: gap-hold 无 TTL / 重连回放旧 sync 带新 timestamp / 无 SPA 处理 / /ws 无鉴权.
- yt-dual-subs: pot 复用抓轨 / parseJson3(lastOff) / lastOff 分句 / trans 随 cue / nearestTcue 1200ms / 对齐协议与校验 / lane 模型与实测常量.
- transly: 配置 schema 与 Key 边界 / protocol auto 适配 / SSE-or-JSON 检测 / 缓存 identity SHA-256 / 单一并发权威 / 严格对齐校验. 缺: 重试/backoff/429/队列取消.
- LiveSubs: WPF 浮窗 PORT PLAN (12 条, Qt 版). 注意: 透明度双重相乘 bug 不要学; click-through 要补解锁路径.
- local-screen-translator: DOM 回显是错误架构, 仅复用 LRU/dpi/overlay flag 思路; localhost sink 教训: JSON + Origin 检查.

## 双模型维护环境 (DeepSeek-V4.1-Flash 与 MiMo-V2.6)

- 本项目由两家 agent 共同维护; 模型 id: DeepSeek 侧 `deepseek-flash`, MiMo 侧 `mimo-v2.6-flash`。
- 指令层双模型约定入口: [AGENTS.md](AGENTS.md) 的「双模型维护环境」章; 任何指令层改动须逐条过 [docs/agents/dual-model-checklist.md](docs/agents/dual-model-checklist.md) (纯静态核对)。
- `harness/` 是 DeepSeek Harness 运行时专属, 不在双模型维护范围内。

## 状态 (详见 PROGRESS.md 与 `.scratch/handoff/` 下最新交接文档, 随做随更)

**⚠ 2026-09-22 刷新快照 (对应代码提交 81cf035)** —— 与下方旧条目冲突时以本块为准; 旧条目按"增量并列"保留不改写。

- pytest **215 passed / 0 failed / 0 skipped** (~35s); node **46 pass / 0 fail**; `userscript/youtubesub.user.js` **665 行**,
  测试台 `userscript/tests/userscript.test.mjs` 1025 行。下方「pytest 88 passed」「Node 测试台: 38 passed」「userscript 现在 471 行」
  「#22 代码尚未改动」「#24 代码尚未改动」等条目**已过期**。
- **注入自证 (issue #41, 2026-09-22)**: 三级回退之上, 注入到主世界的代码在挂好 fetch/XHR 后回发 `youtubesub-hook-ready` (带 `level` / `entries`),
  每一级等 500ms 回执, 无回执即判该级失败并试下一级; 注入调用不抛异常**不再**等于装上; 安装时机对齐 `@run-at document-start`。
  面板标记由 `[NO PAGE HOOK]` 改为 `youtubesub: NO PAGE HOOK - <级别: 原因>` (**不再显示成 connected**); 失败级别
  (`gm` / `script-element` / `direct-eval` / `sandboxed`) 同时经 `register.hook_error` → `/status` 上浮。协议口径见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。
- **`/status` 多一个可选键 `connection_test`** (issue #23): 最近一次「测试连接」报告的完整 JSON; 不落盘, 重启消失。
- **2026-09-21~22 已落地并入库**: #22 断句判据 ([ADR-006](docs/adr/ADR-006-segmentation-aligned-with-kiss.md)) / #24 预取窗口+批请求 ([ADR-007](docs/adr/ADR-007-batch-request-contract.md)) /
  #38 预取与上下文解耦 ([ADR-009](docs/adr/ADR-009-context-window-and-cache-identity.md)) / #39 提示词预设 ([ADR-010](docs/adr/ADR-010-prompt-presets-and-composition.md)) /
  #23 测试连接两步契约 ([ADR-005](docs/adr/ADR-005-connection-test-same-path.md)) / #31 mock 身份维度 ([ADR-008](docs/adr/ADR-008-mock-is-a-cache-identity-dimension.md)) /
  #40 Key 明文存盘并明示 ([ADR-011](docs/adr/ADR-011-api-key-plaintext-storage.md)) / #41 注入自证。
- **仍未验证**: 真 Tampermonkey (L3; #41 之后无论成败都给可判读结论 —— 要么抓到字幕, 要么面板与 `/status` 点名失败级别) 与
  真实 AI Key 翻译链路 (L4, 等 Base URL+Key+Model)。真实 youtube.com「抓不到 cue」**已定论为 headless 指纹** (见下方下一步第 2 条), 不再是未定论项。

- 桌面端全部实现完毕; **pytest 88 passed** (~20s)。含真实 WS 集成、引擎全管线(mock)、浮窗 resize 回归、
  /health 与 /status 路由、无 provider 不泄露、provider 抛错不 500、跨语言解析夹具 11 例、
  **真浏览器 E2E 7 条 (夹具页 + 真 userscript + 真 app.py, 只经 /status 黑盒观察; 无 Chrome 则 skip)**、热键 4 条、浮窗状态 2 条。
- **Node 测试台: 38 passed** (命令 `cd userscript; node --test "tests/*.test.mjs"`; 传目录会 MODULE_NOT_FOUND)。
  共享夹具 `userscript/tests/fixtures/parse_cases.json` 被 JS 与 Python 两侧断言同一份内容 (解析一致性)。
- userscript 现在 **471 行**。上一轮修了 3 处: (1) 去重改为内容签名 (`cuesSignature`) —— 修"同 cue 数不同轨道被误判为重复";
  (2) 无 GM_xmlhttpRequest 时 health 回退为直接尝试 WS; (3) `trackLangFromUrl` 优先 tlang。
- userscript E2E 会话再改: 注入改为 **Trusted Types 感知的三级回退** (GM_addElement → trustedTypes policy → 主世界 new Function,
  最后一级若身处沙箱则主动跳过以免装进错的 realm); 新增 `hookError` 状态 + 面板 `[NO PAGE HOOK]` 标记 + register 帧携带 `hook_error`。
  根因是真实 youtube.com 上 `el.textContent = code` 被 `require-trusted-types-for script` 拒绝, 页面钩子静默失败 (详见交接文档 §2 bug#4)。
- 浮窗已真实运行并经假浏览器驱动验证 (截图像素证据: 原文白字+译文黄字均渲染; 暂停后清空)。
- 用户反馈已修: 无窗口尺寸限制; 字号下限6/默认10可设; 放大后无法缩小的 resize bug (按下锁定边缘)。
- **`GET /status`**: `{ok,version,stats}` + `state/orig/trans/trans_available/playing/rate/title/mode/order/history/click_through/hook_error/capture_error`。
  用途: 不截图就能看"连上了吗/浮窗在显示什么"; 也是浏览器 E2E 的黑盒观察口。会回显字幕文本 (仅 loopback, 无 provider 时不回显)。
  `trans_available` = `_provider_usable` (显式 Mock, 或 base_url+model 非空), 浮窗据此在没有译文可显示时回退显示原文
  (issue #1: 行带常驻【原】/【译】标签; bilingual 两行之间恒画一条横向分割线; 没有 provider 的默认设置不再表现成空白)。
- ✅ **浏览器侧已在真 Chrome 里跑过** (E2E 7 条全绿 + `--demo`/`--live` 人工入口): 页面钩子在真实主世界抓到 timedtext、
  真实 Origin 过 WS 白名单、真 cue 走到浮窗显示态、play/pause/seek/rate/SPA 语义均经 `/status` 黑盒断言。
  该会话据此修掉 4 个真 bug (cues 清零时钟 / click-through 无解锁路径 / 菜单时序 / YouTube Trusted Types 静默失败)。
- ⚠ 仍未验证: **真 Tampermonkey** (本机没装扩展)、**真实 AI Key 翻译链路** (等 Base URL+Key+Model)、
  **真实 youtube.com 抓不到 cue 的根因** (注入成功、站点确实在发 timedtext、但 bridge 没抓到; 根因未定论, 用户已归入手动验收)。
- 手动验收入口: `docs/MANUAL-ACCEPTANCE.md` (四层); 一键启动 `start-desktop.cmd`; 依赖 `requirements.txt`。
- ✅ (2026-09-21) **断句判据已定**: 对齐 kiss-translator 的规则分支 (ADR-006 取代 ADR-004 的判据部分; 翻译单位不变), 规格 = issue「字幕断句判据对齐 kiss-translator（规格）」#22。**代码尚未改动**。
- ✅ (2026-09-21) **提前批翻译已定**: 预取改用**时间量纲** (默认 90 秒 + 组数硬上限 20), 触发保持事件原生增量 + seek 去抖 (不照搬它的 30s 扫描节流), **新增批请求** (只在填充爆发点同步切块, 全局连续编号 + 精确全覆盖, 失败整批作废交紧急补翻, 批内保留每组上下文以维持 cache identity 不变式), 在途请求一律不中断 (ADR-007)。规格 = issue「提前批翻译：预取窗口与批请求契约（规格）」#24。**代码尚未改动**。

- ✅ (2026-09-22) **提前批翻译已实现** (#24 落地): 预取窗口改按**时间量纲** (90 秒 + 组数硬上限 20, seek 去抖 400ms), 窗口填充按 ≤8 组/≤8000 字符**切批**、队列**批感知**取活 (剔已缓存/在途, 剩一退单), 批失败**整批作废**交紧急补翻, 预取与上下文开关解耦, `provider.max_concurrent` 接到 worker 池; 契约见 [ADR-007](docs/adr/ADR-007-batch-request-contract.md)。上一条「代码尚未改动」与「下一步 6」至此过期。
- ✅ (2026-09-21) **#31 已修**: Mock 回显与真实译文不再共用缓存身份 (mock 进 identity, 身份方案版本 1 -> 2, 见 ADR-008); 队列任务改为携带提交时的 provider 快照与命名空间, 命名空间变动时内存里的旧译文作废并重取, 晚到的旧命名空间结果被丢弃。升级后本地缓存全量失效一次 (旧库里两类行同 key, 无法只作废被污染的那类)。**待人工验收** (L4: 勾 Mock 跑一句 -> 取消勾选 -> 同一句必须真实请求)。
- ✅ (2026-09-24) **#128 中文原文前置跳过已实现并关闭**: `track_lang` 的 `zh` 标签优先；缺失时 Han 表意字占字母字符 ≥30% 本地兜底，假名/韩文字母（含半角）不会由兜底误判。引擎单条与批量共用提交边界拦截；无论翻译开关/provider 可用性均不提交模型，沿用 `idle`；切轨晚到结果/失败态也会丢弃。维护者确认验收，接受全量桌面套件中已记录且单独重跑通过的既有 seek-gap E2E 时序失败。专项 pytest 13 passed、userscript 38 passed/0 skipped；完整桌面结果 254 passed/1 E2E failed。协议、规格与证据：[docs/PROTOCOL.md](docs/PROTOCOL.md)、[docs/SPEC.md](docs/SPEC.md)、[桌面输出](.omo/evidence/issue-128-142-pytest-final.txt)、[userscript 输出](.omo/evidence/issue-128-142-userscript-tests.txt)、[代码审查](.omo/evidence/issue-128-142-code-review.md)。

## 下一步 (断点, 完整清单见 `.scratch/handoff/` 下最新交接文档 §5)

- (2026-09-22 刷新) 旧第 5 条 (#22 断句实现) 与第 6 条 (#24 实现) **均已完成** (67f00c8 / 3aa1e95); 当前唯一待确认项是 **#41 的 L3 真 Tampermonkey** (维护者手跑, agent 不装扩展、不代跑)。
0. **(已落盘, 待裁决)** P0 思维对齐: `.scratch/alignment/20260921-112756-E2E与手测入口.md` (D/K/C/O/F + 可疑遗漏 A/B);
   O 类与 A/B 类的"请裁决"项仍待用户回答。**不要重做对齐**。
1. 用户按 `docs/MANUAL-ACCEPTANCE.md` 手动验收 (L1 夹具演示 / L2 真实站点诊断 / L3 真 Tampermonkey / L4 真实 Key)。
2. (已定论 2026-09-21) "真实 YouTube 抓不到 cue" = **headless 指纹**, 不是产品缺陷: headless 下 youtube.com 给 `200 + text/html + 0 字节`,
   headed 下同一 URL 给 `200 + application/json + 8079 字节`、桥接 61 条 cue、浮窗显示真实歌词 + 【译】。
   所以 `--live` **不要加 `--headless`**; 失败原因现在会以 `capture_error` 上浮 (浮窗状态行 + `/status` + 面板 `[NO CAPTION BODY]`)。
3. 剩余 P2 打磨: 历史字幕行渲染 / 打包分发 / 多标签 source UI。
4. 收尾双轴评审: 当时本项目还不是 git 仓库、没有 fixed point, 故改为对交接文档 §1 的文件清单评审 (需用户确认这种替代)。**注: 仓库现已建立并有提交历史, 此事可用 git fixed point 重议**。
5. (2026-09-21 新增) 断句判据对齐 kiss 的**实现**尚未开始: 规格 #22 (ready-for-agent) → 拆票 → 逐票实现 (TDD); 验收按规格里的判据表。
6. (2026-09-21 新增) 提前批翻译的**实现**尚未开始: 规格 #24 (ready-for-agent) → 拆票 → 逐票实现 (TDD)。注意三个上限默认值 (组数硬上限 / 批组数上限 / 批字符上限) 目前**无实测依据**, 要等真实 Key 到位后用"译文就绪率"校准。
