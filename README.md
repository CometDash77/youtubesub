# YouTube 独立 AI 字幕浮窗 (youtubesub)

目标: 浏览器播放 YouTube, 网页最小化/被遮挡时仍能听声, 独立 always-on-top 桌面浮窗显示与播放进度同步的字幕.
模式: 原文 / 译文 / 双语. 翻译走 OpenAI-compatible API (Key/BaseURL/Model/Prompt 可配).

## 目录
- `userscript/` — Tampermonkey 用户脚本 (抓 timedtext + 传 cues + 同步播放状态).
- `desktop/` — Python + PySide6 桌面 App (WS 服务 / 调度时钟 / 翻译队列缓存 / 浮窗).
- `docs/DESIGN.md` — Phase 2 设计 (复用分类 + 架构).
- `docs/PROTOCOL.md` — localhost 线协议 v1.
- `docs/MANUAL-ACCEPTANCE.md` — 四层手动验收清单 (夹具演示 / 真实站点诊断 / 真 Tampermonkey / 真实 Key).
- `docs/adr/` — 架构决策记录.
- `requirements.txt` / `start-desktop.cmd` — 依赖与一键启动.
- `CONTEXT.md` — 本目录自包含的上下文 (新 session 从这里读起).

## 运行
1. 装依赖 (Python 3.12, 已实测版本见 `requirements.txt`): `pip install -r requirements.txt`.
2. 起桌面端: 双击 `start-desktop.cmd`, 或 `python desktop/app.py` (监听 127.0.0.1:9877).
   右键浮窗 = Mode / 字号 / 透明度 / Click-through (Ctrl+Alt+U 解锁) / Settings… / Quit.
3. 浏览器装 Tampermonkey, 导入 `userscript/youtubesub.user.js`.
4. 打开 YouTube 播放, 浮窗自动出现并同步字幕.
5. 首次使用在右键菜单 Settings… 填 Base URL / API Key / Model 并取消勾选 "Mock mode"
   (Key 只存本机 `%APPDATA%/SubOverlay/setting.json`, 不进 Git/日志/页面).

诊断端点 (只绑 loopback; `/status` 会回显字幕文本, 因此不要绑到非 loopback):
- `GET /health` → `{"ok":true,"version":1}`, 脚本连接前的存活探测.
- `GET /status` → 不用截图就能看"脚本连上了吗、浮窗在显示什么" (含 `hook_error`、`history`、`click_through`).
  PowerShell: `Invoke-RestMethod http://127.0.0.1:9877/status`

零安装试跑整条链 (真 Chrome + 真 userscript + 真桌面端, 临时设置 + mock 翻译, **不碰你的 Key**):
`python desktop/tests/browser_e2e.py --demo`
真实站点诊断: `python desktop/tests/browser_e2e.py --live "<url>" --proxy http://127.0.0.1:10809`
逐项手测清单见 `docs/MANUAL-ACCEPTANCE.md`.

## 测试
- `python -m pytest desktop/tests -q` — 全绿 (当前 88 passed; 含 7 条真浏览器 E2E, 无 Chrome 会 skip, 不算通过).
- `cd userscript; node --test "tests/*.test.mjs"` — 33 pass (必须用 glob 形式; 传目录会 MODULE_NOT_FOUND).

## 硬约束 (不做)
- 不做屏幕 OCR; 不做 Whisper ASR fallback; 不一条 cue 一个请求.
- 桌面端不直接抓 timedtext (pot 只能在页面内复用, yt-dual-subs 已证明).

## 继承关系
见 `THIRD-PARTY-NOTICES.md`. dkitle 只参考设计 (Rust 端无许可证);
yt-dual-subs (MIT) / transly (MIT) 可改写复用; LiveSubs / local-screen-translator (Apache-2.0) 可复用.
