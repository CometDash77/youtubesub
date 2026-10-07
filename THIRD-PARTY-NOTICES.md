# Third-party notices

本项目部分设计与代码改写自以下开源项目 (详见 docs/DESIGN.md 的复用分类):

1. yt-dual-subs — Copyright (c) 2026 Gythiro — MIT License.
   改写复用: json3 解析 (lastOff), lastOff 分句, trans 随 cue, nearestTcue 回退,
   对齐翻译协议与校验, lane 队列模型, 实测常量. MIT 全文见 licenses/MIT-yt-dual-subs (待补).
2. transly — Copyright (c) 2026 Haitian — MIT License.
   设计吸收 (Python clean-room 重写): provider 配置模型, protocol auto 适配,
   SSE/JSON 双检测归一, 缓存 identity, 单一并发权威, 输出校验. MIT 全文见 licenses/MIT-transly (待补).
3. LiveSubs — Copyright (c) 2026 Diva143V — Apache License 2.0.
   移植其浮窗几何/透明度/描边/双语布局/历史队列/设置持久化思路到 PySide6.
4. local-screen-translator — Copyright 2025 Neverland-XFX — Apache License 2.0.
   参考其 localhost sink 教训与 Qt overlay flag / LRU / DPI 思路.
5. dkitle (ywxt) — 仅参考设计 (线协议 schema / 桌面时钟插值 / 页面内拦截思路).
   其桌面 Rust 端无许可证, 不复制代码; 其 userscript 声明 MIT, 改写适配时将注明出处.

Apache-2.0 全文见 licenses/Apache-2.0 (待补).

## 运行时依赖（第三方 Python 包）

以上为设计/代码复用来源；以下是随程序安装的第三方运行时依赖（完整清单见 `requirements.txt`）：

6. PySide6-Fluent-Widgets (qfluentwidgets) 1.11.3 — Copyright (c) zhiyiYo — **GPLv3**（非商用；商用须购买商业许可）。
   用途: 桌面「调试」窗口的全部控件。**许可证影响**: 与 GPLv3 代码链接后, 分发本程序整体时受 GPLv3 约束
   （本仓库当前无 LICENSE、分发口径未定, 决定与代价见 docs/adr/ADR-012）。
   GPLv3 全文: https://github.com/zhiyiYo/PyQt-Fluent-Widgets/blob/master/LICENSE （本地 licenses/GPL-3.0 待补）。
7. PySideSix-Frameless-Window 0.8.2 — Copyright (c) zhiyiYo — LGPLv3.
   用途: PySide6-Fluent-Widgets 的依赖（无边框窗口 / 亚克力），本项目不直接调用。
8. pywin32 312 — Copyright Mark Hammond (et al) — PSF License.
   用途: PySideSix-Frameless-Window 在 Windows 上的依赖。
9. darkdetect 0.8.0 — Copyright (c) Alberto Sottile — BSD-3-Clause.
   用途: PySide6-Fluent-Widgets 的依赖（系统明暗主题探测）。
10. PySide6 / PySide6-Essentials / PySide6-Addons 6.11.2 — Copyright (c) The Qt Company — LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only.
    用途: ADR-001 已采纳的 Qt 绑定；Addons 由 PySide6-Fluent-Widgets 的元数据传递拉入。

