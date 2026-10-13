# 组件库重选取证：TS 栈（Electron renderer）——动画流畅度 × 维护活跃度

> - 研究对象：GitHub issue [CometDash77/youtubesub#210](https://github.com/CometDash77/youtubesub/issues/210)（"Phase 2 组件库重选取证：TS 栈上动画流畅度与维护活跃度双标准选型"）
> - 前身：issue #182（PySide6/Fluent 取证，随 2026-10-13 Python/PySide6 栈整体退役而作废；**双标准判据保留**）
> - 取证执行：后台研究代理；取证日期 **2026-10-13**（Windows 10 22H2 / Node 22.23.1 / Electron 44.6.0）
> - 口径上游：ADR-012（候选矩阵 + 代价明文记账 + 被否决选项的结构）；ADR-013:29（"Phase 2 组件库按 ADR-012 同一口径逐库评估"）
> - 旧栈取证样本：[`.scratch/wayfinder/research/component-library.md`](<.scratch/wayfinder/research/component-library.md>)（#153，其维度组织被继承，结论仅适用于已退役的 PySide6 栈）

---

## 0. 问题与判据

### 0.1 双标准（继承自 #182）

1. **动画更流畅**：动效实现机制（内建动效系统 / CSS transition / 独立动画运行时）与有出处的主张；本仓 overlay 面已用原生 CSS + Electron API 落过一版，重点看候选库的动效原语与现状的兼容度。
2. **维护积极**：npm 最近发版时间与节奏、GitHub 最近提交/发版、issue 响应粗况（open issues 与 commit 节奏）。

### 0.2 判据映射（本节明写映射及理由）

| #182 / ADR-012 口径（PySide6 栈） | TS 栈对应判据 | 理由 |
| --- | --- | --- |
| 动画机制与流畅度证据 | 动画机制与流畅度证据 | 不变；TS 栈下动画原语 = CSS transition / WAAPI / JS 动画库 |
| 维护活跃度 | 维护活跃度 | 不变；数据源从 PyPI 换成 npm registry + gh api |
| 许可证 | 许可证 | 不变；GPLv3 代价已接受过一次（ADR-012 选 qfluentwidgets），本次逐库明文记账；Electron 为 MIT 无碍（ADR-013） |
| **PySide6-Essentials 兼容**（不强制拉 Addons） | **依赖传递面干净**：不强制拉入与用途无关的大依赖/重运行时（CSS-in-JS 运行时、全家桶 meta 包）；peer 依赖是否要求引入整层新栈 | 原判据的实质是"装 A 结果被迫装 B"；TS 生态的等价形态是 peer 强拉 emotion/Tailwind/React 全家，或 meta 包拖入无关子系统 |
| 离线可复现安装（lockfile 友好、无 postinstall 惊喜） | 离线可复现安装：lockfile 友好、无 postinstall 脚本、无 CDN 运行时强依赖 | 不变；本仓安装面从 pip/uv 换成 npm |
| offscreen pytest 影响 | 测试影响（node --test + puppeteer E2E） | pytest→node --test 的直接对应；DOM 组件测试的现实路径 = 既有 puppeteer E2E |
| 打包/启动 | 打包影响（unpacked size + **无打包器如何消费**） | 本仓 build = tsc + scripts/build.mjs，**无 bundler** 是 Phase 1 分拆决策（app/scripts/build.mjs:1）；库在无打包器下的消费方式是硬约束 |

### 0.3 候选集

- **留任现状（必含，诚实评估）**：不引组件库，vanilla DOM + CSS/WAAPI 续用（#153 的 B 路）。
- **Web Components / 框架无关**：Shoelace（已转 Web Awesome）、@fluentui/web-components（FAST 底座）、Vaadin components（Lit 底座）。
- **React 系**（"引入 React + 打包器 + JSX + 测试链"整层代价计入）：MUI、Mantine、Ant Design、Chakra v3、HeroUI、shadcn/ui（Radix/Base UI 底座，copy-in 模式）。

---

## 1. 现状与约束（仓库事实，已核实）

- **栈**：Python/PySide6 桌面栈 2026-10-13 整体退役删除（#210 背景已核实）；现行唯一桌面运行时 = **Electron 44.6.0（MIT）**，代码在 [`app/`](<app/package.json>)。
- [`app/package.json`](<app/package.json>)：`dependencies` 仅 `ws`；devDeps = electron 44.6.0、typescript ^7.0.2、@types/*；`build` = `tsc -p tsconfig.build.json && node scripts/build.mjs`；`test` = `node --test --test-concurrency=1 --test-force-exit --test-timeout=60000 "tests/*.test.ts"`；E2E = [`tests/browser/browser-e2e.test.ts`](<tests/browser/browser-e2e.test.ts>)（仓库根另有 puppeteer 依赖）。
- **renderer 零 UI 框架、无打包器**：
  - [`app/src/renderer/renderer.ts:12-13`](<app/src/renderer/renderer.ts>)："this file must stay import-free (classic script over file://, see tsconfig.build.json)"
  - [`app/src/renderer/debug-renderer.ts:6`](<app/src/renderer/debug-renderer.ts>)：同上
  - [`app/scripts/build.mjs:1`](<app/scripts/build.mjs>)："no bundler per the Phase 1 split decision"
- **两个承载面**：
  1. **字幕浮窗**（[`app/src/renderer/renderer.ts`](<app/src/renderer/renderer.ts>)）：半透明无边框窗、自绘字幕行（main 推 plan、renderer 只 apply；`div.style.*` 自绘，-webkit-text-stroke + paintOrder）。窗口级能力 frame:false / alwaysOnTop / transparent / setIgnoreMouseEvents 已由 ADR-013 用 Electron API 覆盖——**组件库在此面角色最小**。
  2. **设置/调试窗口三页**（[`app/src/renderer/debug-renderer.ts`](<app/src/renderer/debug-renderer.ts>) + [`app/src/main/debug/{settings-page,tuning-page,diag-page}.ts`](<app/src/main/debug>)）：手写 `el()` helper、表单类控件（设置/调参/排障）——**组件库的价值面在此**。
- **Electron 44 运行时**：Chromium **152.0.7977.54**、Node v24.18.1（Electron v44.0.0 release notes，2026-08-25 发布；本仓 pin 44.6.0）。Chromium-only evergreen：无跨浏览器 polyfill 负担，WAAPI/CSS 全量可用。
- 样式 token 现状：[`wayfinder/debug-window-style-tokens.md`](<wayfinder/debug-window-style-tokens.md>)（Chromium backdrop-filter 达标性由 Phase 2 原型票呈现，ADR-013:28）。

**由此推出逐库硬约束**：任何组件库引入都意味着 renderer 加载路径变化——要么 vendor 预打包产物 + `<script>`/module script，要么引入打包器（重开 build.mjs 决策）。**逐库必须回答"无 bundler 怎么消费"。**

---

## 2. 候选矩阵总表

数据源：npm registry（unpacked size、deps/peers、发版时间）与 gh api（repo 活跃度），全部取证于 **2026-10-13**。churn 上限：commits/90d 显示 "100+" 为 API 分页上限。

### 2.1 留任 / Web Components 组

| 候选 | 许可证 | 维护活跃 | 动画机制 | 依赖面 | 打包：unpacked / 无 bundler 消费 | 测试影响 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **留任 vanilla DOM + CSS/WAAPI** | 仓库自身 | 仓库自身 | 自担（CSS transition + 可用 WAAPI；Chromium 152 全支持） | **零** | 0 B；现状即无 bundler | node --test 不受影响；puppeteer E2E 已有 | **主推荐（基线）** |
| **Web Awesome**（@awesome.me/webawesome 3.14.0） | **MIT（Core）**，Pro 为付费层（support 页明文） | GitHub shoelace-style/webawesome：pushed 2026-10-07、v3.14.0 2026-09-24、月节奏（3.10→3.14：06-30/07-30/08-21/09-16/09-24）、open issues 86 | `<wa-animation>` helper **"Powered by the Web Animations API"**，~100 Animate.css 系预设 + 自定义 keyframes；组件自带动效走 CSS | deps 13（lit、@shoelace-style/animations、@floating-ui/dom、marked、nanoid 等），**0 peers** | 17.5 MB；**官方 dist-cdn 自包含 bundle"可直接无构建工具使用"** + autoloader；self-host = vendor dist-cdn | WC：组件单测需真浏览器（puppeteer 已有）；node --test 无影响 | **WC 路首选（增强层）** |
| Shoelace 2.20.1 | MIT | **已归档**：archived=true，README 明说 "**Shoelace is sunset.** There is no active development"，npm last publish 2025-03-11 | 同 WA 血统（@shoelace-style/animations） | deps 7，0 peers | 8.35 MB；dist/autoloader 同 WA | 同上 | **否决（归档停维护）** |
| @fluentui/web-components 3.1.3 | MIT | v3 2026-06-29 复活；8 月密集修复（3.0.3→3.1.3 于 08-05~08-25）后**至取证日 49 天无发版**；microsoft/fluentui monorepo 整体活跃（pushed 2026-10-12） | deps 仅 tokens/tslib → 无 JS 动画运行时，动效由组件 CSS 完成（本次未检索到专门动画系统文档） | deps 2；**peers：@microsoft/fast-element ^3、@microsoft/focusgroup-polyfill**（fast-element 本体未归档，v3.1.0 2026-10-09，commits/90d 53） | 5.25 MB（+fast-element 3.32 MB）；**包内带预打包 bundle**（exports `./web-components.js`/`.min.js`，unpkg 字段同）→ vendorable | 同上 | **备选（发版节奏存疑）** |
| Vaadin @vaadin/text-field / grid 25.3.3 | Apache-2.0 | vaadin/web-components 极活跃：pushed 2026-10-12、v25.3.3 2026-10-12、多分支并行（24.4/25.2/25.3/25.4-alpha）、open issues 925 | 依赖面无 JS 动画运行时（lit + @vaadin/* 内部包），动效由组件 CSS/themable mixin 完成（依赖面证据推断） | text-field deps 7、grid deps 8，0 peers | text-field 137 KB / grid 1.04 MB，但**源码级 ESM、无预打包 bundle**（manifest files=["src",...]）→ 无 bundler 下需 import map 覆盖 lit + @vaadin/* 全树 | 同上 | **否决（无 bundler 消费代价最高）** |
| lit 3.3.3（底座参照） | BSD-3-Clause | last publish 2026-05-14，~2-5 月节奏，commits/90d 9（稳定维护态） | —（底座） | deps 3，0 peers | 106 KB；纯 ESM | — | 仅作底座成本参照 |

### 2.2 React 系组（整层代价统一记账，见 3.5）

| 候选 | 许可证 | 维护活跃 | 动画机制 | 依赖面 | 打包：unpacked / 无 bundler 消费 | 测试影响 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **MUI** @mui/material 9.5.0 | MIT | 最强：last publish 2026-10-12、10.0.0-alpha.0 已发、commits/90d 100+ | react-transition-group（dep）JS 编排挂/卸载过渡（mui.com/material-ui/transitions/） | deps 12；**peers 强拉 @emotion/react + @emotion/styled** | 8.5 MB + emotion 双包；React 19 **无 UMD** → 必须打包器/ESM import map | 组件单测需 RTL+jsdom 或 puppeteer → 新测试链 | **否决（当前约束）** |
| **Mantine** @mantine/core 9.7.2 | MIT | 周节奏：9.6.2→9.7.2（09-21/09-26/10-05/10-06/10-11）、open issues 仅 21、commits/90d 100+ | Transition 组件：JS 编排 in/out 状态 + inline styles（transition 对象 in/out/common/transitionProperty，官方文档） | **deps 仅 5**（clsx、type-fest、@floating-ui/react、react-number-format、react-remove-scroll）——**无 CSS-in-JS 运行时**；peers react ^19.2 + @mantine/hooks 精确版本 | 10.0 MB；ESM-only + styles.css export → 需打包器 | 同上 | **否决（当前约束）；若引入打包器则为 React 路首选** |
| **Ant Design** antd 6.6.6 | MIT | last publish 2026-10-12、~2-3 周/版、commits/90d 100+ | @rc-component/motion（dep）："Lifecycle-driven motion primitives for React enter, leave, and list animations" + @ant-design/cssinjs 运行时样式 | **deps 48** 重树（dayjs、@ant-design/icons、rc-* 全家、cssinjs） | **49.0 MB**（全场最大）；有 UMD dist 但依赖树不随 UMD 走 | 同上 | **否决** |
| **Chakra v3** @chakra-ui/react 3.37.0 | MIT | 候选内 React 系最慢：last publish 2026-08-28（取证前 46 天）、commits/90d 62 | theme keyframes/easings tokens + CSS（llms-theming.txt）；deps 无 JS 动画运行时 | deps 7（@ark-ui/react 底座 + emotion utils）；**peers 强拉 @emotion/react** | 2.69 MB + emotion；需打包器 | 同上 | **否决（维护节奏 + emotion peer）** |
| **HeroUI** @heroui/react 3.2.6 | **npm 元数据=MIT（滞后）；repo LICENSE 实测=Apache-2.0** | last publish 2026-09-17、commits/90d 95、open 27 | 官方动画文档：内建 CSS transitions + **data-state 属性**（data-entering/data-exiting/data-pressed）+ Tailwind animate-in/out；可选 Framer Motion（v3 deps 已不含 framer-motion，v2 曾强制 peer） | deps 7；**peers 重：react>=19、react-aria 全家、tailwindcss>=4.0.0、@internationalized/date** | 854 KB meta 包（本体薄、重 peer）；需打包器 + Tailwind 构建层 | 同上 + Tailwind | **否决（peer 全家 + 许可证口径混乱）** |
| **shadcn/ui** CLI 4.21.4 | MIT（CLI）；copy-in 代码无独立许可边界 | CLI last publish 2026-10-07、commits/90d 100+；**2026-07-02 起 Base UI 为默认底座**（Radix 仍支持，官方迁移工具） | 无内建动画系统：动效随 Tailwind 动画工具类与底座组件 data-state 属性走，copy-in 后由本仓维护（机制为底座组件通行模式，未单独取证动画文档） | copy-in：组件代码进仓 + CLI devDep；底座 Radix（活跃，@radix-ui/react-dialog 1.3.1 2026-10-12）或 Base UI（npm umbrella 仍 1.0.0-rc.0） | copy-in 本体 0 运行时包，但要求 **Tailwind v4 构建层** + 打包器 | copy-in 代码 = 本仓测试责任 | **否决（Tailwind+打包器整层 + 底座迁徙期）** |

---

## 3. 逐库取证短评

### 3.0 留任现状：vanilla DOM + CSS/WAAPI（#153 的 B 路）

- **动画**：字幕面已是 CSS transition 自绘；WAAPI 在 Chromium 152 全量可用（Electron 44 = Chromium 152.0.7977.54）。动效流畅度的上限由本仓代码与 Chromium 合成器决定，与库无关。
- **依赖面**：零新增依赖，依赖传递面与离线可复现两项**满分**。
- **打包**：0 B；无 bundler 约束天然满足。
- **测试**：node --test 与 puppeteer E2E 照旧。
- **诚实代价**：debug 三页的可访问性（焦点管理、键盘导航、ARIA）、动效一致性、控件细节全部自担——这正是手写 `el()` 已在支付的成本，且随页面增多线性上涨。留任不是"零成本"，是"成本已可见且可控"。

### 3.1 Web Awesome（@awesome.me/webawesome）——WC 路首选

- **许可证**：Core **MIT**，Pro 为付费增值层。support 页原文："The core of it is free and always will be"、"Core is MIT-licensed, so forking it, patching it, and self-hosting your own build are all fine"。Core/Pro 边界明文：Core=组件、主题、色板、native styles、CSS utilities；Pro=付费组件（如 Date Picker）、Theme Builder、Figma kit。**表单基础控件（button/input/select/checkbox/switch/dialog…）全在 Core。**
- **维护**：Shoelace 官方继任者（"the next major version of Shoelace"）；GitHub shoelace-style/webawesome pushed 2026-10-07，npm v3.14.0（2026-09-24），3.0.0 首发 2025-10-28，近 5 版月节奏，open issues 86。MIT 随归档风险由 Shoelace 先例验证：归档后代码仍 MIT 可用（Shoelace README 明说）。
- **动画**：`<wa-animation>` helper 官方文档原文 "Animate elements declaratively with nearly 100 baked-in presets, or roll your own with custom keyframes. **Powered by the Web Animations API.**"；组件进出场动效走 CSS + data-state。**与现状动画原语（CSS/WAAPI）同源，无新运行时。**
- **依赖面**：deps 13 全部轻量且职能明确（lit 渲染底座、@shoelace-style/animations 预设、@floating-ui/dom 定位等），**0 peer**。lit 106 KB 为最大头。
- **打包/消费（无 bundler）**：官方安装文档原文："The dist-cdn files come with everything bundled together, so you can use them directly without a build tool … Use dist-cdn if you're loading directly in the browser or from a CDN. Use dist if you're using a bundler like Webpack or Vite."（npm manifest files 含 dist、dist-cdn、webawesome.loader.js（autoloader））。离线消费路径 = vendor `dist-cdn` 进 `app/dist`，或按组件 cherry-pick 直接 import（官方示例 `import '@awesome.me/webawesome/dist/components/button/button.js'`）。**唯一待原型验证点：autoloader/资源 base path 在 Electron `file://` 下的行为。**
- **测试**：Web Components 无 React 渲染树，单测即 DOM 断言；本仓已有 puppeteer E2E 通道，冒烟即可。node --test 不受影响。

### 3.2 Shoelace（否决）

GitHub repo **archived=true**；README 原文："**Shoelace is sunset.** There is no active development on this codebase. The library remains available under the MIT license for existing use, but please do not open issues… direct those to **Web Awesome**… migration guide: https://webawesome.com/docs/resources/migrating-from-shoelace"。npm last publish 2025-03-11（v2.20.1）。维护活跃判据直接出局；其功能由 Web Awesome 覆盖。

### 3.3 @fluentui/web-components（备选）

- **许可证** MIT；microsoft/fluentui monorepo 整体极活跃（pushed 2026-10-12，@fluentui/react-components 9.74.9 同日发版）。
- **但**：v3 于 2026-06-29 重启，8 月密集修复后至取证日 **49 天无发版**——节奏不稳定性是维护积极判据的实质扣分。底座 @microsoft/fast-element 未归档（v3.1.0，2026-10-09，commits/90d 53）。
- **消费**：包内 exports 自带预打包 `./web-components.js`/`./web-components.min.js`（unpkg 字段同）→ vendorable 单文件；peer 需 @microsoft/fast-element（bundle 是否已含待原型核）。
- 依赖面干净（deps 仅 @fluentui/tokens + tslib）。作为 WA 的备选保留，不作为首选：WC 路里 WA 活跃度、文档、动画层全面占优。

### 3.4 Vaadin components（否决）

Apache-2.0、发版机器（同日多分支：24.4.20/25.2.15/25.3.3/25.4.0-alpha3 全在 10-07~10-12），维护活跃满分。**但 npm 包为源码级 ESM**：@vaadin/text-field manifest main/module 指向包根 `vaadin-text-field.js`、files=["src",...]、**无预打包 bundle**；text-field 一个控件就带 7 个 @vaadin/* 内部依赖（grid 8 个）+ lit。无 bundler 下需 import map 覆盖整棵 lit+@vaadin/* 树，离线 vendor 碎片多、升级面大。**在"无打包器"硬约束下是全场消费代价最高的可选项**；若未来引入打包器，其 Apache-2.0 + 控件质量仍可重评。

### 3.5 React 系共同代价（整层记账，六家先付这笔再谈差异）

1. **运行时整层**：react + react-dom（react 19.3.0，main=CJS index.js、**files 无 umd/**——React 19 移除 UMD builds，官方 upgrade-guide 锚点 #umd-builds-removed，社区以 umd-react 包续命）。无 UMD → 无 bundler 下没有官方单文件分发，必须打包器或 ESM import map。
2. **工具链整层**：JSX（tsconfig jsx、react types）、打包器（重开 [`app/scripts/build.mjs`](<app/scripts/build.mjs>) 的 Phase 1 决策）、CSS 管线（部分家还要 Tailwind/PostCSS）。
3. **测试链整层**：node --test 无 DOM；组件单测要 RTL+jsdom（新依赖 + loader 适配）或全押 puppeteer。
4. 与零框架 renderer 的共存：字幕浮窗仍走 Electron API，React 只服务 debug 三页——为三页表单引整层，性价比是本组共通的否定理由。

### 3.6 MUI（否决）

维护最强（10.0.0-alpha.0 已发、日级 commit），但 peers 强拉 **@emotion/react + @emotion/styled** 双运行时（ADR-012 口径下 CSS-in-JS 运行时正是要记账的隐藏依赖），动画走 react-transition-group dep。unpacked 8.5 MB + emotion。当前约束下出局；翻盘点同 React 系。

### 3.7 Mantine（React 路内最优，当前否决）

- 依赖面是 React 组最干净：**deps 仅 5 个轻量包，无 CSS-in-JS 运行时**（9.x 已移走 emotion）；动画 = Transition 组件 JS 编排 in/out 状态 + CSS transition（官方文档），Modal/Tooltip 等复用同机制。
- 维护：周节奏（09-21→10-11 五连发）、open issues 仅 21、commits/90d 100+——六家中响应最好。
- 代价：peer 要求 **react ^19.2.0**（锁新）+ @mantine/hooks 精确版本；ESM-only + styles.css export → 无 bundler 下仍需打包器。unpacked 10.0 MB。
- **结论**：差异项全优，但整层代价不因库优秀而消失——"为三个调试页引入 React 19 + 打包器 + 测试链"依旧不成立。写为翻盘点首选。

### 3.8 Ant Design（否决）

deps **48 个**（dayjs、@ant-design/icons、rc-* 全家、@ant-design/cssinjs 运行时样式、@rc-component/motion），unpacked **49.0 MB** 全场最大。动画机制本身先进（@rc-component/motion 生命周期驱动 enter/leave/list），但依赖传递面判据直接爆表。面向中后台全站场景的重量级选择，与"三个表单页"的规模倒挂。

### 3.9 Chakra v3（否决）

@ark-ui/react 底座 + **@emotion/react peer**；deps 7。维护是 React 组最慢：last publish 2026-08-28（取证前 46 天）、commits/90d 62（其余 React 系均 95~100+）。动画走 theme keyframes/easings tokens + CSS，机制无额外运行时（依赖面证据），但两项判据（维护节奏、依赖面）都被同组压过。

### 3.10 HeroUI（否决）

- **许可证口径混乱需明文**：npm package.json license=MIT，但 GitHub repo LICENSE 实测（gh raw）为 **Apache-2.0**——npm 元数据滞后，以 repo 为准记 Apache-2.0。对一个刚从 NextUI 改名、v3 重写的项目，许可证一致性本身是维护成熟度信号。
- peer 全家桶：react>=19、react-dom>=19、react-aria ^3.52.1、**tailwindcss>=4.0.0**、@react-aria/ssr、@react-aria/utils、react-aria-components ^1.21.1、@internationalized/date——依赖传递面最重（React Aria + Tailwind 双生态）。
- 动画机制倒是清晰：官方文档"built-in CSS transitions, custom CSS animations, and JavaScript libraries like Framer Motion"，内建走 data-entering/data-exiting/data-pressed 状态属性 + Tailwind animate-in/out，v3 已把 v2 强制的 framer-motion 从 deps 移除（可选）。机制好 ≠ 整层便宜。

### 3.11 shadcn/ui（否决）

copy-in 模式（组件源码进仓）= 零运行时黑盒，但代价转为本仓维护责任 + **Tailwind v4 构建层** + 打包器。底座处于迁徙期：官方 changelog（2026-07-02）"**Base UI is the default component library in shadcn/ui**"，Radix 仍支持并提供 asChild→render 自动迁移工具；Base UI npm umbrella 包 latest 仍为 **1.0.0-rc.0**（2026-07-15）。迁徙期引入 = 主动站进上游的迁移轨道。动画无内建系统（Tailwind 工具类 + 底座 data-state，copy-in 自担）。

---

## 4. 推荐

**主推荐：留任 vanilla DOM + CSS/WAAPI 为主干；Web Awesome（@awesome.me/webawesome）作为设置/调试面的 WC 增强层，经原型票验证后按 ADR 落地。**

理由链：

1. **两个承载面判然有别**：字幕浮窗的组件库角色最小（窗口能力已由 ADR-013 的 Electron API 覆盖，字幕行自绘且效果已验收），任何库对它的增益≈0；组件库的真实战场只有 debug 三页的表单控件。
2. **Web Awesome 与本仓硬约束逐条对齐**：框架无关（与零框架 renderer 共存）；官方文档明文支持无构建工具消费（dist-cdn 自包含 bundle + autoloader）；Core MIT 且自托管/打补丁明文允许；0 peer、deps 轻且职能清楚；动画原语 = WAAPI + CSS（与现状同源，无新运行时）；月节奏发版 + Shoelace 血统的归档风险已被 MIT 双重缓冲。
3. **留任现状的诚实评估**（#182 要求）：overlay 面留任不是妥协而是正解；debug 三页的既有成本（手写 `el()`、自担可访问性与键盘导航、动效一致性）真实存在且随页面数线性增长——这正是"要不要增强层"的决策来源。留任全程可退：WA 增强层若原型失败，仓库回到纯 vanilla，零沉没成本（vendor 文件删除即回滚）。
4. **双标准对照**：动画——WA 的 WAAPI helper 与 CSS data-state 与现状同源，增量动效一致性由主题层解决；维护——WA 月节奏 vs Shoelace 归档后继、vs Fluent WC 49 天静默、vs Vaadin 活跃但消费代价高。

**代价明文记账（照 ADR-012 结构）**：

1. 新增 lit 底座 + 13 个轻依赖的 node_modules 体量（webawesome unpacked 17.5 MB 全量，cherry-pick 导入后实际进包远小于此）；lockfile 面变大。
2. renderer 加载路径变化：debug 窗口从纯 classic script 变为"vendored ESM/WC 资源 + `<script type=module>`（或 autoloader）"——`renderer.ts:12` 的 import-free 约束保持不动（字幕面不引库）。
3. 两套控件风格并存期：vendored WA 主题 vs 手写 tokens（[`wayfinder/debug-window-style-tokens.md`](<wayfinder/debug-window-style-tokens.md>)）需一次视觉对齐。
4. WA Pro 诱惑面：表单基础控件全在 Core，但需在 ADR 记一条"仅 Core 组件准入"红线，防无意引入 Pro 组件（Pro 组件在文档中带明确 Pro 标记）。

## 5. 被否决的选项（一句话各记）

- **Shoelace**：官方归档 sunset（README 原文 no active development），由 Web Awesome 接班。
- **Vaadin**：源码级 ESM 无预打包 bundle + 逐包依赖树，无打包器约束下全场消费代价最高。
- **React 系六家（当前约束下）**：React 19 无 UMD + 无打包器现状 → 必须引入"打包器 + JSX + 测试链"整层；为三个调试页支付整层不成立。
  - MUI：emotion 双 peer；Mantine：react ^19.2 锁新（但若整层引入则它最优）；antd：48 deps + 49 MB；Chakra：46 天无发版 + emotion peer；HeroUI：React19+Tailwind4+ReactAria 全家 peer + 许可证口径混乱；shadcn/ui：Tailwind 层 + 底座迁徙期。

## 6. 翻盘点

1. **若未来引入打包器**（Phase 1 分拆决策重开）→ **Mantine** 立即成为 React 路首选（依赖面最干净、周节奏、无 CSS-in-JS 运行时）；Vaadin（Apache-2.0、控件质量）与 MUI（10.0）重入候选。
2. **若 WA 原型失败**（autoloader/file:// 不可用或 Core 组件覆盖不足）→ 全量留任 vanilla，debug 三页继续 [`app/src/renderer/debug-renderer.ts`](<app/src/renderer/debug-renderer.ts>) 手写路线 + style tokens 收敛。
3. **若 @fluentui/web-components 恢复月节奏**→ 以包内预打包 bundle 的形态作为 WC 备选复活（fast-element 未归档是基本盘）。

## 7. 后续：建议的 ADR 落地票与触发条件

1. **新 ADR（编号顺延 `docs/adr/` 现有最大号）**：按 ADR-012 结构落"TS 栈组件库：留任 vanilla + Web Awesome 增强层"，引用本文候选矩阵与代价记账；被否决项与翻盘点照抄第 5/6 节。
2. **原型票（P2-lib-prototype）**：在设置页用 vendored dist-cdn 引 3~5 个 Core 组件（wa-button / wa-input / wa-select / wa-switch），验证三件事：
   - autoloader 或按组件 import 在 Electron 44 `file://` 下的资源 base path 行为（唯一未知项）；
   - 主题与现有 style tokens 的对齐工作量；
   - puppeteer 冒烟挂进 [`tests/browser/browser-e2e.test.ts`](<tests/browser/browser-e2e.test.ts>) 同通道。
3. **触发条件**：原型三项全过 → ADR 落"引入 WA Core 增强层"；任一失败 → ADR 落"留任 vanilla"并关闭增强层轨道（翻盘点 2）。ADR-013:28 的 backdrop-filter 原型项可并入同一票呈现。

## 8. 证据清单（全部 URL，取证日期 2026-10-13）

| # | 主张 | 来源 |
| --- | --- | --- |
| E1 | Shoelace 归档/sunset 原文 | https://github.com/shoelace-style/shoelace （archived=true）+ https://raw.githubusercontent.com/shoelace-style/shoelace/main/README.md |
| E2 | Web Awesome Core=MIT、free/Pro 边界、自托管许可 | https://webawesome.com/support |
| E3 | Web Awesome 无构建工具消费（dist-cdn/autoloader/npm 安装） | https://webawesome.com/docs |
| E4 | `<wa-animation>` WAAPI 机制原文 | https://webawesome.com/docs/components/animation |
| E5 | @awesome.me/webawesome 3.14.0 registry 数据（deps/peers/发版） | https://www.npmjs.com/package/@awesome.me/webawesome + https://registry.npmjs.org/@awesome.me/webawesome + https://unpkg.com/@awesome.me/webawesome@3.14.0/package.json |
| E6 | @fluentui/web-components v3.1.3（exports 预打包 bundle、peers） | https://www.npmjs.com/package/@fluentui/web-components + https://unpkg.com/@fluentui/web-components@3.1.3/package.json |
| E7 | @microsoft/fast-element 未归档、v3.1.0 2026-10-09 | https://github.com/microsoft/fast + https://www.npmjs.com/package/@microsoft/fast-element |
| E8 | Vaadin text-field/grid 25.3.3（源码级 ESM、deps） | https://www.npmjs.com/package/@vaadin/text-field + https://www.npmjs.com/package/@vaadin/grid + https://unpkg.com/@vaadin/text-field@25.3.3/package.json |
| E9 | lit 3.3.3（底座体量/依赖/节奏） | https://www.npmjs.com/package/lit + https://unpkg.com/lit@3.3.3/package.json |
| E10 | @mui/material 9.5.0（emotion peers、react-transition-group dep） | https://www.npmjs.com/package/@mui/material + https://unpkg.com/@mui/material@9.5.0/package.json |
| E11 | MUI transitions 机制 | https://mui.com/material-ui/transitions/ |
| E12 | @mantine/core 9.7.2（5 deps、react ^19.2 peer、styles.css export） | https://www.npmjs.com/package/@mantine/core + https://unpkg.com/@mantine/core@9.7.2/package.json |
| E13 | Mantine Transition 机制 | https://mantine.dev/core/transition/ |
| E14 | antd 6.6.6（48 deps、cssinjs、@rc-component/motion） | https://www.npmjs.com/package/antd + https://unpkg.com/antd@6.6.6/package.json |
| E15 | @rc-component/motion 机制原文 | https://github.com/react-component/motion |
| E16 | AntD Motion 设计规范 | https://1x.ant.design/docs/spec/motion （v3/v4 时代规范页；v6 机制以 E14/E15 为准） |
| E17 | @chakra-ui/react 3.37.0（ark 底座、emotion peer） | https://www.npmjs.com/package/@chakra-ui/react + https://unpkg.com/@chakra-ui/react@3.37.0/package.json |
| E18 | Chakra keyframes/easings tokens | https://chakra-ui.com/llms-theming.txt |
| E19 | @heroui/react 3.2.6（peer 全家、Apache-2.0 repo LICENSE） | https://www.npmjs.com/package/@heroui/react + https://raw.githubusercontent.com/heroui-inc/heroui/main/LICENSE + https://github.com/heroui-inc/heroui |
| E20 | HeroUI v3 动画机制（data-state + 可选 Framer Motion） | https://heroui.com/en/docs/react/getting-started/animation |
| E21 | shadcn 4.21.4 + Base UI 默认化原文 | https://www.npmjs.com/package/shadcn + https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/content/docs/changelog/2026-07-base-ui-default.mdx |
| E22 | Radix 活跃度 | https://github.com/radix-ui/primitives + https://www.npmjs.com/package/@radix-ui/react-dialog |
| E23 | Base UI npm 1.0.0-rc.0 / repo v1.9.0 | https://www.npmjs.com/package/@base-ui-components/react + https://github.com/mui/base-ui/releases |
| E24 | React 19 移除 UMD（官方锚点）+ react 19.3.0 无 umd files | https://react.dev/blog/2024/04/25/react-19-upgrade-guide#umd-builds-removed （经 https://cdn.jsdelivr.net/npm/umd-react@19.3.0/README.md 引述）+ https://unpkg.com/react@19.3.0/package.json |
| E25 | 各库 GitHub 活跃度（stars/open issues/commits/90d/pushed） | gh api repos/{shoelace-style/webawesome,microsoft/fluentui,microsoft/fast,vaadin/web-components,lit/lit,mui/material-ui,mantinedev/mantine,ant-design/ant-design,chakra-ui/chakra-ui,heroui-inc/heroui,shadcn-ui/ui,radix-ui/primitives,mui/base-ui} |
| E26 | Electron 44 = Chromium 152.0.7977.54 / Node v24.18.1 | https://github.com/electron/electron/releases/tag/v44.0.0 |
| E27 | MUI 10.0.0-alpha.0（2026-10-12）等大版本首发时间 | https://registry.npmjs.org/@mui/material （time 字段） |
| E28 | 本仓约束文件 | [`app/package.json`](<app/package.json>)、[`app/src/renderer/renderer.ts`](<app/src/renderer/renderer.ts>):12-13、[`app/src/renderer/debug-renderer.ts`](<app/src/renderer/debug-renderer.ts>):6、[`app/scripts/build.mjs`](<app/scripts/build.mjs>):1 |
| E29 | 口径上游 | [`docs/adr/ADR-012-debug-window-pyside6-fluent-widgets.md`](<docs/adr/ADR-012-debug-window-pyside6-fluent-widgets.md>)、[`docs/adr/ADR-013-desktop-runtime-electron.md`](<docs/adr/ADR-013-desktop-runtime-electron.md>):29、[`docs/adr/ADR-013-desktop-runtime-electron.md`](<docs/adr/ADR-013-desktop-runtime-electron.md>):28、[`.scratch/wayfinder/research/component-library.md`](<.scratch/wayfinder/research/component-library.md>)（#153） |
| E30 | 旧票 | https://github.com/CometDash77/youtubesub/issues/210 、https://github.com/CometDash77/youtubesub/issues/182 |

lit.dev 无构建用法未逐字核验（SPA 页面），lit 消费结论以 E9 manifest（type=module、逐文件 ESM exports）为准；Vaadin 官方安装文档 URL 本次 404，Vaadin 消费结论以 E8 manifest 为准。

## 9. 进度记录（供票面摘录）

- 2026-10-13 读 #210/#182、ADR-012/013、[`.scratch/wayfinder/research/component-library.md`](<.scratch/wayfinder/research/component-library.md>)（#153），确认判据映射与文档结构。
- 2026-10-13 读 [`app/package.json`](<app/package.json>)、[`app/src/renderer/renderer.ts`](<app/src/renderer/renderer.ts>)、[`app/src/renderer/debug-renderer.ts`](<app/src/renderer/debug-renderer.ts>)、[`app/scripts/build.mjs`](<app/scripts/build.mjs>)，固化"零框架、无打包器、renderer import-free"硬约束。
- 2026-10-13 npm registry 取证 14 包（webawesome/shoelace/fluent-wc/fast-element/vaadin×2/lit/mui/mantine/antd/chakra/heroui/react/fluentui-react-components）：版本、deps/peers、unpacked size、发版节奏、大版本首发时间。
- 2026-10-13 gh api 取证 14 repo（archived 状态、pushed、latest release、commits/90d、open issues）+ Shoelace README/HeroUI LICENSE raw 原文 + Electron v44.0.0 release notes。
- 2026-10-13 fetch 文档页：webawesome.com（docs/support/animation）、heroui.com animation、chakra llms-theming、mantine transition、mui transitions、antd spec/motion、shadcn base-ui changelog、lit getting-started、react 19 upgrade guide（经 umd-react README 引述）。
- 2026-10-13 产出本文 [`wayfinder/component-library-reselection-ts.md`](<wayfinder/component-library-reselection-ts.md>)；回填票面与 ADR 落地由主会话执行。
