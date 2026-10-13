# 协议 v2 下行命令通道规格取证（issue #215）

- 票：https://github.com/CometDash77/youtubesub/issues/215 （Phase 2 协议命令通道规格 v2：desktop→userscript 下行命令（播放/暂停、±15 秒 seek、静音）与播放进度回传）
- 继承：https://github.com/CometDash77/youtubesub/issues/185 （同名 v1 时代票，已关闭，方向继承、TS 栈上重开取证）
- 日期：2026-10-08（全部一手来源为仓库源码当日精读；issue 标题当日抓取）
- 性质：research 票——只取证与给定案建议，不实施、不改源码。产出喂给 #215 的定案与后续实施票。

## ① 研究问题与决策依赖

研究问题（issue #215 原文）：协议 v2 下行命令通道规格取证/定案——desktop→userscript 下行（播放/暂停、±15 秒 seek、静音）与播放进度回传；在 v1（browser→desktop）语义冻结约束下做增量扩展。

决策依赖：本报告 A–E 五维结论 → #215 定案评论 → 下行命令实施票（ws-server 发送面 + userscript 命令执行面 + PROTOCOL.md 增补）。不阻塞其他 Phase 2 票。约束锚点：ADR-013 明文「重构期间协议 v1（browser→desktop）语义不变」（docs/adr/ADR-013-desktop-runtime-electron.md:5），即冻结的是**上行**方向；下行方向在 v1 里是「保留，暂不用」（docs/PROTOCOL.md:66），启用它属于把预留变成现实。

## ② 证据清单

协议基线：

- docs/PROTOCOL.md:3 — v1 传输 = `ws://127.0.0.1:9877/ws`，每帧一个 JSON 对象，按 `type` 分发（沿用 dkitle 设计，自实现）。
- docs/PROTOCOL.md:4 — `GET /health` 返回 `{"ok":true,"version":1}`，脚本连接前存活探测；userscript/src/youtubesub.ts:435-445 的 `health()` 只判断 HTTP status，不读 version 字段。
- docs/PROTOCOL.md:27-64 — 上行四帧：register（29-50）、cues（52-55）、sync（57-61）、deactivate（63-64），全部携带 `source_id`。
- docs/PROTOCOL.md:58-59 — v1 sync 帧 schema `{type,source_id,video_id,video_time_ms,playing,playback_rate,timestamp}`；发送时机 = timeupdate（约 4Hz）+ play/pause/seeked/ratechange 立即发送。
- docs/PROTOCOL.md:60-61 — 重连回放缓存 sync 必须保留原 timestamp（dkitle 缺陷 #2 修复）。
- docs/PROTOCOL.md:66-67 — `## desktop -> browser (v1 保留, 暂不用)`：`{"type":"play_pause","source_id":"<uuid>"}` 预留。
- docs/PROTOCOL.md:46 — 「`sanitize_event` 不校验额外键、未知 type 忽略计数……新增可选键不改变既有帧语义」。
- docs/PROTOCOL.md:70 — 「解析失败的帧只记日志（不记敏感字段），不断开 socket。未知 type 忽略并计数。」
- docs/PROTOCOL.md:31-32 — 可选键先例：register 的 `video_description`「字段缺省或空白表示无简介，不要求升级协议版本；旧脚本不发该字段时桌面端按空简介处理，新脚本的额外键可被旧桌面忽略」。
- docs/PROTOCOL.md:33 — 「每页加载一个 source_id; SPA 切视频 -> 新 video_id 视为新 source」；docs/PROTOCOL.md:64 — deactivate「页面卸载/脚本停用时发送（beforeunload 不可靠，桌面端收到 cues 可重新激活 source）」。

桌面服务端（只收不发）：

- app/src/main/ws-server.ts:160-162 — 真实协议服务为 `WSServer` 类（1:1 移植 desktop/suboverlay/server.py，票 #198，由 #206 接入 app shell；同文件 L1-157 的 `startSkeletonServer` 是骨架占位实现）。
- app/src/main/ws-server.ts:344-365 — `_connection` 只注册 `ws.on("message")`，收到帧经 `sanitize_event` 后放入 `EventQueue`（L362）；**全文件无任何 `ws.send` 下行路径**（全仓 grep：send 只出现在 userscript 与测试 harness）。
- app/src/main/ws-server.ts:205 与 44 — 两个实现的 `sanitize_event` 都把 `play_pause` 显式判废（`t === "play_pause" → null`），尽管它在类型白名单里（ws-server.ts:14、app/src/main/protocol.ts:168-169 的 `VALID_TYPES` 含 `play_pause`）。配套测试：app/tests/ws-server.test.ts:126、app/tests/ws-server-integration.test.ts:141。
- app/src/main/ws-server.ts:192-197 — Origin 白名单实现：空 Origin 放行、localhost/127.0.0.1/[::1] 放行、`endsWith("youtube.com")` 放行；L7-8 注释自认已知怪癖：「"https://notyoutube.com" passes originAllowed (endsWith match)」。
- app/src/main/ws-server.ts:279-282 — upgrade 时 Origin 不符即 403 断开；L294 — 只绑 127.0.0.1。
- app/src/main/ws-server.ts:152-153、319 — 客户端枚举仅 `wss.clients`（close/stop 时遍历），无 source_id→socket 映射。
- app/src/main/main.ts:335、370-373、387-398 — 产品栈装配：`EventQueue(2000)` → `new WSServer(port, evq, …)` → 50ms pump 把队列帧灌入 `engine.handle_event`；无下行通路。
- app/src/main/protocol.ts:161 — `PROTOCOL_VERSION = 1`。

引擎侧 source 生命周期：

- app/src/main/engine.ts:312-353 — `handle_event`：register/cues 未知 source 则建源并切 active（316-321、355-364）；sync 的未知 source 直接忽略（332-333）；deactivate 仅置 `playing=false`（349-351）；`active_source` 见 L264。
- app/src/main/engine.ts:47、341-348 — `SEEK_JUMP_MS = 2500.0`：sync 估计跳变 >2.5s 即判 seek，取消该 source 待发任务并强制 urgent 重提——下行 ±15s seek 若生效，由此路径自动获得调度失效，无需新机制。
- app/src/main/clock.ts:23-25、33-39、47-59、66-69 — SyncState 仅 `{video_time_ms, playing, playback_rate, anchor_mono}`；引擎只消费 sync 的这三个字段（engine.ts:337-339）。**全链路无 duration/buffered**（grep 全仓：`duration` 仅命中 connection-test 的 `duration_ms` 与断句规则，与 sync 无关）。

userscript 执行面：

- userscript/src/youtubesub.ts:598 — `document.querySelector('video')` 每 1.5s 轮询（`CFG.videoPollMs`=1500，L63）；L600-601 — videoId 变化→`newSource()`，video 元素引用变化→`bindVideo()`。
- userscript/src/youtubesub.ts:583-589 — `bindVideo` 在 video 元素上挂 `timeupdate/play/pause/seeked/ratechange` → `sendSync()`；L537-547 — `sendSync` 从 sandbox realm 读 `video.currentTime/paused/ended/playbackRate` 并发 sync。
- userscript/src/youtubesub.ts:591-595 — `newSource()`：先对旧 source_id 发 deactivate（L592），再 `resetSource` 生成**新 uuid**（L423-433 的 `resetSource` 每次重掷 `sourceId = uuid()`），再发新 register。
- userscript/src/youtubesub.ts:468-482 — `openSocket` 只设 `onopen/onclose/onerror`；**全文件无 `ws.onmessage`**——旧脚本对桌面下行帧整体无感知（连"未知 type 忽略"的处理器都不存在）。
- userscript/src/youtubesub.ts:332 — sandbox 判定 `unsafeWindow !== window`（Tampermonkey 沙箱 realm）；L157-161 注释：pageHook 序列化注入主世界是为了抓 timedtext，与 video 控制无关。
- userscript/src/youtubesub.ts:484-489 — `replay()` 重连回放缓存的 register/cues/sync（userscript/tests/userscript.test.ts:922 守卫「回放 sync 不刷新 timestamp」）。

安全边界：

- docs/adr/ADR-003-localhost-security.md:4 — 背景：local-screen-translator sink 无 Origin/鉴权；dkitle /ws 同样无鉴权且 CORS 挡不住 WS。
- docs/adr/ADR-003-localhost-security.md:6 — 决定 1：只绑 127.0.0.1；WS 握手校验 Origin（只允许空/浏览器扩展与 userscript 的常规值，拒绝外网 Origin）。
- docs/adr/ADR-003-localhost-security.md:7 — 决定 2：「首帧 register 可携带 token（桌面端生成存本地，脚本从本地读取——v1 先实现 Origin 检查，token 为可选项）」。grep 全仓：token 机制**未实现**（register schema docs/PROTOCOL.md:30 无 token 字段，ws-server/engine 无 token 代码）——现状鉴权 = Origin 检查唯一一道。
- docs/adr/ADR-003-localhost-security.md:8 — 决定 3：API Key 只存桌面主进程内存与 %APPDATA%，绝不发往浏览器端；下行命令帧不携带任何秘密，与该条无冲突。

## ③ 定案建议（A–E）

### A. 命令帧 schema

建议三条增量帧（全部沿用既有帧字段风格）：

```json
{"type":"play_pause","source_id":"<uuid>"}
{"type":"seek","source_id":"<uuid>","delta_ms":-15000}
{"type":"mute","source_id":"<uuid>","muted":true}
```

- **播放/暂停：沿用预留的 `play_pause`**，不改名不加新 type。docs/PROTOCOL.md:67 已按这个名字预留，白名单（ws-server.ts:14、protocol.ts:169）也已含它——启用预留是零 schema 发明。语义定义在执行点：`video.paused ? video.play() : video.pause()`（实时状态读自 video 元素，userscript.ts:543 已证明该读法可行）。它是切换语义、天然非幂等，但桌面端目前没有任何发送路径与重试逻辑（ws-server.ts:344-365 只收不发），误双发面 = 双击，loopback 单客户端下可接受。若未来桌面端需要确定性恢复播放状态（如浮窗按钮显示的是"播放"还是"暂停"），升级路径是在该帧加可选键 `playing`（目标态，幂等），走「新增可选键」惯例，不破坏切换语义。
- **裁决（2026-10-13）**：维护者选显式态，拆 play/pause 两 type（见 ④1）；「沿用预留名切换语义」路径作废，PROTOCOL.md:66-67 预留行由实施票增补时取代。
- **seek 用相对偏移** `delta_ms`（毫秒、带符号），±15s 即 ±15000。理由：(1) 用例就是相对按钮；(2) 绝对时间要靠桌面端插值时钟（clock.ts:66-69 的 estimate），回传插值结果有 transit-delay 补偿误差，可能越过视频末尾或与播放器自身状态打架；相对偏移在 userscript 侧 `clamp(currentTime + delta/1000, 0, duration)` 即天然安全；(3) 单 type 带符号覆盖双向，不需要 seek_fwd/seek_back 一对。命令生效后的 `seeked` 事件会经 userscript.ts:585-586 的既有监听自动回发 sync，桌面端**无需 ack 帧**即得知新位置；且 >2.5s 跳变自动触发引擎的 seek 调度失效（engine.ts:341-348）。
- **mute 用显式目标态** `muted` 布尔（true=静音，false=恢复），不用切换语义——显式态幂等，重复帧无副作用，"切换/恢复"两个用例一帧覆盖。
- **source_id 必带**，与全部上行帧一致（PROTOCOL.md:30/53/58/64）；它是新旧 source 判废的唯一键（见 C）。
- **指令幂等性总原则**：状态设置型（pause/play 明确态、mute 显式布尔）幂等；切换型（play_pause）与非幂等 seek 靠 at-most-once 发送（每次用户操作发一帧、不缓存不重试）+ source_id 判废兜底。不建议 v2 引入 `cmd_id` 去重序号——loopback 单客户端、无重传机制，属 YAGNI；若未来桌面端加命令重试，再补。

### B. 版本策略：v1 附加帧，不升 v2

推荐 **v1 附加帧**。理由：

1. 两条兼容规则已为双向增量预留：docs/PROTOCOL.md:46（`sanitize_event` 不校验额外键、新增可选键不改变既有帧语义）与 docs/PROTOCOL.md:70（未知 type 忽略并计数，不断连）。下行方向对称成立：旧 userscript 连 `onmessage` 都没有（userscript.ts:468-482），新桌面给旧脚本发任何帧 = 无害 no-op；新 userscript 对未知 type 按同款规则忽略即可。
2. 仓库先例一致：`video_description`（PROTOCOL.md:31-32）、`hook_error`（:34）、`capture_error`（:47）全部走「v1 可选键，后加，不升级本」，引擎侧亦有可选键双向保护（engine.ts:301-309 注释：旧帧缺键不得抹掉新帧带来的值）。
3. 升 v2 无收益：`/health` 的 version:1（PROTOCOL.md:4）与 `PROTOCOL_VERSION`（protocol.ts:161）只是诊断展示；userscript 的 health() 只看 HTTP status（userscript.ts:441）。升版本反而引入旧客户端 version 协商问题。
4. ADR-013:5 冻结的是「协议 v1（browser→desktop）语义」——上行一个字段都不动；下行启用预留帧（PROTOCOL.md:66-67）恰好是 v1 文档自己预留的扩展位。
5. 升 v2 的触发条件（留档）：命令通道需要请求-响应配对（ack/结果帧）或批量命令事务时，再考虑 v2；当前三条命令 + sync 可选键全部装得进 v1 附加帧。

### C. 执行面

- **控制可达性**：userscript 跑在 Tampermonkey 沙箱 realm（userscript.ts:332），但 DOM 共享——`document.querySelector('video')`（L598）拿到的是同一份 video 元素对象。读路径已在本仓取证：`sendSync` 读 `currentTime/paused/ended/playbackRate`（L540-545）、`bindVideo` 在其上挂事件（L583-589）。**写路径（`play()`/`pause()`/`currentTime` 赋值/`muted` 赋值）仓库内无任何先例代码**——机制上可达（同一元素引用的标准 DOM 操作），但这属于超出仓库证据的推论，实施票需真机验证首例。
- **SPA 切视频判废**：判废键 = `source_id` 比对。仓库事实链：每次 SPA 切视频 `poll`（L597-602，1.5s 轮询）检测 videoId 变化 → `newSource()`（L591-595）对旧 source_id 发 deactivate 后 `resetSource` 重掷 uuid（L423-433）；PROTOCOL.md:33 明文「每页加载一个 source_id; SPA 切视频 → 新 source」。因此下行帧处理的第一道闸就是 `frame.source_id !== this.sourceId → 丢弃`，旧 source 的命令在 1.5s 轮询周期内自然判废。桌面端同构防线：sync 对未知 source 已是直接忽略（engine.ts:332-333），命令下发前可比对 `engine.active_source`（L264）过滤陈旧 source，属服务端加分项非必需（客户端判废已足够）。
- **YouTube 播放器反向接管**：脚本设 `currentTime` 后播放器事件流是否一致、播放器状态机是否会覆盖脚本写入——**仓库内无注释/测试/文档证据，标注「未取证」**。DESIGN.md:9 只描述了正向「播放器事件 → sync」。已知的有利事实：`seeked` 监听已存在（L585-586），DOM 规范上脚本赋值 `currentTime` 会触发 `seeked`，从而使 sync 自动回正；但 YouTube 播放器（自有状态层）是否对程序化 seek/mute 有额外行为，需真机探针（设 currentTime → 观察 seeked 是否触发、后续 timeupdate 是否连续、mute 后 ratechange/音量 UI 是否一致）。
- **下行使能的 userscript 改造量**：补 `ws.onmessage` 处理器（type 白名单 {play_pause, seek, mute} + source_id 比对 + videoEl 存活检查），其余全部复用（videoEl 绑定、SPA 轮询、判废键均已存在）。

### D. 进度回传

- **v1 sync 已有**：`video_time_ms`/`playing`/`playback_rate`/`timestamp`（PROTOCOL.md:58；userscript.ts:540-546），桌面端全量消费并插值（engine.ts:337-339、clock.ts:47-69）。
- **缺**：`duration`（总时长）与 `buffered`（缓冲区间）。grep 证实全链路零出现。缺 duration 的直接后果：桌面端画不了绝对进度条（#185 维度 4 的"进度条数据源"），也无法对绝对时间 seek 做边界钳制（B 案已选相对偏移，userscript 侧用 `video.duration` 钳制即可，不依赖回传）。
- **建议：扩 sync 可选键**，不建新帧：sync 增加**可选** `duration_ms`（`Number.isFinite(video.duration)` 时才带，元数据未加载时的 NaN 不落帧）；`buffered` 缓冲末端如 UI 需要，加可选 `buffered_end_ms`（取 `video.buffered.end(video.buffered.length-1)`）。兼容性走 video_description 先例（PROTOCOL.md:31-32）：旧桌面 `sanitize_event` 不校验额外键（PROTOCOL.md:46），新键被忽略即空值，引擎读侧沿用 engine.ts:301-309 的「缺键不抹值」守卫模式。不建议独立 progress 帧：与 4Hz sync 平行多一条状态通道，徒增同步问题，无兼容收益。
- 桌面端消费侧：缺 `duration_ms` 时进度 UI 显示为无总长模式（仅播放位置），按可选键语义处理为 null，不进入 `/status` 必填字段。

### E. 安全边界

- **现状**：Origin 检查是唯一实现了的鉴权（ADR-003:6 决定 1；实现 ws-server.ts:192-197、upgrade 403 在 279-282）。ADR-003:7 预留的**可选 token 未实现**（grep 全仓无 token 代码；register schema 无该字段）。
- **风险变化**：上行帧只改桌面内部显示状态；下行命令让 userscript 去改真实 YouTube 页面的播放状态——状态改变型操作，攻击面评级应上调。具体漏洞组合：Origin 白名单允许**空 Origin**（ws-server.ts:193 非浏览器客户端放行）+ `endsWith("youtube.com")` 已知怪癖（L7-8 注释自认 "https://notyoutube.com" 通过，"evilyoutube.com" 同理通过）——启用下行后，任意外网页面（伪造 Origin 或无 Origin 的本地进程）都能向已连接的 YouTube 标签发播放控制命令。影响面评估：滋扰级（播放/进度/静音控制），无数据外泄（命令单向进页面，不携带任何秘密，符合 ADR-003:8 Key 边界）。
- **建议（按性价比排序）**：
  1. **token 升级为下行前置**：激活 ADR-003:7 已预留的机制——register 帧携带 token，桌面端校验通过后把该 socket 标记为「命令可用」，无 token 的连接只能上行（现状行为）。每连接认证一次，比每帧带 token 便宜，且完全落在 ADR 预留语义内。ADR-003:7 写明「v1 先实现 Origin 检查，token 为可选项」——v2 下行启用时把"可选项"收紧为"命令通道必选"，是按 ADR 预留路径加严，不是改 ADR。
  2. **双向命令白名单**：桌面端出站白名单 = 恰好 {play_pause, seek, mute}（镜像入站 `VALID_TYPES` 模式）；userscript 侧 handler 同款白名单 + source_id 比对。未知 type 双端都忽略。
  3. **修或至少记录 Origin endsWith 怪癖**（ws-server.ts:7-8）：该怪癖是骨架保真继承（注释明言 kept on purpose for fidelity），真移植版 origin_allowed（L196）也保留了它。下行启用前建议把 endsWith 收紧为 hostname 精确后缀匹配（`.youtube.com` 或等于 `youtube.com`），一行改动。
  4. 绑定维持 loopback（ADR-003:6，ws-server.ts:294 已实现），maxPayload 8MB 维持。

## ④ 未决项/需人工裁决项

1. **play_pause 切换语义的接受度**（需人工裁决）：本报告按"沿用预留名 + 切换语义"定案；若维护者偏好显式态（幂等优先），改为 `play_pause` 加可选键 `playing` 或拆 `play`/`pause` 两 type——二选一，不影响 B/D 结论。
   **已裁决（2026-10-13）：B 显式态，拆 play/pause 两 type**；实施票#219接手。
2. **YouTube 播放器反向接管：未取证**（见 C）——实施票需真机探针出证：程序化 currentTime/muted 写入后事件流一致性、SPA 切换后旧 videoEl 写入的副作用。
3. **buffered 回传是否纳入首版**（D）：进度条 UI 若首版只画播放位置，`buffered_end_ms` 可推迟；建议随 `duration_ms` 一起定，实施票按 UI 需要裁剪。
4. **token 实施形态**（E）：本报告建议 register 携带、连接级认证；token 的生成/存取路径（ADR-003:7 说"脚本从本地读取"——Tampermonkey 下如何安全读到本地 token，GM_getValue vs 手动配置）未取证，需实施票 grilling。
5. **Origin endsWith 怪癖修复时机**（E）：保真注释声明这是有意保留（ws-server.ts:7-8）；收紧它会让部分测试基线漂移（ws-server.test.ts 等覆盖 originAllowed），建议与下行实施票同车处理并更新测试，或单开小票。
6. **桌面端命令入口**：#215 票面只定义协议通道；命令从哪触发（浮窗 hover 工具栏/全局热键/调试窗口）属 UI 范围，本报告未取证 UI 现状（overlay-menu.ts 未读），留待实施票。

——本报告全部论断均标注出处（file:line 或 issue URL）；标注「未取证」处为超出仓库证据的明确声明。

## ⑤ 收尾复核（2026-10-13，研究收尾会话）

本节为复核记录，不改动上文 2026-10-08 取证快照。方法：主会话独立抽查（ADR-003:4/6/7/8 现文逐字比对；PROTOCOL.md、app/src/main/ws-server.ts 于取证时点快照 cf9b10e^ 逐字比对）+ 后台审计 agent 对全文引文逐条核对。

- **快照准确性**：本报告随 cf9b10e 入库；取证时点（cf9b10e^）所引 docs/PROTOCOL.md:66-67（「v1 保留, 暂不用」+ play_pause 预留行）与 app/src/main/ws-server.ts:7-8（endsWith 怪癖注释）、:44/:205（play_pause 判废）、:192-197（origin_allowed）逐字相符——报告在取证时点准确。
- **全量引文复核 51 组**（重复引用已合并）：19 组仍精确相符（上行帧 PROTOCOL.md:3-64、ADR-013:5、ADR-003、app/src/main/engine.ts 全部、app/src/main/protocol.ts:161、DESIGN.md:9）；13 组行号漂移但主张仍成立（userscript 读侧 poll/bindVideo/sendSync/newSource/replay/health、ws-server 绑定与 upgrade 403 等）；19 组被 #219 实施取代或推翻。
- **被 #219 推翻的关键事实（现为现状）**：docs/PROTOCOL.md:66-84 为四帧命令通道（预留行按裁决 B 取代）；ws-server.ts:455 起 sendCommand 下行（ws.send）、:277 新增 source_id→socket 映射；play_pause 出白名单（ws-server.ts:17、protocol.ts:168-172）；Origin 收紧为精确后缀匹配（ws-server.ts:201-208，怪癖 retired）；token 已实现（ws-server.ts:282/:364-370 GET /token/:398，userscript fetchToken:453-469）；sync 增 duration_ms（clock.ts:22-31、engine.ts:339、userscript:575-583）；userscript 已补 onmessage（:510）。测试锚点迁移：ws-server.test.ts:126→138、ws-server-integration.test.ts:141→151、userscript.test.ts:922→1005-1036。
- **仍成立**：buffered 全仓零出现（未决项 3 的推迟选项维持）；loopback 绑定与 upgrade 403 行为不变；SEEK_JUMP_MS=2500.0 调度失效路径不变。
- **无出处主张 1 处**：§C「DOM 规范上脚本赋值 currentTime 会触发 seeked」引外部规范未给链接（其余「未取证」处均已显式自标，见下）。
- **结论**：本票取证/定案职责完成；未决项 2-6 全部随 #219 处理（其中 4、5 的实施形态已在 cf9b10e 落地：token 连接级认证、Origin 收紧；3 维持推迟：buffered 未纳入首版）。
