# ADR-001: 桌面端采用 Python + PySide6

状态: 已接受 (grill-with-docs 访谈).
背景: 本机无 Rust/.NET, 只有 Python 3.12 与 Node 22. 桌面 App 需常驻 WS 服务 + 翻译队列 + 浮窗.
决定: Python + PySide6 (Qt6). 浮窗按 LiveSubs PORT PLAN 实现 (frameless/stays-on-top/translucent/描边/双语/历史/hover 工具栏).
备选 (否决): tkinter — 只能整窗 alpha 或 chroma-key, 文字质量与圆角框达不到要求; Electron — 100MB+/内存高, 与轻量目标冲突.
后果: 需 pip 安装 PySide6-Essentials (约 78MB, 经代理可装); 打包分发以后再议.
