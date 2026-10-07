# userscript TS 化工具链取证

- 票：CometDash77/youtubesub#194（`wayfinder:research` + `wayfinder:task`）
- 背景：地图 #181（Phase 1 全量 TS 重构）；并行票 #191 切分 grilling、#192 ADR-013、#193 Electron 五能力验证
- 日期：2026-10-07（全部一手来源当日抓取）
- 性质：research 票——只取证与给裁定建议，**不实施**。产出喂给 #191 切分票消化。

## 研究问题与决策依赖

票面写死四题，无需 grilling 澄清（研究问题与决策依赖在票里已闭合）：

1. **构建器**：esbuild / tsup / Vite lib 模式等，谁能产出"单文件 IIFE + Tampermonkey 元数据头"？
2. **类型来源**：YouTube 页面 DOM、GM_* API 的类型从哪来？
3. **测试框架**：TS 化后与现有零依赖 node --test 套件的关系？
4. **热重载/调试回路**：改完怎么快速在真浏览器里看到效果？

决策依赖：四题结论 → #191 切分 grilling → userscript TS 化实施票。本票不阻塞 #191 其他部分。

## 结论速览（裁定建议）

| 题 | 裁定 | 一句话理由 |
|---|---|---|
| 构建器 | **esbuild 直驱为主案**；vite-plugin-monkey 为备选（要 HMR 时）；tsup 可行无增益；Vite lib 模式过重；WXT 排除 | esbuild 用 banner + format:'iife' + globalName 三件套即可满足全部硬契约，且零封装 |
| TM 头 | **构建时以 banner 原样携带，逐字保留在产物首行**；若走 vite-plugin-monkey 则头由插件生成，需对齐测试断言 | node 测试守卫头格式与 @version 0.1.1 精确值；TM 解析失败直接拒装 |
| 类型 | devDep `@types/tampermonkey@^5.5.0`；页面 DOM 用 lib.dom；**YouTube 页面内部对象（ytInitialPlayerResponse 等）无权威社区类型 → 本地最小结构 d.ts** | GM API 官方包双重载齐全；页面内部类型 npm 无权威包 |
| 测试 | **tests/*.test.mjs → *.test.ts 改名迁移，node --test 直跑，零新依赖**；tsc --noEmit 独立查型 | Node ≥22.18 类型剥离默认开（本机 22.23.1 实测直跑通过）；不引入 vitest/tsx |
| 热重载 | Phase 1 最小回路 = **esbuild watch + TM 里手动重载**；要保存即重载 → vite-plugin-monkey dev server（HMR 官方特性） | TM 文档站正文抓不到，@require 外链缓存细节未核实，不押注 |

## 仓库现状与硬契约（本地取证，2026-10-07）

### 现状

- `userscript/youtubesub.user.js`：478 行单文件 IIFE，ES5 var 风格。TM 头：`@name youtubesub - YouTube subtitle bridge`、`@namespace https://github.com/local/youtubesub`、`@version 0.1.1`、`@match *://*.youtube.com/*`、`@grant GM_xmlhttpRequest` + `GM_addElement`、`@connect 127.0.0.1` / `localhost`、`@run-at document-start`、`@license MIT`。
- 两层结构：页内 hook 注入（拦截 timedtext，`buildPageHookCode()` 运行时生成代码字符串，含 `window.fetch` 覆盖；Trusted Types 三级降级：GM_addElement → trustedTypes.createPolicy → 直接 eval，sandboxed realm 拒装）+ 脚本上下文 `GM_xmlhttpRequest` 发往本地桌面 127.0.0.1:9877（/health 探测 + ws）。
- `userscript/tests/userscript.test.mjs`：node --test 零依赖，**不 import 模块**——`fs.readFileSync` 读 .user.js 原文 → `vm.createContext` + `vm.runInContext`；断言 `window.__youtubesub` 测试面（parseJson3 / normKey / trackKindFromUrl / trackLangFromUrl / isTimedtextUrl / videoIdFromLocation / buildPageHookCode / cuesSignature / Bridge）。
- 元数据守卫测试：头块必须首行 ``// ==UserScript==``、闭合、块内每行空或 // 注释、必需键（name/namespace/version/match/run-at/grant/connect）、`run-at=document-start`、**`@version 0.1.1` 正则精确锁定**；测试注释明言 TM 损头会拒装而 CDP 注入不读头 → **node 测试是头的唯一守卫**。
- 基线实测：`cd userscript; node --test "tests/*.test.mjs"` → **40/40 pass**（README 写的 33、旧地图基线 46 均已过时）。注意必须 glob 形式，传目录会 MODULE_NOT_FOUND。

### 构建硬契约（5 条，违反任何一条都是回归）

1. 产物仍是**单文件 IIFE**（vm 沙箱裸求值，无 ESM import/export）。
2. 产物路径 `userscript/youtubesub.user.js` 不变——否则同步改 `desktop/tests/browser_e2e.py:44`（USERSCRIPT_PATH，CDP document-start 注入 + GM shim）与 `README.md:21`（手动导入指引）。
3. **TM 头逐字保留在产物首行**（首行断言 + 必需键 + @version 0.1.1 精确正则三重锁）。
4. 保住 `window.__youtubesub` 测试面（`__youtubesub.instance` 必须挂在沙箱 window 上，即 IIFE 顶层挂 window，非模块作用域私有）。
5. GM_* 缺失时行为可降级（现有测试已守卫，迁移不得破坏）。

消费方补充：`desktop/tests/test_parse_parity.py` 与 JS 测试共享 `userscript/tests/fixtures/parse_cases.json`——TS 迁移后 JS 断言语义必须逐字等价（地图 #181 的"等价断言不删改放宽"）。

## 分题取证

### Q1 构建器

**esbuild**（evanw/esbuild `lib/shared/types.ts` raw + esbuild.github.io/api，2026-10-07）：
- `export type Format = 'iife' | 'cjs' | 'esm'`；iife 官方描述："wraps the generated JavaScript code in an immediately-invoked function expression to prevent variables from leaking into the global scope"。
- `banner?: { [type: string]: string }`（文档锚 https://esbuild.github.io/api/#banner ）、`footer`（#footer）、`globalName?: string`（#global-name）、`platform: 'browser' | 'node' | 'neutral'`（#platform）。
- **TM 头进法：banner 原样字符串**，不经过任何转换，逐字落产物顶部——恰好满足硬契约 3。
- watch：BuildContext API（文档锚 https://esbuild.github.io/api/#watch ，types.ts 命中 watchFiles 佐证 watch 通道存在）。

**tsup 8.5.1**（已发布 dist/index.d.ts，jsdelivr）：
- `format?: Format[] | Format`、`globalName?: string`；`type BannerOrFooter = { js?: string; css?: string; } | ((ctx: { format: Format; }) => { js?: string; css?: string; } | undefined)`，OptionsConfig 上 `banner` / `footer` 均为 BannerOrFooter → JS 输出可按 format 函数式注入头。
- 坑：另有 DtsConfig 的 `banner?: string`（注释 "Insert at the top of each output .d.ts file"）——.d.ts 专用，勿混淆；`platform` 默认 `'node'`，userscript 场景须显式 `'browser'`。
- 结论：能做，但本质是 esbuild 的再封装，对本场景无增益。

**Vite lib 模式**（vite.dev/config/build-options.html）：`build.lib = { entry?, name?, formats?: ('es' | 'cjs' | 'umd' | 'iife')[], fileName?, cssFileName? }`。支持 iife，但为单文件 userscript 引入整个 Vite 工程过重——除非同时要它的 dev 体验（见 Q4 备选）。

**vite-plugin-monkey 8.1.1**（lisonge/vite-plugin-monkey）：
- README Features："Inject userscript metadata into the build output"、"Open the development userscript in the default browser when its metadata changes"。
- 文档站（vite-plugin-monkey.pages.dev）："Vite development experience — Use fast startup, hot module replacement, TypeScript, top-level await, and dynamic imports while building userscripts"。
- 是唯一把"构建头 + dev 回路"一起解决的现成件；代价：引入 Vite 工程，且**头由插件生成**——必须配置到与 node 守卫测试兼容（`@version 0.1.1` 精确正则会卡动态生成的头，需对齐）。

**WXT**（wxt.dev/llms.txt 全文档索引，0 处 userscript）：WebExtension 框架（background/content/popup entrypoints 语义），无 userscript 一等支持 → 与单文件改造不相称，排除。

**裁定**：esbuild 直驱为主案——一个 devDep + 十几行 build 脚本，5 条硬契约全保住。若 #191 决定要"保存即重载"，vite-plugin-monkey 为备选，实施票需先解决"插件生成的头 vs 测试精确断言"的对齐。

### Q2 类型来源

- **GM_* API**：`@types/tampermonkey@5.5.0`（DefinitelyTyped）。d.ts 原文双重载齐全：`declare function GM_addElement(tagName: string, attributes: object): HTMLElement;` 与 `declare function GM_addElement(parentNode: Element, tagName: string, attributes: object): HTMLElement;`（引用 https://www.tampermonkey.net/documentation.php?q=GM_addElement ）；GM_xmlhttpRequest 在。本仓库两个 grant 都有官方声明 → 直接用。
- 对照：`@types/greasemonkey@4.0.7` 存在，覆盖面窄于 TM 专包，不用。
- **YouTube 页面内部对象**（ytInitialPlayerResponse 等）：npm 无权威 TS 类型（搜索仅命中 docs.rs/utube Rust crate、github Mampfinator/yt-scraping-utilities 等杂项；`@types/youtube@0.3.0` 是 IFrame Player API 域，与页面内部对象无关）。**裁定：本地最小结构 d.ts**——只声明实际访问的字段（parseJson3 消费的 json3 结构、window 上的钩子位），其余 unknown 收窄。不为不消费的字段维护类型。

### Q3 测试框架

- Node 官方文档（nodejs.org/docs/latest-v22.x/api/typescript.html，changelog 原文）："**v22.18.0 Type stripping is enabled by default.**"、"Type stripping no longer emits an experimental warning."、"v22.7.0 Added --experimental-transform-types flag"。
- 本机实证：Node v22.23.1，探针 `.scratch/ts-probe/probe.test.ts`（type/interface + 断言）`node --test '.scratch/ts-probe/*.test.ts'` **无任何 flag 直跑 pass**。
- 约束：类型剥离只支持**可擦除语法**（erasableSyntaxOnly 语义）——无 enum / namespace / 参数属性；且**不查型**，查型用 `tsc --noEmit` 独立跑。
- **裁定**：`tests/*.test.mjs` → `*.test.ts` 改名迁移（vm 沙箱读产物文本的机制原样保留），跑法 `node --test "tests/*.test.ts"`（保持 glob 形式）；零新运行时依赖；CI/pre-commit 加 `tsc --noEmit`。不引入 vitest/tsx——都违背现有零依赖契约，且 node --test 已够用。断言语义逐字等价迁移，不删改放宽（地图 #181 约束）。

### Q4 热重载/调试回路

三条路，按取证置信度排序：

1. **esbuild watch + TM 手动重载**（Phase 1 最小回路，零新依赖）：`esbuild context + watch()`（文档锚 https://esbuild.github.io/api/#watch ）后台重建产物，开发者去 TM 面板点重载或刷新 YouTube 页。TM 侧重载无自动化——TM 文档站正文为 JS 壳抓取不到，externals 缓存 TTL / file:// 权限细节**未核实**，此路不押注自动化。
2. **vite-plugin-monkey dev server**（要 HMR 时）：官方特性 "hot module replacement … while building userscripts" + "Open the development userscript in the default browser when its metadata changes"——装一次开发用元脚本，@require 指向本地 dev server，改代码即热更新。与 Q1 备选同构：选它 = 选 Vite 工程。
3. **自建静态服务 + @require http://127.0.0.1:PORT/dev.user.js**：esbuild watch + 任意静态服务直出产物；`@connect 127.0.0.1` 已在头里。风险同 1：TM 对 @require 外链的拉取/缓存策略细节未核实（documentation.php 仅索引页列有 @require 键，锚 #meta:require，正文抓不到）。

**裁定**：实施票 Phase 1 用路 1；若 #191 判定 HMR 必要，整体切换到 vite-plugin-monkey（Q1+Q4 联动决策）。

## 风险与未决

- **TM externals 缓存 TTL / file:// 权限细节未核实**（TM 文档站 JS 壳，正文抓取失败）→ 实施票做真 TM 验收时人工补（CONTEXT.md：TM 未装，真 TM 验收本来就是人工项）。
- vite-plugin-monkey 生成头与 `@version 0.1.1` 精确正则的兼容性：若走该插件，版本号需配置化对齐，或放宽该断言（放宽违反地图约束，不建议）。
- erasable-only 语法约束（禁 enum/namespace/参数属性）必须写进实施票验收，否则 Node 直跑会炸。
- 产物路径变更的连带修改点：`desktop/tests/browser_e2e.py:44`、`README.md:21`——除非必要，路径不动。
- 本报告无二手不可引来源；全部结论锚定下列一手 URL 或本地实测。

## 参考来源（全部 2026-10-07 抓取）

- 票与地图：github.com/CometDash77/youtubesub/issues/194、/issues/181
- esbuild：https://raw.githubusercontent.com/evanw/esbuild/main/lib/shared/types.ts ；https://esbuild.github.io/api/#banner 、#footer 、#global-name 、#platform 、#watch
- tsup：https://cdn.jsdelivr.net/npm/tsup@latest/dist/index.d.ts （8.5.1 已发布产物）
- vite-plugin-monkey：https://github.com/lisonge/vite-plugin-monkey （README master）；https://vite-plugin-monkey.pages.dev/
- Vite：https://vite.dev/config/build-options.html
- WXT：https://wxt.dev/llms.txt
- Node：https://nodejs.org/docs/latest-v22.x/api/typescript.html
- @types/tampermonkey：https://raw.githubusercontent.com/DefinitelyTyped/DefinitelyTyped/master/types/tampermonkey/index.d.ts
- Tampermonkey 文档：https://www.tampermonkey.net/documentation.php （索引页；正文细节未核实）
- 本地实测：`cd userscript; node --test "tests/*.test.mjs"` → 40/40（Node v22.23.1）；`.scratch/ts-probe/probe.test.ts` TS 直跑探针
