# ADR-014: 设置/调试窗口显示层引入 Web Awesome Core 增强层（vanilla 主干保留）

状态: 已接受（2026-10-13；裁定依据 [Phase 2 组件库重选取证](https://github.com/CometDash77/youtubesub/issues/210) = `wayfinder/component-library-reselection-ts.md` 主推荐 + [原型：Web Awesome Core 组件进设置页](https://github.com/CometDash77/youtubesub/issues/220) 三项验收全绿；本 ADR 的落盘票为 [落盘 ADR-014：引入 WA Core 增强层](https://github.com/CometDash77/youtubesub/issues/224)；迁移实施票 [Phase 2 设置/调试窗口迁移实施](https://github.com/CometDash77/youtubesub/issues/216) 已完成并二次实证本 ADR 的供给与回滚方式）.

背景: 地图 [全项目 TypeScript 重构 map](https://github.com/CometDash77/youtubesub/issues/181) 的 Phase 2 destination 要求显示层统一落在重新选定的组件库上（裁定标准：动画更流畅 + 维护积极，继承自 #182）。[取证票 #210](https://github.com/CometDash77/youtubesub/issues/210) 在 TS 栈上逐库评估（留任 vanilla / WC 路四家 / React 系六家）后主推荐 = **留任 vanilla 为主干 + Web Awesome 作为设置/调试面的增强层，经原型票验证后按 ADR 落地**；其中「Electron `file://` 下 autoloader/资源 base path」是取证标记的唯一未知项。[原型票 #220](https://github.com/CometDash77/youtubesub/issues/220) 三项验收全绿消除了该未知项（见证据节），据此落盘本 ADR。

决定:
- **裁定：引入增强层，主干保留**。设置/调试窗口显示层引入 `@awesome.me/webawesome` **Core**（MIT，本仓 vendored 3.14.0）作为**增强层**；vanilla DOM + CSS/WAAPI 主干保留——字幕浮窗 renderer（`app/src/renderer/renderer.ts`）保持 import-free 不动（组件库在该面增益≈0，窗口能力已由 ADR-013 的 Electron API 覆盖）。
- **仅 Core 准入（Pro 红线）**：表单基础控件全在 Core；Pro 组件（付费层，文档带明确 Pro 标记）一律不进仓。vendored 副本只含 Core 代码（`VENDOR-NOTE.md` + `LICENSE.md` 记录，Fonticons, Inc. 版权）。
- **vendored 供给（无打包器消费）**：不新增 npm 运行时依赖，`dist-cdn` 自包含子集 vendor 进仓——子集落 `app/src/renderer/vendor/webawesome/`（autoloader `webawesome.loader.js` + chunks + 7 个已迁移组件 button/input/select/option/switch/slider/textarea + internal/events/utilities helpers + 最小样式闭包 layers.css + themes/default.css + color/palettes/default.css；`native.css`/`utilities.css` 刻意排除——它们会重刷裸 HTML 元素、与手写卡片样式相抗）。子集边界记录于 `app/src/renderer/vendor/webawesome/VENDOR-NOTE.md`。
  - 类型隔离：`app/tsconfig.json` `exclude: ["src/renderer/vendor"]`——vendored `.d.ts` 的 `HTMLElementTagNameMap` 全局增强会污染 `el()` 的 keyof union（WA 类在这些声明里不 extend HTMLElement），`.js` 按原样消费，整目录不进类型程序。
  - 构建链：`app/scripts/build.mjs` `cpSync` 整树拷贝 `src/renderer/vendor` → `dist/renderer/vendor`（无打包器是 app/scripts/build.mjs:1 的 Phase 1 分拆决策，保持不动；#216 增补组件对该拷贝**零改动**，整树拷贝天然吸收子集增减）。
  - 引用面：`app/src/renderer/debug.html` 恰两处——`<link rel="stylesheet" href="./vendor/webawesome/styles/themes/default.css">`（:139）与 `<script type="module" src="./vendor/webawesome/webawesome.loader.js" data-webawesome="./vendor/webawesome/">`（:173–175，`data-webawesome` base 逃生口；module script 在 Electron 44 file:// 下已实证存活——debug-renderer 保持 classic script 的原因另有其人，见下方证据 4）。
  - **回滚方式**：删除 `app/src/renderer/vendor/webawesome/` 目录 + 摘除 `debug.html` 上述两处引用即回到纯 vanilla——零沉没成本（#220 失败分支的预设退路，未启用）。
- **边界**：本 ADR 只裁「引入增强层与否」；设置/调试窗口的具体迁移实施归 [票 #216](https://github.com/CometDash77/youtubesub/issues/216)（迁移中显示层语义约束不变：调参页 16 项、设置页 8 字段、collect_edits 脏判定、窗口级单份保存/取消、Ctrl+S/Esc、再快照挂点、wire/intent 协议零变化）。

证据（全部来自 [#220](https://github.com/CometDash77/youtubesub/issues/220) 实测：Electron 44.6.0 / Chromium 152，`file://`；截图 `.scratch/wf-session/issue220/debug-window-wa-card.png` 整卡自检全绿）:
1. **module autoloader 存活**：`<script type="module">` + `data-webawesome` base 逃生口在 file:// 下正常加载；5 tag 定义、8/8 实例升级 shadowRoot、零 CORS/零模块错误——取证唯一未知项就此消除。
2. **主题对齐工作量 = 一个 CSS token 映射块**：约 40 行、零 JS（#216 后上移 `#debugWindow`，`debug.html:31–74`，36 个 `--wa-*` 自定义属性，取值镜像 `src/main/debug/tokens.ts`）；品牌靛蓝 `#343E68` 全表映射生效（主强调 8.04:1）。
3. **backdrop-filter 磨砂探针实测 55–56 fps**（2s rAF 采样）——ADR-013「后果」节遗留的「Chromium backdrop-filter 是否达标由 Phase 2 原型票呈现」就此关闭（对比 #154 Win10 acrylic 掉帧禁用先例：达标的模糊路线可保留，不引入未文档化 API 的边界不变）。
4. **renderer import-free 约束双双保住**：module script 活性与 `tsconfig.build.json` 注释里「module scripts 被 file:// 阻断」的说法无关——那是 #204 的 tsc `export{}` 陷阱（`moduleDetection: legacy` 修复），不是 Chromium 规则；debug-renderer（`debug-renderer.ts:7–12`）与字幕 renderer 均继续 classic script + import-free，WA 组件以裸 custom element 消费（autoloader 升级，脚本只碰宿主元素属性）。
5. **冒烟常绿**：WA 冒烟挂 `app/tests/browser/browser-e2e.test.ts` 同通道（自研 CDP harness，非 puppeteer——原型票原文写 puppeteer，实际用既有 harness 等价承接）——断言 autoloader 发现完成、`__waScriptError` 为 null、5 tag defined、实例全量 upgraded、零 autoload 告警、控件可交互（#216 后含 debug 窗子测试 + 对抗探针 51/51 upgraded）。

理由:
1. **两个承载面判然有别**（取证报告 §4）：字幕浮窗的组件库角色最小（字幕行自绘且效果已验收），任何库增益≈0；组件库的真实战场只有 debug 三页的表单控件——手写 `el()` 的可访问性/键盘导航/动效一致性成本随页面数线性上涨，这正是增强层要接管的成本。
2. **Web Awesome 与本仓硬约束逐条对齐**：框架无关（与零框架 renderer 共存）；官方明文支持无构建工具消费（dist-cdn 自包含 bundle + autoloader，离线 vendor 路径成立）；Core MIT 且自托管/打补丁明文允许；0 peer、deps 轻且职能清楚；动画原语 = WAAPI + CSS（与现状同源，无新运行时）；月节奏发版（3.10→3.14，2026-06-30→09-24）+ Shoelace 血统的归档风险被 MIT 双重缓冲（Shoelace 先例：归档后代码仍 MIT 可用）。
3. **双标准对照**（动画更流畅 + 维护积极）：动画——`wa-animation` 官方 WAAPI + 组件 CSS data-state，与现状动画原语同源；维护——WA 月节奏，对比 Shoelace 归档 sunset、Fluent WC 49 天静默、Vaadin 活跃但无 bundler 消费代价最高。
4. **原型实证闭环**：三项验收全过才落「引入」，任一败即落「留任 vanilla」并关闭增强层轨道（取证报告 §7 触发条件）——走的是前者。

接受代价（明文记账，沿 ADR-012 口径）:
1. **vendor 体量进仓**：子集 531 个文件随仓版本管理（上游全包 unpacked 17.5 MB，vendored 子集远小于此；lit 底座 + 少量 helper 随 chunks 进来）；无 npm/lockfile 锁定，**升级 = 按 VENDOR-NOTE.md 手动重拷**（重新解包 tarball → 重拷同一子集 → 保留该说明与 LICENSE.md）。
2. **renderer 加载路径变化**：debug 窗从纯 classic script 变为 classic script + vendored ESM autoloader（module script）；两个 renderer 文件的 import-free 约束不因本 ADR 改变（组件零 import 消费）。
3. **两套控件风格并存**：vendored WA 主题 vs 手写 tokens——已由证据 2 的一个映射块解决（一次视觉对齐，成本实测约 40 行 CSS）。
4. **Pro 诱惑面**：表单基础控件全在 Core，但「仅 Core 组件准入」是长期红线（见决定）——引入前查文档 Pro 标记。
5. **上游断供风险**：vendored 副本 MIT 自托管不受上游归档影响（Shoelace 先例验证该风险已被许可缓冲）；断供只影响后续升级，不影响运行。

被否决的选项（取证报告 §5 逐条，本文档化保留翻盘依据）:
- **留任 vanilla 全量（不引入增强层）**：#220 三项全绿后增强层收益已实证可得，纯留任等于放弃已验证收益；但 vanilla 主干仍保留——本裁定是「vanilla 主干 + WA 增强层」，字幕面不引库。
- **Shoelace 2.20.1**：官方归档 sunset（README 原文 "no active development"），由 Web Awesome 接班。
- **Vaadin components**：源码级 ESM 无预打包 bundle + 逐包依赖树，无打包器约束下全场消费代价最高。
- **React 系六家（MUI/Mantine/AntD/Chakra/HeroUI/shadcn/ui）**：React 19 无 UMD + 本仓无打包器 → 必须引入「打包器 + JSX + 测试链」整层，为三个调试页支付整层不成立。其中 **Mantine** 依赖面最干净（deps 仅 5、无 CSS-in-JS 运行时）、维护周节奏——**若未来重开打包器决策，Mantine 是 React 路翻盘首选**（Vaadin/AI 组同随打包器重评）。
- **@fluentui/web-components**：WC 备选——v3 密集修复后 49 天无发版，节奏不稳定性是维护判据实质扣分；若恢复月节奏可按包内预打包 bundle 形态复活。

后果:
- 设置/调试窗口显示层已按本裁定迁移（[#216](https://github.com/CometDash77/youtubesub/issues/216) 完成：三页外壳与控件全量换 WA 7 组件，语义零变化，headless 403/403 + 真实 Electron E2E debug 窗子测试 + 对抗探针 51/51 upgraded 验证绿）；后续显示层改动以本 ADR 为组件库引用锚点。
- ADR-013「后果」节的 backdrop-filter 遗留项**就此关闭**：磨砂/模糊路线在 Chromium 上达标（55–56 fps），#154 先例的禁用范围收窄为「掉帧的 OS 级磨萨克隆路线」，不波及达标的 CSS backdrop-filter。
- ADR-012（PySide6-Fluent-Widgets，GPLv3）的显示层角色随 Phase 1 Python 栈退役（#207 整删 desktop/）终结；其「代价明文记账 + 被否决选项 + 翻盘点」的 ADR 结构由本 ADR 继承，GPLv3 分发约束随该库退役一并消失。
- 翻盘点（重开或收缩本决定的触发）：① 引入打包器 → React 路重评（Mantine 首选）；② WA 上游不可用/许可变化 → 回滚路径零沉没成本（删 vendor 目录 + debug.html 两处引用），vanilla 主干即时接管；③ 字幕浮窗面永不引入库（import-free 约束是本 ADR 的一部分）。
