# ADR-002: 浏览器端采用 Tampermonkey 用户脚本 (而非 MV3 扩展)

状态: 已接受 (grill-with-docs 访谈).
背景: 抓取 timedtext 必须在页面上下文复用播放器自带的 pot 请求 (yt-dual-subs 已证明桌面端独立抓轨不可行).
决定: Tampermonkey 脚本, 注入 page-context 拦截 fetch/XHR (沿用 dkitle 手法, 其 userscript 声明 MIT).
  注入方式是**三级回退** (2026-09-21 补, 由真实 youtube.com 的 `require-trusted-types-for script` 暴露):
  ① `GM_addElement` (扩展特权, 生产路径) → ② TrustedScript policy / 普通 script 元素 → ③ 直接 `new Function(code)`;
  第三级在 userscript 沙箱内 (`unsafeWindow !== window`) **主动跳过**, 因为把钩子装进错误的 realm 比失败更糟。
  "钩子没装上"经 `register.hook_error` 上浮; "钩子装上了但响应没有可用正文"经 `register.capture_error` 上浮。
后果: 用户需先装 Tampermonkey; MV3 扩展形态以后按需再补 (ADR 待定).
