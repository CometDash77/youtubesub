# 手动验收清单 — youtubesub

给用户本人用的四层手测入口。**从 L1 往上，越往上越接近生产、越需要你本人动手。**

- 每层都写清：目的 / 前置 / 命令 / 通过标准 / 失败时记什么。
- 各层的**当前状态**都如实标注（"已实测通过" 只在真跑过的时候写）。
- 安全红线：`%APPDATA%/SubOverlay/setting.json` 里存你的真实 API Key。
  L1 / L2 用**临时 APPDATA + mock 翻译**，不会碰它；只有 L4 会写它。
  任何一层都不要把 setting.json 或含 Key 的日志贴出去。`/status` 会回显字幕文本，只允许 loopback。

---

## L0 · 自动基线（不需要人，先跑这个）

```
python -m pytest desktop/tests -q                       # 期望 83 passed（含 7 条真浏览器 E2E；无 Chrome 则 skip）
cd userscript; node --test "tests/*.test.mjs"           # 期望 33 pass / 0 fail（必须用 glob 形式）
node --check userscript/youtubesub.user.js              # 语法检查
```

通过标准：pytest 83 passed；node 33 pass 0 fail；7 条 E2E 没有被 skip
（skip 说明 harness 没找到 Chrome，这时浏览器侧**等于没验**，要记下来）。

E2E 用的测试特权（`--disable-web-security`、CDP `Page.setBypassCSP`）**只存在于测试 harness**，
真 Tampermonkey 不需要它们；看到这两项不要当成产品行为。

---

## L1 · 夹具演示：真 Chrome + 真 userscript + 真 app.py（零安装、零 Key）

**目的**：证明"页面钩子 → WS → 桌面端 → 浮窗"整条链在真浏览器里是通的，且 play/pause/seek/倍速/SPA 语义正确。
**状态**：上一会话已实测通过。

```
python desktop/tests/browser_e2e.py --demo [--seconds 30]
```

会弹出一个 Chrome 窗口（独立 profile、CORS 检查关闭，用来顶替 Tampermonkey 的 GM 授权）和一个真浮窗
（真 `desktop/app.py` 子进程，临时 APPDATA + mock 翻译）。夹具页自带按钮：
`Load captions / Play / Pause / +2s / -2s / 2.0x / 1.0x / "SPA: switch video"`。

逐项核对：

| # | 操作 | 期望 |
|---|---|---|
| 1 | 等约 2s | 浮窗出现 `FIXTURE ALPHA one` + 一行以 mock 标记 `【译】` 开头的译文 |
| 2 | 播放 | 字幕逐条按 cue 切换（不提前、不滞后到下一句） |
| 3 | 暂停 | 字幕冻结在原地（不消失、不继续走） |
| 4 | 播过最后一条 cue | 浮窗清空，只剩状态行（**不 hold** 最后一句） |
| 5 | `+2s / -2s` | 立即跳到跳转后的那条 cue |
| 6 | `2.0x / 1.0x` | 字幕推进速度跟随（`/status` 的 `rate` 同步变） |
| 7 | `SPA: switch video` | 出现新 source，旧 cue 不残留 |
| 8 | 拖动 / 拖边缘 resize | 浮窗跟随；放大后还能缩小 |
| 9 | 右键浮窗 | 菜单出现：Mode / Swap order / Font ± / Opacity ± / Click-through / Settings… / Quit |
| 10 | 开 Click-through，再按 **Ctrl+Alt+U** | 窗口恢复接收鼠标（这是 click-through 的唯一回路，必须验） |

随时可看机器可读状态（另开一个终端）：`Invoke-RestMethod http://127.0.0.1:<harness 打印的端口>/status`。
harness 只 kill 自己启动的 Chrome；**不要 kill 你自己常驻的 chrome.exe**。

**失败时记什么**：哪一步、`/status` 的 `state/orig/trans/playing/rate/hook_error` 原文、控制台里 `[youtubesub]` 开头的行。

---

### L1b · 未配置 provider（issue #1：没有译文时原文必须还看得见）

**目的**：base_url / model 都空、也没勾 Mock（= 装完第一次运行的状态）时，「没有译文」不得表现成「没有字幕」。
**状态**：显示层已改，自动验证见 `desktop/tests/test_overlay_labels.py`；**待你本人眼看一次**。

```
start-desktop.cmd          # 默认设置，不填任何模型
```

1. 打开任意带 CC 字幕的视频，等浮窗出原文；
2. 右键浮窗 → **Mode: original/translation/bilingual** 切到 `translation`。

核对：

- [ ] trans 模式下显示的是**原文**，不是空白（回退生效）
- [ ] 原文行前面是 **【原】**；整窗**不出现【译】**任何字样（没有编造的译文）
- [ ] bilingual 模式：原文行与译文槽之间有一条**常驻横向分割线**（译文为空时也在）
- [ ] 有真实译文时（L4 配好 provider）：translation 模式仍只显示译文，行为与以前一致

**失败时记什么**：`/status` 的 `state/orig/trans/trans_available/mode` 原文，以及浮窗截图。

---

## L2 · 真实站点诊断：把链路拆成三段看（真 youtube.com，仍无 Tampermonkey）

**目的**：区分"站点真的发请求了吗 / 我们的钩子真的抓到了吗 / 桌面端真的收到了吗"——三段分开看，避免瞎猜。
**状态**：**已定论（2026-09-21），不是产品问题，是浏览器指纹**。headless Chrome 下 youtube.com 返回
`200 + text/html + 0 字节`（请求 URL 里带 `cbr=HeadlessChrome`），站点自己也不显示字幕；换 **headed**（去掉 `--headless`）后
同一个 URL 返回 `200 + application/json + 8079 字节` 的 json3，userscript 解析出 **61 条 cue**，浮窗显示真实歌词 + 【译】译文。
证据留档：`.scratch/probe/logs/20260921-o3-evidence-summary.md`。

```
python desktop/tests/browser_e2e.py --live "https://www.youtube.com/watch?v=<带CC的视频>" ^
    --proxy http://127.0.0.1:10809 [--headless] [--seconds 20]
```

本机 DNS 被污染，**必须走代理** `127.0.0.1:10809`。
**不要加 `--headless`**：headless Chrome 会被 youtube.com 以"空正文"拒绝，`no_cues` 是环境结论、不是产品结论；
`--headless` 只在你想对比"指纹差异"时才用。输出逐行读：

| 输出字段 | 含义 |
|---|---|
| `timedtextSeenByTracer` | 站点自己确实请求了字幕轨（与我们的代码无关的独立观测） |
| `script` / `hookError` | userscript 是否注入成功、页面钩子是否装上（空 = 装上） |
| `capture_error`（`/status`） | 钩子看到了请求、但响应没有可用正文时的原因（空 = 正常）；非空即"站点/环境拒绝给正文" |
| `bridgeTrackKey` / `bridgeCueCount` | **我们的钩子**是否真的抓到并解析出 cue |
| `app orig/trans` | 桌面端是否真的收到并显示（`CAPTURED` 行 = 全链通） |

**被推翻的旧假设**：交接文档曾猜"YouTube 把 `window.fetch` 包装器换掉了"。实测钩子一直在链上
（tracer 取到的内层函数源码与 hook 包装器逐字一致）、XHR 钩子也在、合成事件能让 `cueCount` 从 -1 变 2，
而真实字幕请求走的是 **XHR**、响应正文为空——问题在正文，不在钩子。

**失败时记什么**：上面四个字段 + 控制台里 `TrustedScript` / `page hook injection failed` 之类的原文。
失败不算产品缺陷，如实记为"未验证"。

---

## L3 · 真 Tampermonkey 全场景（需要你装扩展）

**目的**：唯一能证明"生产路径"的层。L1/L2 都是拿测试特权顶替扩展能力的。
**状态**：**从未执行**（本机 Chrome 没装 Tampermonkey；推测 `GM_addElement` 能绕开 CSP/Trusted Types，但没有证据）。

前置：

1. Chrome 装 Tampermonkey，导入 `userscript/youtubesub.user.js`（`@run-at document-start`）。
2. 起真桌面端：双击 `start-desktop.cmd`，或 `python desktop/app.py`（监听 `127.0.0.1:9877`）。
3. `Invoke-RestMethod http://127.0.0.1:9877/health` 应回 `{"ok":true,"version":1}`。

手测项：

- [ ] 有**人工字幕**的视频：浮窗出现字幕并与播放同步
- [ ] **自动字幕（ASR）**的视频：同样抓到
- [ ] 切换字幕语言：浮窗内容跟着换语言（不是停在旧语言）
- [ ] 最小化 / 被其它窗口遮挡：字幕照常（这是本项目的核心动机）
- [ ] play / pause / seek / 0.5x–2x
- [ ] SPA 切视频（页面内点进另一条视频）：出现新 source、旧 cue 不残留
- [ ] 断线重连（把 app 关掉再开）：不跳回旧时间、不重复推送
- [ ] 拖动 / resize / 置顶 / click-through 后 **Ctrl+Alt+U** 解锁
- [ ] 页面左下状态面板：显示 `connected`；若注入失败应显示 `[NO PAGE HOOK]`
- [ ] 钩子失败时浮窗状态行应说 page hook NOT installed…，而不是 waiting for subtitles

**失败时记什么**：DevTools Console 全文（`[youtubesub]` 行、`TrustedScript` / CSP 报错）、页面面板文字、
`/status` 的 `hook_error`，以及 Chrome 版本与影片 URL。

---

## L4 · 真实 AI 翻译链路（需要 Base URL + Key + Model）

**目的**：只有 mock 被验证过；真实 HTTP 到 OpenAI-compatible 端点一次都没发过。
**状态**：**从未执行**（等 Key）。

前置：L3 已能拿到原文；然后右键浮窗 → **Settings…** 填 Base URL / API Key / Model，
Protocol 先留 `auto`，**取消勾选** "Mock mode (no real API)" → OK（写入 `%APPDATA%/SubOverlay/setting.json`）。

核对：

- [ ] 译文出现且语言合理；模式切 `original / translation / bilingual` 三态都正常（右键菜单 Mode）
- [ ] `Swap bilingual order` 生效
- [ ] 重复播放同一段：命中本地缓存（`data/translations.db`），不再发请求
- [ ] 断网 / 填错 Key / 超时：**原字幕不受影响**，不崩、不空白
- [ ] `auto` 与显式 `responses` / `chat-completions` 两种协议各验一次
- [ ] 长视频连续播放：队列不堆积（翻译滞后可接受，但不逐 cue 打请求）

**失败时记什么**：Settings 里的 Base URL 与 Model 名（**Key 不要贴**）、HTTP 状态码、`/status` 的 `trans`。

---

## 记录模板

| 层 | 日期 | 结果 | 证据 / 失败原文 | 跟进 |
|---|---|---|---|---|
| L0 自动基线 | | | | |
| L1 夹具演示 | | | | |
| L2 真实站点诊断 | | | | |
| L3 真 Tampermonkey | | | | |
| L4 真实 Key | | | | |

配套：`requirements.txt`（依赖）、`start-desktop.cmd`（一键起桌面端）、`README.md`（运行章节）。
计划与断点见 `.scratch/handoff/` 下的交接文档与 `PROGRESS.md`。
