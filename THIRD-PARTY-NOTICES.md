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
