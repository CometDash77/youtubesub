# ADR-013: 桌面运行时采用 Electron（TS 重构目标栈）

状态: 已接受（2026-10-08, 维护者拍板, 免取证票；决策原文见地图 [全项目 TypeScript 重构 map](https://github.com/CometDash77/youtubesub/issues/181) Notes ③；本 ADR 的落盘票为 [落盘 ADR-013：Electron 桌面运行时选型](https://github.com/CometDash77/youtubesub/issues/192)）.

背景: 地图 [全项目 TypeScript 重构 map](https://github.com/CometDash77/youtubesub/issues/181) 的 Phase 1 destination 要求 desktop/ 的 Python 3.12 + PySide6 全部退役，浮窗、协议服务、翻译管线、断句、缓存、设置/调试窗口全部以 TypeScript 在新运行时上重写；硬约束同时要求穿透/置顶/半透明/热键在新运行时下**等价可用**，重构期间协议 v1（browser→desktop）语义不变。运行时是 Phase 1 全部实施票的地基：维护者 2026-10-08 直接拍板（免取证票），本 ADR 负责落盘该决策，作为后续实施票的引用锚点。

决定:
- 桌面运行时 = **Electron**：Phase 1 的全部桌面能力落在 Electron 上，全程 TypeScript（主进程 + 渲染进程），Python 3.12 + PySide6 按地图退役计划退出。
- 浮窗硬能力判据（地图 Notes ③）在 Electron 公开 API 上的对应：无边框置顶窗 = `BrowserWindow` 的 `frame: false` + `alwaysOnTop`；逐像素半透明 = `transparent`；鼠标穿透 = `setIgnoreMouseEvents`（保留 `Ctrl+Alt+U` 热键解锁回路）；托盘 = `Tray`；全局热键 = `globalShortcut`（`Ctrl+Alt+U`）；本地 WebSocket 服务 = 主进程即 Node 运行时，协议 v1 服务以 TS 原样重写。
- 工程链同栈：本机 Node 22.23.1 已装（CONTEXT.md 事实节），Electron 主进程与构建/测试链（node --test）同属 Node 生态，无跨栈工具链。

理由:
1. **四项硬能力 + 全局热键 + 本地 WebSocket 的成熟 API**：上述判据全部有 Electron 一线公开 API 覆盖，无需自写原生模块或依赖未文档化行为——这是拍板的核心依据；等价可用在本机的实证由真机验证票闭环（见代价 1）。
2. **Node 22 已就绪**：运行时与工具链同栈，TS 重构的编译、测试、打包都在已就绪的 Node 22.23.1 上进行（CONTEXT.md 事实节）。
3. **无需新装 Rust**：本机无 Rust（CONTEXT.md 事实节），要求 Rust 工具链的路线被直接排除。

接受代价（明文记账）:
1. **等价可用未证**：穿透/置顶/半透明/热键在 Electron 下「等价可用」目前是判据不是证据，由 [Electron 五能力真机验证](https://github.com/CometDash77/youtubesub/issues/193) 真机出证后，本 ADR 的证据链才算闭环。
2. **体积/内存方向已知、数量未测**：Electron 自带完整 Chromium + Node 运行时，包体与内存高于无浏览器内核的原生窗体栈；本机实测数字由真机验证票出证后补记。

被否决的选项:
- **Tauri**：构建依赖 Rust 工具链，本机无 Rust（CONTEXT.md 事实节）——选它意味着先装整套 Rust 工具链，净增环境负担，且硬能力判据在本机零验证记录。
- **混合栈（保留 Python 桌面端，仅 userscript/测试转 TS）**：与地图 destination「完全 TS 重构、Python 代码全部退役删除」直接冲突——Python 侧正是本图要退役的对象，不构成可选路径。

后果:
- ADR-001「桌面栈 = Python + PySide6」的运行时角色由本 ADR 接管；Phase 1 退役完成前 PySide6 栈仍是运行中的现状，ADR-001 文件保留作历史记录。
- Phase 1 后续实施票（Electron 骨架、协议服务、翻译管线/断句/缓存、浮窗显示层、设置/调试窗口、userscript、Python 退役清理）以本 ADR 为运行时引用锚点。
- 磨砂/模糊路线延续 [Win10 磨砂实现取证](https://github.com/CometDash77/youtubesub/issues/154) 先例：掉帧路线应禁用，不引入未文档化 API；Chromium `backdrop-filter` 是否达标由 Phase 2 原型票呈现（地图 Notes 性能先例）。
- 许可证：Electron 为 MIT，无 ADR-012 那样的 GPLv3 分发约束；Phase 2 组件库按 ADR-012 同一口径逐库评估。
