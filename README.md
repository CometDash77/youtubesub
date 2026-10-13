# YouTube 独立 AI 字幕浮窗 (youtubesub)

目标: 浏览器播放 YouTube, 网页最小化/被遮挡时仍能听声, 独立 always-on-top 桌面浮窗显示与播放进度同步的字幕.
模式: 原文 / 译文 / 双语. 翻译走 OpenAI-compatible API (Key/BaseURL/Model/Prompt 可配).

## 目录
- `app/` — Electron (TypeScript) 桌面 App (WS 服务 / 调度时钟 / 翻译队列缓存 / 浮窗; #207 起 Python + PySide6 栈退役, 见 `docs/adr/ADR-001-desktop-stack-pyside6.md` 退役标注).
- `userscript/` — Tampermonkey 用户脚本 (TS 源码 `src/youtubesub.ts` + esbuild 产出 `youtubesub.user.js`; 抓 timedtext + 传 cues + 同步播放状态).
- `docs/DESIGN.md` — Phase 2 设计 (复用分类 + 架构).
- `docs/PROTOCOL.md` — localhost 线协议 v1.
- `docs/MANUAL-ACCEPTANCE.md` — 四层手动验收清单 (夹具演示 / 真实站点诊断 / 真 Tampermonkey / 真实 Key).
- `docs/adr/` — 架构决策记录.
- `start-desktop.cmd` — 一键启动 (依赖与构建已并入 `app/package.json`, 首启自动装).
- `CONTEXT.md` — 本目录自包含的上下文 (新 session 从这里读起).

## 运行
1. 装 Node.js (22 LTS 或更新). 双击 `start-desktop.cmd` 首次会自动 `npm install` + 构建; 手动等价: `cd app; npm install; npm run build`.
2. 起桌面端: 双击 `start-desktop.cmd`，CMD 会在启动后退出；系统托盘提供显示/隐藏浮窗、设置与调试窗口和退出。也可用 `cd app; npm start` 在命令行调试 (监听 127.0.0.1:9877)。
   右键浮窗仍可使用 显示内容（原文 / 译文 / 双语）/ 上下顺序对调 / 字号 ± / 背景浓淡 / 鼠标穿透（Ctrl+Alt+U 解锁）/ 设置 / 退出程序。
   菜单里的 **设置……** 是唯一入口（#209），打开**同一个**非模态窗口（三页：设置 / 调参 / 排障），默认落到设置页，调参 / 排障经窗口内页签到达；窗口底部一个「保存 / 取消」管全部三页（`Ctrl+S` 保存不关窗，`Esc` 关窗）。
3. 浏览器装 Tampermonkey, 导入 `userscript/youtubesub.user.js`.
4. 打开 YouTube 播放, 浮窗自动出现并同步字幕.
5. 首次使用在右键菜单「设置……」填 接口地址 / 密钥 / 模型名 并取消勾选「Mock 模式」
   (Key 只存本机 `%APPDATA%/SubOverlay/setting.json`, 不进 Git/日志/页面).

诊断端点 (只绑 loopback; `/status` 会回显字幕文本, 因此不要绑到非 loopback):
- `GET /health` → `{"ok":true,"version":1}`, 脚本连接前的存活探测.
- `GET /status` → 不用截图就能看"脚本连上了吗、浮窗在显示什么" (含 `hook_error`、`history`、`click_through`).
  PowerShell: `Invoke-RestMethod http://127.0.0.1:9877/status`

零安装试跑整条链 (真 Chrome + 真 userscript + 真 Electron 主进程, 临时设置 + mock 翻译, **不碰你的 Key**):
`cd app; npm run build; node tests/browser/browser-e2e-harness.ts --demo`
真实站点诊断: `cd app; node tests/browser/browser-e2e-harness.ts --live "<url>" --proxy http://127.0.0.1:10809`
逐项手测清单见 `docs/MANUAL-ACCEPTANCE.md`.

## 测试
- `cd app; npm run typecheck; npm test` — TS 栈全绿 (当前 **390 passed / 0 failed**; typecheck 0 error).
- `cd app; npm run test:e2e` — 10 条真 Chrome E2E (黑盒 `/status` 观察; 当前 9 绿 + 1 条已知夹具时序失败, 见 `docs/MANUAL-ACCEPTANCE.md` L0).
- `cd userscript; npm install; npm test` — **48 pass / 0 fail** (先构建产物再 `node --test "tests/*.test.ts"`; 测试直接 vm 载入 `youtubesub.user.js` 断言; glob 形式必须保留, 传目录会 MODULE_NOT_FOUND).
- userscript 源码 `src/youtubesub.ts` (TS 单文件); `npm run build` 重产出 `youtubesub.user.js` (esbuild 直驱, Tampermonkey 元数据 banner 逐字携带, 产物路径不变), `npm run typecheck` 查型.

## 硬约束 (不做)
- 不做屏幕 OCR; 不做 Whisper ASR fallback; 不一条 cue 一个请求.
- 桌面端不直接抓 timedtext (pot 只能在页面内复用, yt-dual-subs 已证明).

## 继承关系
见 `THIRD-PARTY-NOTICES.md`. dkitle 只参考设计 (Rust 端无许可证);
yt-dual-subs (MIT) / transly (MIT) 可改写复用; LiveSubs / local-screen-translator (Apache-2.0) 可复用.
