# localhost 线协议 v1 (browser <-> desktop)

传输: WebSocket, `ws://127.0.0.1:9877/ws`. 每帧一个 JSON 对象, 按 `type` 分发 (沿用 dkitle 的设计, 自实现).
另有 `GET http://127.0.0.1:9877/health` -> `{"ok":true,"version":1}` 供脚本连接前做存活探测.
诊断端点 `GET http://127.0.0.1:9877/status` -> `{"ok":true,"version":1,"stats":{frames,bad_frames,error},
"state":"ok|no_cues","orig":"...","trans":"...","trans_available":bool,"playing":bool,"rate":num,"title":"...",
"sources":n,"active_source":"...","mode":"...","order":"...","history":[[orig,trans],...],"click_through":bool,"hook_error":"...","capture_error":"..."}`
`trans_available` = 这一轮究竟会不会产出译文 (`_provider_usable`: 显式 Mock, 或 base_url 与 model 都非空)。
`trans` 为空只表示「这一刻没有译文」, 不表示「没有翻译可用」—— 浮窗的 trans 模式据此决定译文为空时回退显示原文 (issue #1);
显示层不解析 provider 配置, 只读这个字段。
`hook_error` 非空 = 脚本连上了、但页面钩子没装成功; `capture_error` 非空 = 钩子装上了、也看到了字幕请求, 但响应没有可用正文 (都见 register); 两者都空 = 正常。
— 用于人工/自动化确认"脚本连上了吗、浮窗现在显示什么", 免截图. 会回显字幕文本, 因此**仅 loopback 可用**;
未注入 status provider 的实例只回 `ok/version/stats`; provider 抛错时记 `status_error` 且仍返回 200 (诊断路由永不 500).
只绑定 loopback; 鉴权见 ADR-003 (v1 先做 Origin 检查 + 可选 token, 见下).

## browser -> desktop

### register
`{"type":"register","provider":"youtube","source_id":"<uuid>","tab_title":"...","video_id":"...","track_kind":"manual|asr|tlang","track_lang":"en","hook_error":"...","capture_error":"..."}`
每页加载一个 source_id; SPA 切视频 -> 新 video_id 视为新 source (修复 dkitle 无 SPA 处理的缺陷).
`hook_error` (v1 可选, 后加): 页面钩子 (注入主世界的 fetch/XHR 包装) 安装失败时的人类可读原因; 成功时为空串, 也可以省略。
桌面端把它并入该 source 的 meta, 经 `GET /status` 的 `hook_error` 暴露, 并在浮窗状态行显示 "page hook NOT installed ..."
(否则"连接正常但抓不到字幕"只会显示 "waiting for subtitles", 用户无从判断)。
向后兼容: `sanitize_event` 不校验额外键、未知 type 忽略计数, 旧客户端不发该字段时桌面端按空串处理; 新增可选键不改变既有帧语义。
`capture_error` (v1 可选, 后加): 钩子成功装上、也拦到了 timedtext 请求, 但响应不可用 (空正文 / 非 JSON) 时的原因,
例如 `"caption response was empty (status 200)"`。2026-09-21 实测: youtube.com 对 **headless Chrome** 就返回 `200 + text/html + 0 字节`
(请求 URL 里带 `cbr=HeadlessChrome`), 站点自己也不显示字幕 —— 这个字段是"环境受限"与"产品缺陷"的分界线。
钩子重新拿到可用正文时该字段清空, 并通过重发 register 帧同步给桌面端 (register 是幂等的: 只更新 meta 与 active_source)。

### cues (全量推送, 每次拦截到新轨即发全量)
`{"type":"cues","provider":"youtube","source_id":"<uuid>","video_id":"...","track_kind":"...","track_lang":"...","cues":[{"start_ms":1234,"end_ms":4234,"text":"hi","last_off_ms":2000}]}`
字段说明: 时间毫秒浮点; `last_off_ms` 为最后一个非空 seg 的词级偏移 (无则等于 start, 沿用 yt-dual-subs `lastOff`). **该字段仍随协议下发, 但已不参与断句** (判据见 ADR-006): 分句不再以它为锚点, 手工轨也不再退化为单 cue 成组.
桌面端收到后整体替换该 source 的 cue 表 (排序后存, trans 随 cue, 见 DESIGN.md).

### sync (播放状态)
`{"type":"sync","source_id":"<uuid>","video_id":"...","video_time_ms":12340.5,"playing":true,"playback_rate":1.0,"timestamp":1767000000000}`
发送时机: timeupdate (约 4Hz) + play/pause/seeked/ratechange 立即发送 (沿用 dkitle).
`timestamp` = 发送时刻 Date.now(), 桌面端做 transit-delay 补偿; 重连回放缓存 sync 时必须保留原 timestamp,
禁止刷新为 Date.now() (修复 dkitle 缺陷 #2, 否则 overlay 每次重连跳回).

### deactivate
`{"type":"deactivate","source_id":"<uuid>"}` — 页面卸载/脚本停用时发送 (beforeunload 不可靠, 桌面端收到 cues 可重新激活 source).

## desktop -> browser (v1 保留, 暂不用)
`{"type":"play_pause","source_id":"<uuid>"}` — 预留.

## 错误处理
解析失败的帧只记日志 (不记敏感字段), 不断开 socket. 未知 type 忽略并计数.
