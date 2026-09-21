# ADR-004: 翻译单位 = 句子组, 不逐 cue 请求

状态: 已接受.
背景: 自动字幕是滚动碎片, 逐 cue 翻译既贵又碎 (yt-dual-subs 用分句解决, transly 用批量).
决定: 桌面端按 lastOff 词级停顿分句 (PAUSE_BREAK_MS=600, 每组至多 32 词/280 字符, 最大停顿处回切),
以句子组为翻译单位; 对齐翻译要求模型返回与组内 cue 数一致的行, 严格校验后逐 cue 缓存 (trans 随 cue).
后果: 需补充 yt-dual-subs 没有的上下文 (前后句, 见 DESIGN.md §翻译).
