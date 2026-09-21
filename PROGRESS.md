# PROGRESS — youtubesub 进度与交接记录

最后更新: 2026-09-21 (**真浏览器 E2E 会话之后**; 用户已喊"告一段落, 暂停推进")。
状态一句话: 桌面端与浏览器侧**都已在真实浏览器里跑过** —— pytest **65 passed** (~16s)、node **33 passed**,
真 Chrome E2E 7 条全绿 (夹具页 + 真 userscript + 真 app.py, 只经 `/status` 黑盒观察), 并据此抓出修掉 **4 个真 bug**。
仍未验证的三件: **真 Tampermonkey 全场景**、**真实 AI Key 翻译链路**、**真实 youtube.com 抓不到 cue 的根因** (用户已归入手动验收)。

> 恢复入口: 先读交接文档 [.scratch/handoff/20260921-111208-E2E与手测入口.md](.scratch/handoff/20260921-111208-E2E与手测入口.md)
> (本轮全部改动 / 4 个 bug / 未验证项 / 坑都在里面, 并**取代**本文件旧有的"浏览器侧结论仍不可信"结论),
> 再读 [docs/MANUAL-ACCEPTANCE.md](docs/MANUAL-ACCEPTANCE.md)、第 5 节 (命令) 与第 7 节 (断点顺序)。
> 本文件第 0.1 节及以下保留为历史记录。

---

## 0.00 本次会话的增量 (2026-09-21 下半场: 评审 + O3 定论 + 可见化批次)

| # | 做了什么 | 证据 |
|---|---|---|
| 1 | 双轴评审 (Standards/Spec) 对 E2E 会话的 11 文件变更集, 两个子代理独立产出 | 0 硬违规 + 9 条判定 smell; Spec 9 条 (最严重: `test_hotkey.py` 曾读用户真实 setting.json) |
| 2 | **O3 定论**: 真实 YouTube 抓不到 cue **不是产品缺陷, 是 headless 指纹** | headless `200/text/html/0B` vs headed `200/application/json/8079B`, 桥接 61 条 cue, `/status` `state=ok` 显示真实歌词 + 【译】 |
| 3 | 补 `capture_error`: 钩子看到请求但响应空/非 JSON 时上浮到 `/status` + 浮窗状态行 + 面板 `[NO CAPTION BODY]` | node 33 → **37**; pytest 65 → **68** (新增 3 条 python + 4 条 node) |
| 4 | `test_hotkey` 改用临时 APPDATA (不再读真实 setting.json); 补 `unsafeWindow` 沙箱跳过分支的测试 | 同上测试批次 |
| 5 | 新增 `--demo`/`--live` 之外的诊断留档: `.scratch/probe/` (3 个探针 + `_tee` 落盘) 与 O3 证据 | 见 `.scratch/probe/logs/20260921-o3-evidence-summary.md` |
| 6 | 收尾验证: 全量 pytest **68 passed / 0 skipped** —— 7 条真浏览器 E2E 真实执行, 确认上批 fetch 路径改动没有打破夹具路径 | `.scratch/probe/logs/20260921-115452-full-pytest.log` |

**未验证**: `--headless` 之外的真实站点行为、真 Tampermonkey、真实 Key —— 见 §7。

---

## 0. 本 session 的增量 (真浏览器 E2E 会话, 2026-09-21)

| # | 做了什么 | 证据 |
|---|---|---|
| 1 | 真浏览器 E2E harness: 夹具 http 服务 (`/watch` + `/youtube/api/timedtext` + 支持 Range 的 `/media.wav`) + 独立 profile/端口的 Chrome 启动器 + 极简 CDP 客户端 (只用 websockets) + 真 `app.py` 子进程 (临时 APPDATA + mock) | `desktop/tests/browser_e2e.py`; `test_browser_e2e.py` 7 条 (无 Chrome 则 skip) |
| 2 | 修 4 个真 bug: cues 清零播放时钟 / click-through 无解锁路径 (新增 Ctrl+Alt+U 全局热键) / 菜单构造时序 / YouTube Trusted Types 让页面钩子静默失败 | 每个都是先红后绿; 详见交接文档 §2 |
| 3 | 钩子失败必须可见: `register` 帧携带 `hook_error` → engine meta → `/status` → 浮窗状态行 + 页面面板 `[NO PAGE HOOK]` | `test_engine.py` 2 条、`test_overlay_status.py` 2 条、node 4 条 |
| 4 | 两个人入口: `--demo` (零安装零 Key 夹具演示)、`--live URL` (真实站点三段诊断 tracer/hook/app) | 均实跑过; 见交接文档 §3 |
| 5 | 基线 50 pytest + 29 node → **65 pytest + 33 node** | `python -m pytest desktop/tests -q`; `node --test "tests/*.test.mjs"` |

**没做的事 (不要以为做了)**: 真 Tampermonkey / 真实 Key 翻译链路 / 真实 YouTube 抓到 cue —— 仍未验证。

---

## 0.1 上一 session 的增量 (保留)

| # | 做了什么 | 证据 |
|---|---|---|
| 1 | 补完 Node 测试台: 0 个真实断言 -> **29 个**, 修掉已知的 `window.addEventListener` 桩缺失 (原来 `load()` 直接抛 TypeError) | `node --test "tests/*.test.mjs"` -> 29 pass / 0 fail (227ms) |
| 2 | 新增跨语言解析一致性夹具 (10 例), **JS 与 Python 两侧断言同一份文件** | pytest 36 -> **50 pass**, 其中 11 个来自 `test_parse_parity.py` |
| 3 | 修 userscript 的真 bug/缺陷 3 处 (见 2.6) | 每个都有对应 node 断言 |
| 4 | 新增 `GET /status` 诊断端点 (server + engine + app 三处) 并补测 | 3 个新 pytest (`test_health_and_status_routes` 等) |
| 5 | 完成 P1-4 的一条真实证据: 不带 pot 的裸 timedtext 请求返回 200 且 **0 字节** | 经代理实测, 见 2.9 |
| 6 | E2E 环境勘察完成 (Chrome 路径/版本、代理、扩展现状、CDP/PNA 风险) + 方案锁定 | 第 3.0 节, 未实施 |

**没做的事 (不要以为做了)**: 真实 Chrome / 真实 YouTube / 真实 Tampermonkey / 真实 AI 翻译 —— 全部仍未验证。E2E 没有留下半成品代码, 下个 session 是干净的起点。

---

## 1. 架构 (已定稿)

```
YouTube 页面 (Tampermonkey 脚本)
  -> 页面上下文拦截播放器自身的 timedtext 请求 (复用 pot, 不自建 URL)
  -> json3 解析为 cues, 全量推送
  -> 播放器事件 -> sync{video_time_ms,playing,playback_rate,timestamp}
  -> WebSocket ws://127.0.0.1:9877/ws (JSON 每帧, 见 docs/PROTOCOL.md)
桌面 App (Python 3.12 + PySide6 6.11.2)
  -> WS 服务 + /health + /status + Origin 白名单
  -> 按 source 存 cue (排序, trans 随 cue)
  -> 播放时钟插值 (paused 冻结, playing 时 base+elapsed*rate) + transit 补偿 + gap-hold TTL
  -> lastOff 分句 = 翻译单位; 优先级队列 (urgent/附近/远处) + SQLite 持久缓存
  -> OpenAI-compatible provider (auto/responses/chat-completions, 重试/退避/429)
  -> always-on-top 浮窗 (原文/译文/双语)
```

硬约束 (设计决定): 不做屏幕 OCR; 不做 Whisper ASR; 不逐 cue 请求; 桌面端不自行抓 timedtext.

---

## 2. 已完成 (有证据)

### 2.1 研究与设计
- 5 个参考仓库 recon 完成, 许可证逐个核查 (见第 6 节)。
- 复用分类 (直接复用/改造复用/仅参考/必须新写) 写入 `docs/DESIGN.md`。
- 访谈锁定: PySide6 + Tampermonkey + 真实 Key 稍后提供 (期间 Mock 验证)。
- 文档落地: `README.md` / `CONTEXT.md` / `docs/DESIGN.md` / `docs/PROTOCOL.md` / `docs/adr/ADR-001..004` / `THIRD-PARTY-NOTICES.md`。

### 2.2 桌面端模块 (desktop/, 全部写完)
| 文件 | 行数 | 内容 | 验证 |
|---|---|---|---|
| suboverlay/protocol.py | 135 | json3 解析/lastOff/cue 校验/端点修复 + `STATUS_PATH` | 单测 + 跨语言夹具 |
| suboverlay/clock.py | 58 | 播放时钟/transit 补偿/gap-hold TTL/重叠回查 | 单测 |
| suboverlay/sentences.py | 81 | lastOff 分句 (600ms/32词/280字/最大停顿回切) | 单测 |
| suboverlay/settings.py | 59 | %APPDATA%/SubOverlay/setting.json/.bak 修复/脱敏 | 单测 |
| suboverlay/provider.py | 252 | OpenAI-compatible 客户端, endpoint 适配, 重试退避 Retry-After, models 发现 | 单测 |
| suboverlay/queue_cache.py | 194 | SQLite 持久缓存(TTL)+SHA-256 identity(不含Key)+优先级队列+去重+按源取消+退避丢弃 | 单测 |
| suboverlay/engine.py | ~215 | source 存储+时钟+分句+调度+seek 取消+prefetch+显示状态 + `status()` 快照 | 单测(管线级) |
| suboverlay/server.py | ~135 | websockets 127.0.0.1, /ws + /health + **/status**, Origin 白名单, 坏帧计数 | 真实 WS 集成测试 |
| suboverlay/overlay.py | 294 | 置顶浮窗: 无边框/半透明圆角/描边字/双语/历史缓冲/拖动/resize/click-through+解锁/右键菜单钩子 | resize 回归测试 + 真实截图像素证据 |
| app.py | ~175 | 事件泵/tick/设置对话框(含字号)/右键菜单/置顶复位 + `_status()` 诊断 | 真实启动运行 |

### 2.3 自动测试
- **pytest: 50 passed** (最近实测 5.11s, 目录 `desktop/tests`)。
  覆盖: json3 解析(含 ASR lastOff/空段/零时长) / cue 校验与端点修复 / 时钟插值与 transit 钳制 / gap-hold TTL 与末 cue 不 hold /
  重叠回查 / 分句(含 CJK 计数与长组回切) / endpoint 适配 / unpack_numbered 全有或全无 / 状态码可重试判定 /
  缓存 identity 不含 Key 且键序无关 / SQLite 往返 / 设置损坏转 .bak / 队列优先级+去重+按源取消 / 退避丢弃 normal /
  真实 WS 往返与 Origin 拒绝与坏帧计数 / 引擎全管线(mock 翻译) / 跨重启缓存命中 / seek 取消重同步 / 暂停冻结 /
  浮窗 resize 放大后可缩小 / **+ 本轮: /health 与 /status 路由、无 provider 不泄露、provider 抛错不 500、stats 计数、跨语言解析夹具 11 例**。
- **node: 29 passed** (`cd userscript; node --test "tests/*.test.mjs"`)。
  覆盖: 用户脚本在沙箱内可加载 / 页面钩子注入(含 GM_addElement 缺失回退) / parseJson3 夹具与边界 /
  normKey 对 pot/fmt/tlang/c/sig 轮换稳定 / URL 辅助函数 / cuesSignature / **生成的页面注入代码被真实执行并验证 fetch+XHR 两条拦截路径与畸形 body 不抛** /
  Bridge 上线帧序列 / health 失败重连 / 指数退避封顶 / close-retry-stop 状态机 / 状态面板点击语义 /
  sync 反映播放器状态 / 未 open 时 send 无副作用 / onTimedtext 推送与线上格式 / pot 轮换不重复推 /
  **同 cue 数不同文本必须重推 (回归)** / 空 payload 忽略 / **重连回放保留原 timestamp** / SPA 切源与新源注册 /
  poll 绑定后出现的 video / **无 GM_xmlhttpRequest 也能连** / 全会话帧逐条通过协议契约校验 / 真实 cue 满足桌面端 coercer。
- 测试台文件: `desktop/tests/fake_browser.py` (假浏览器, 经真实 WS 推流), `userscript/tests/fixtures/parse_cases.json` (共享夹具)。
- **更新 (E2E 会话)**: pytest **65 passed** (~16s) / node **33 pass**; 新增真浏览器 E2E 7 条 (`test_browser_e2e.py`), 以及热键 4 条、浮窗状态 2 条、引擎 2 条。

### 2.4 真实运行验证 (上一 session, 仍有效)
- 桌面 App 多次真实启动常驻, 假浏览器驱动推送 14s 播放 + 4s 暂停, 驱动进程 exit 0。
- 截图像素分析 (System.Drawing 采样窗口区域): 播放中白字(原文)+黄字(译文)均渲染; 暂停且已过末 cue 后字幕清空仅留状态行 (符合预期)。
- 用户本人实测: 窗口拖动/resize 生效, 几何写入 setting.json 并在重启后恢复。

### 2.5 用户反馈修复 (上一 session)
- 去掉窗口最小尺寸限制: `setMinimumSize(0,0)`, resize 仅保留 1px 防零尺寸。
- 字号下限 8->6, 默认 15->10, 描边 2.0->1.5, 设置对话框新增字号输入框。
- 修掉 resize 严重 bug: 放大后往内拖无法缩小 (根因: 边缘判定每帧重检)。修法: 按下时锁定边缘 `_resize_edge`。已加回归测试。

### 2.6 浏览器用户脚本 (userscript/youtubesub.user.js, **471 行**; 注入方式见 ADR-002 的三级回退) — 当时改动 3 处
已写完的内容: Tampermonkey 头 (@match youtube / @grant GM_xmlhttpRequest,GM_addElement / @connect 127.0.0.1 / document-start / MIT);
纯函数 (normKey / trackKindFromUrl / trackLangFromUrl / isTimedtextUrl / videoIdFromLocation / parseJson3 / cuesSignature);
buildPageHookCode() 生成页面上下文注入代码 (GM_addElement script, 拦截 fetch + XHR, CustomEvent 回传, 注明 dkitle MIT 出处);
Bridge: /health 探测 -> WS -> 指数退避重连 (3s..30s) -> 缓存回放 (保留原 timestamp); SPA 轮询新建 source_id;
播放器事件 timeupdate/play/pause/seeked/ratechange; timedtext 去重推送; 左下状态面板; 末尾 `window.__youtubesub` 测试面。

本轮修的 3 处 (都有 node 断言):
1. **去重逻辑从"cue 数相同即丢"改为"内容签名相同才丢"** (`cuesSignature`)。
   原逻辑的漏洞: normKey 会剔除 `tlang`, 所以"切到另一个轨道但 cue 数恰好相同"的新轨道会被当重复丢掉, 浮窗停留在旧语言。
2. **`health()` 在没有 GM_xmlhttpRequest 时从 `cb(false)` 改为 `cb(true)`**。
   原逻辑: 探测函数不存在 -> 永远探测失败 -> 永远不尝试连 WS (脚本在非 Tampermonkey 环境下彻底不工作)。
3. **`trackLangFromUrl` 优先取 `tlang`**。原实现取第一个 `lang|tlang` 匹配, 于是 `lang=en&tlang=zh-Hans` 被标成 `en`,
   与"返回的 cue 文本其实是译文"不符 (只影响元数据, 桌面端缓存键不含 lang)。

⚠ **验证程度 (此行已被 E2E 会话推翻)**: 当时只有 `node --check` + 沙箱 29 条断言; 现在浏览器侧已在**真 Chrome** 里跑过 ——
E2E 7 条全绿, 并因此修掉 Trusted Types 静默失败等 4 个 bug (见交接文档 §2)。真 Tampermonkey 全场景仍未验证。

### 2.7 Node 测试台 (本轮从脚手架补成真测试)
`userscript/tests/userscript.test.mjs` (698 行)。沙箱提供 window/document/location/crypto/URL/CustomEvent/WebSocket/定时器,
可控时钟 (`__clock`), GM_* 桩, 可控 video 元素与 `querySelector('video')`, 记录所有发出的帧 (`__sent`)。
页面注入代码不是只做字符串断言, 而是在独立的 vm 上下文里**真实执行**并验证 fetch/XHR 两条拦截路径。

### 2.8 `GET /status` 诊断端点 (本轮新增)
- `protocol.STATUS_PATH = "/status"`; `WSServer(..., status_provider=callable)`。
- 返回 `{ok,version,stats}` + provider 的字典; provider 抛错 -> 记 `status_error` 且仍 200; 没有 provider -> 只回 stats, 不泄露 UI 内容。
- `Engine.status()` 返回 `{sources, active_source, display}` (只读, 不驱动调度); `App._status()` 补上 state/orig/trans/playing/rate/title/mode/order/history/click_through。
- 用途: 用户/测试不用截图就能确认"脚本连上了吗、浮窗现在显示什么"; 也是下个 session 做浏览器 E2E 的黑盒观察口。

### 2.9 P1-4 证据: 裸 timedtext 无 pot 返回空 body
经代理 `Invoke-WebRequest https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en` -> **状态 200, 长度 0 字节**。
印证设计判断: 桌面端不自行抓 timedtext (拿不到内容), 必须在页面上下文复用播放器自己的请求(带 pot)。

---

## 3. 未完成 / 待做

### 3.0 ✅ 已完成 (E2E 会话): 真实浏览器端到端 —— 以下为当时的方案, 保留作记录

实现与结果: harness `desktop/tests/browser_e2e.py` + 断言 `desktop/tests/test_browser_e2e.py` (7 条, 无 Chrome 则 skip)。
(A) 夹具页 + 真 Chrome + 真桌面栈: **已全绿**; (B) 真实 YouTube: 已跑过多次但**尚未抓到 cue** (根因未定论, 见交接文档 §4)。

**目标**: 用真实 Chrome 证明浏览器侧四件事 —— (a) 页面注入在真实主世界能抓到真实 timedtext 请求; (b) 真实 Origin 的 WS 能连上真实桌面端;
(c) 真实 cue 文本真的走到 Engine/浮窗; (d) play/pause/seek/rate/SPA 的 sync 语义真的正确。

**分两层做, 先做 (A) 再做 (B)。**

**(A) 本地夹具页 + 真实 Chrome + 真实桌面栈 (确定性, 建议落成 pytest)**
1. Python `http.server` 起在 `127.0.0.1:<port>`, 页面 URL **必须是** `http://127.0.0.1:<port>/watch?v=abcdef12345`。
   原因: WS 的 `Origin: http://127.0.0.1:<port>` 才能通过 `server.origin_allowed` (它认 "127.0.0.1" 子串);
   若把夹具页放在 `*.localhost` 域, Origin 会变成 `http://www.youtube.com.localhost:<port>` 而被 403。
2. 页面 fetch 的 timedtext URL **必须含字面量 'youtube'** 才满足 `isTimedtextUrl`。用同源路径即可:
   `http://127.0.0.1:<port>/youtube/api/timedtext?v=abcdef12345&lang=en&kind=asr&fmt=json3&pot=<变化值>`
   (路径里的 `/youtube/api/timedtext` 同时命中 `/timedtext|json3` 与 `"youtube"`)。
3. 媒体: 服务端用 Python 直接生成一段 WAV (44 字节头 + 8kHz 单声道 8bit 静音, 60s 约 480KB), 页面放进**真实 `<video>`** 元素并播放;
   这样 `currentTime`/`timeupdate`/`play`/`pause`/`seeked`/`ratechange` 全部是真的。配 `video.muted=true`。
4. 启动 Chrome (实测路径与版本: `C:\Program Files\Google\Chrome\Application\chrome.exe`, **153.0.8010.48**):
   ```
   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=<临时目录> ^
     --remote-allow-origins=* --no-first-run --no-default-browser-check ^
     --autoplay-policy=no-user-gesture-required --mute-audio --disable-web-security about:blank
   ```
   `--disable-web-security` **只为本测试存在**: 真实 GM_xmlhttpRequest 会旁路 CORS, 而 CDP 裸注入没有 GM 上下文,
   夹具的 `/health` 探测是跨源 (页面 origin -> 127.0.0.1:9877) 会被 CORS/PNA 拦。生产走 Tampermonkey 不需要它。
5. CDP 流程 (用 `websockets` 裸连即可, 无需 puppeteer): `GET http://127.0.0.1:9222/json/list` 取 page target 的 `webSocketDebuggerUrl`
   -> 连 WS -> `Page.enable`/`Runtime.enable` -> **`Page.addScriptToEvaluateOnNewDocument`** 注入 (GM shim + 用户脚本源码;
   这正是 `@run-at document-start` 的等价物) -> `Page.navigate`(夹具页) -> 等 `Page.loadEventFired` -> `Runtime.evaluate` 驱动页面。
6. GM shim (注入源码前置):
   `window.GM_addElement = (tag,attrs) => {...}`; `window.GM_xmlhttpRequest = (o) => fetch(o.url,{method:o.method||'GET'}).then(r=>o.onload&&o.onload({status:r.status})).catch(()=>o.onerror&&o.onerror())`。
7. 观察口用**本轮新加的 `GET /status`**: 跑真实 `app.py` 子进程 (`python desktop/app.py`), 然后 `GET http://127.0.0.1:9877/status`;
   或在同一进程里起真实的 `WSServer + Engine` (真实模块) 并读 `engine.tick()`。
8. 断言: `state=='ok'`; `orig` 等于夹具里写死的确切句子; `trans` 含 `【译】`; `playing` 跟随 play/pause;
   改 `currentTime` 后 `orig` 变成跳转后的 cue; `rate` 传到 display; 页面 `history.pushState` 换 v= 后出现新 source 且旧 cue 不残留。
9. 收尾: 无 Chrome 时 **skip** (不要 fail); 结束时杀掉 Chrome、关掉 http server、释放 9877。

**(B) 真实 YouTube (尽力而为, 作为证据而非门禁)**
- 同样的 CDP 注入, 但 Chrome 走代理 `--proxy-server=http://127.0.0.1:10809` (已实测 youtube.com 200), 打开带 CC 的视频,
  用 player API 强制开字幕 (`document.querySelector('#movie_player').loadModule('captions')` /
  `setOption('captions','track',{languageCode:'en'})`), `mute()+playVideo()`; 记录 `/status` 与抓到的帧。
- 已知风险: YouTube 机器人检测 / 选的视频没有 CC / headless 不播 / consent 弹层。失败就如实记为"未验证", 不要伪装。

**其他已知坑 (已勘察)**: 本机 **没有装 Tampermonkey** (Chrome User Data 里没有该扩展) -> 真正的"Tampermonkey 原生"验证需要用户手动装扩展并导入脚本,
下个 session 可以先把 (A)+(B) 跑绿, 再给用户一份 Tampermonkey 手测清单 (或在用户同意时装扩展)。
另外注意: **PNA (Private Network Access)** 会拦"公网页面 fetch 到 127.0.0.1", WebSocket 不受 CORS/PNA 限制但 `/health` 探测受影响 —— 这也是 (A) 用本地 origin 更稳的原因。

### 3.1 P0 — 其余
- (已完成, 保留记录) Node 测试台补完 —— 见 2.7。
- (已完成) 真实 Chrome 全场景: 夹具 E2E 7 条 + `--demo`/`--live` 人工入口 —— 见 3.0。
- ⚠ **真 Tampermonkey 全场景仍未做** (本机 Chrome 没装该扩展, 需用户手动装): 推测 `GM_addElement` 能绕开 CSP/Trusted Types, 但**没有证据**。

### 3.2 P1 — 核心目标相关
- **真实 AI 翻译链路未验证**: 等用户提供 **Base URL + API Key + Model**。拿到后要验证: 成功显示译文 / 超时或异常时不破坏原字幕 /
  原文-译文-双语三模式 / 重复播放命中缓存 / `/models` 发现 / Responses 与 Chat Completions 两条协议。
  （Mock 已被引擎管线测试覆盖; 真实 HTTP 到 OpenAI-compatible 端点一次都没发过。）
- (已部分完成) 经代理抓裸 timedtext 的证据 —— 见 2.9; 剩下的是 (B) 真实 YouTube 抓取。

### 3.3 P2 — 打磨项
1. 历史字幕行: overlay 已有 `self.history` 缓冲但 `_rows()` 未渲染, 目前看不到上一句 (`/status` 已经能回显 history, 便于验证)。
2. (已完成) `Click-through (Ctrl+Alt+U to unlock)` 文案对应的热键已实现 (`desktop/suboverlay/hotkey.py`); 它是 click-through 唯一的解锁回路 (见交接文档 §2 bug#2)。
3. (已完成) `requirements.txt` (PySide6-Essentials / websockets / pytest —— **不需要 requests**, 代码里没有用到) + `start-desktop.cmd`。
4. (已完成) README 运行章节已按最终实现重写 (含 `/health`、`/status`、`--demo`/`--live`); 另新增 `docs/MANUAL-ACCEPTANCE.md` 四层手测清单。
5. 打包分发 (PyInstaller 等) 未做。
6. 多视频/多标签同时打开时 source 切换是 last-writer-wins (`active_source`), 无选择 UI。

---

## 4. 已知问题与注意事项
- 测试台 `desktop/tests/fake_browser.py` 与真实 App 端口必须一致 (默认 9877); 端口被占则 App 起不来但不会报错退出。
- `setting.json` 位于 `%APPDATA%/SubOverlay/`, **里面存 API Key**: 不要提交、不要贴日志。缓存库在 `data/translations.db` (不含 Key)。
- 桌面端访问公网 (AI API) 走 `urllib`, 会读 `HTTP_PROXY/HTTPS_PROXY`; 本机 DNS 被污染, 直连 YouTube 不通, 必须走代理 `127.0.0.1:10809`。
  环境变量里有 `NO_PROXY=localhost,127.0.0.1,::1,...`; 测试里若用 `urllib` 请求 loopback 记得它会读代理 (用 `http.client` 更稳, 见 `test_server_integration.py`)。
- userscript 的 WebSocket 会带 `Origin: https://www.youtube.com`, 服务端白名单允许 youtube.com 与 localhost; 其它 Origin 直接 403。
- **`/status` 会回显字幕文本** (仅 loopback, 无 provider 时不回显)。不要把服务绑到非 loopback。
- `node --test tests` (传目录) 在 Node 22.23.1 上会 `MODULE_NOT_FOUND`; 用 `node --test "tests/*.test.mjs"`。仓库里**没有 package.json** (node 测试不依赖 npm)。
- PowerShell 执行策略会拦住 `.ps1` (截图脚本等), 需 `-ExecutionPolicy Bypass`; `npm.ps1` 同样受限, 用 `npm.cmd` 或 node 直接调。
- 浮窗渲染字号与描边都走 `QPainterPath` 描边+填充; 窗口很小时按行裁剪, 属预期。
- 本机浏览器是用户自己在用的 (有若干 `chrome.exe` 常驻), **不要 kill 它们**; E2E 必须用独立 `--user-data-dir` + 独立调试端口。
- `__pycache__` 与 `data/translations.db` 是运行产物; 项目**不是 git 仓库** (无 .git), 所以没有版本控制兜底 —— 改动要谨慎。

---

## 5. 如何运行 (恢复开发用, 均可直接复制)

跑 Python 测试 (65 passed, ~16s; 含 7 条真浏览器 E2E, 无 Chrome 则 skip):
```
python -m pytest D:\Documents\vibe\youtubesub\desktop\tests -q
```

跑 Node 测试 (33 passed, ~0.25s) —— 注意用 glob 形式:
```
cd D:\Documents\vibe\youtubesub\userscript
node --test "tests/*.test.mjs"
```

语法检查用户脚本:
```
node --check D:\Documents\vibe\youtubesub\userscript\youtubesub.user.js
```

启动桌面端 (会弹出浮窗并监听 127.0.0.1:9877):
```
python D:\Documents\vibe\youtubesub\desktop\app.py
```

探测存活 / 看浮窗当前状态 (PowerShell):
```
Invoke-RestMethod http://127.0.0.1:9877/health
Invoke-RestMethod http://127.0.0.1:9877/status
```

用假浏览器驱动做 GUI 验证 (另开一个终端, App 已启动时):
```
python D:\Documents\vibe\youtubesub\desktop\tests\fake_browser.py 9877
```

人工验收入口 (临时 APPDATA + mock 翻译, **不碰你的设置与 Key**):
```
python D:\Documents\vibe\youtubesub\desktop\tests\browser_e2e.py --demo [--seconds 30]
python D:\Documents\vibe\youtubesub\desktop\tests\browser_e2e.py --live "<url>" --proxy http://127.0.0.1:10809 [--headless] [--seconds 20]
```

一键启动桌面端 (真设置, 端口 9877): `start-desktop.cmd`; 依赖: `pip install -r requirements.txt`。

截图 (PowerShell 执行策略需绕过):
```
powershell -NoProfile -ExecutionPolicy Bypass -File D:\vibe-research\shot.ps1 -out D:\vibe-research\shot.png
```

---

## 6. 复用与许可摘要 (详见 THIRD-PARTY-NOTICES.md)
- yt-dual-subs (MIT, (c) 2026 Gythiro): 直接复用语义 — parseJson3+lastOff, lastOff 分句与常量, trans 随 cue, 对齐协议与 unpack 校验, lane 队列模型。
- transly (MIT, (c) 2026 Haitian): 吸收设计并 Python 重写 — provider 配置模型, protocol auto, SSE-or-JSON 归一, 缓存 identity(SHA-256), 单一并发权威, 输出严格校验; 并补其缺失的 429/Retry-After/退避/队列取消。
- LiveSubs (Apache-2.0, (c) 2026 Diva143V): 浮窗 UX 移植思路 (置顶/透明度/描边/双语/历史/几何持久化); 刻意避开其透明度双重相乘与单向 click-through 缺陷。
- local-screen-translator (Apache-2.0, 2025 Neverland-XFX): 仅参考 (其 DOM 回显架构不采用), 吸收 DPI 感知与 localhost sink 安全教训。
- dkitle (ywxt): 桌面 Rust 端无许可证 -> 只参考线协议与时钟插值设计, 未抄代码; 其 userscript 声明 MIT, 页面注入手法已改写并注明出处。

---

## 7. 断点与下一步顺序 (下个 session 从这里开始)

当前状态: App **未运行** (端口 9877 已释放); 没有遗留的 Chrome/CDP 进程 (用户自己的 chrome.exe 不要动)。
最新断点文档: `.scratch/handoff/20260921-114657-O3定论与失败可见化.md` (与本文件冲突时以它为准; 旧的 114710 已改为指向它的占位)。

0. **P0 思维对齐已落盘** (2026-09-21): 五类清单 (D1-D5 / K1-K9 / C1-C12 / O1-O9 / F1-F6 + 可疑遗漏 A1-A4、B1-B9) 原样写入
   `.scratch/alignment/20260921-112756-E2E与手测入口.md` (含文件头与人称读法)。**O 类待决项与 A/B 类的"请裁决"项尚未裁决**,
   等用户逐条回答后再更新该文件。**不要重做对齐**。
1. (已完成) 第 3.0 节的 (A) 夹具 E2E + (B) 真实站点诊断入口 —— 见 3.0 与交接文档 §3。
2. (已完成) `requirements.txt` / `start-desktop.cmd` / README 运行章节 / `docs/MANUAL-ACCEPTANCE.md` —— 见 3.3。
3. 用户手动验收: 按 `docs/MANUAL-ACCEPTANCE.md` 逐层做 (L3 真 Tampermonkey、L4 真实 Key 需要用户参与)。
4. (已定论 2026-09-21) "真实 YouTube 抓不到 cue" = **headless 指纹**, 不是产品缺陷: headless 下站点给 `200 + text/html + 0 字节`, headed 下给 `200 + application/json + 8079 字节`、桥接 61 条 cue、浮窗显示真实歌词。`--live` **不要加 `--headless`**; 失败原因现以 `capture_error` 上浮。
5. 剩余 P2 打磨: 历史字幕行渲染、打包分发、多标签 source UI。
6. (已完成) 双轴评审已按替代 fixed point (交接文档 §1 的 11 文件清单) 跑过: 0 硬违规 + 9 条判定 smell; Spec 9 条, 其中两条红线 (`test_hotkey` 读真实设置、TT 回退从未在真 TT 下触发) 已修其一。详见新断点文档 §2.2。
