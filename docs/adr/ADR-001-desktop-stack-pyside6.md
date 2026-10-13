# ADR-001: 桌面端采用 Python + PySide6

状态: 已接受 (grill-with-docs 访谈).
背景: 本机无 Rust/.NET, 只有 Python 3.12 与 Node 22. 桌面 App 需常驻 WS 服务 + 翻译队列 + 浮窗.
决定: Python + PySide6 (Qt6). 浮窗按 LiveSubs PORT PLAN 实现 (frameless/stays-on-top/translucent/描边/双语/历史/hover 工具栏).
备选 (否决): tkinter — 只能整窗 alpha 或 chroma-key, 文字质量与圆角框达不到要求; Electron — 100MB+/内存高, 与轻量目标冲突.
后果: 需 pip 安装 PySide6-Essentials (约 78MB, 经代理可装); 打包分发以后再议.

退役标注 (2026-10-13, map #181 执行票 #207): Python + PySide6 栈已整体退役并从仓库删除 (`desktop/` / `requirements.txt` / pytest 依赖面)。桌面端由 Electron (TypeScript) 栈承载: `app/` 自 #191 起逐模块等价移植, #206 全栈测试全绿, #207 完成退役清理与真库一次性接管 (翻译缓存直连仓库根 `data/translations.db`, 设置直连 `%APPDATA%/SubOverlay/setting.json`)。上文的「Electron 否决」按当时约束 (本机只有 Python) 记录, 保留作历史; 现行实现以 `app/` 与 ADR-013 为准。
