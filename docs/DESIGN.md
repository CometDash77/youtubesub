# Phase 2 设计 (理解 -> 设计 -> 实施 -> 验证 之 设计)

## 1. 架构 (纵向链路优先)

```
YouTube 页面 (Tampermonkey 脚本, userscript/youtubesub.user.js)
  ├─ page-context 注入: 拦截播放器自身的 timedtext 请求 (复用 pot, 不自建 URL)
  ├─ parseJson3 -> cues[{start_ms,end_ms,text,last_off_ms}] 全量推送
  └─ 播放器事件 -> sync{video_time_ms,playing,playback_rate,timestamp}
        │  WebSocket ws://127.0.0.1:9877/ws (JSON/帧, 见 PROTOCOL.md)
        ▼
桌面 App (Python + PySide6, desktop/)
  ├─ server.py      WS 服务 + /health + Origin 检查
  ├─ store.py       按 source_id 存 cue 表 (排序, trans 随 cue)
  ├─ clock.py       播放时钟: base + elapsed*rate, transit-delay 补偿, gap-hold 带 TTL
  ├─ sentences.py   断句判据 (对齐 kiss-translator 规则分支, 见 ADR-006) -> 句子组 (翻译单位)
  ├─ provider.py    OpenAI-compatible 客户端 (protocol auto, SSE-or-JSON, 超时/重试/backoff/429)
  ├─ queue_cache.py 翻译队列 (urgent/seek > 附近 > 远处) + SQLite 持久缓存 (SHA-256 identity, 不含 Key)
  ├─ overlay.py     PySide6 浮窗 (置顶/拖动/resize/描边/双语/常驻【原】/【译】行标签 + 双语行间分割线/历史/hover 工具栏/click-through+解锁)
  └─ settings.py    %APPDATA%/SubOverlay/setting.json (Key 只存这里; 损坏 -> .bak)
```

## 2. 复用分类 (每项能力只归一类)

### 直接复用 (copy/adapt, 保留版权声明)
- json3 解析 + lastOff 产出 <- yt-dual-subs inject.js:195-228 (MIT).
- (已作废, 见 ADR-006) lastOff 分句算法与常量 (600ms/32词/280字符/最大停顿回切) <- yt-dual-subs content.js:4221-4265 (MIT). 判据已改为 kiss-translator 规则分支的行为等价实现 (clean-room).
- trans 随 cue + 排序后不脱钩 <- yt-dual-subs inject.js:473-481 (MIT).
- nearestTcue 1200ms 时间戳回退 (计数不一致时禁止按位置配对) <- yt-dual-subs content.js:4172-4183 (MIT).
- 对齐翻译协议 (整句进/N 行出/严格计数校验/逐 cue 缓存/失败不拆句重试) <- yt-dual-subs background.js (MIT).
- 输出校验器 (fence 解包/标签计数/全有或全无) <- yt-dual-subs unpackNumbered/unpackGrouped (MIT).
- lane 队列模型 (urgent/normal 分层, minInterval, coalesce, maxBatch/maxBatchChars, 退避 + shed prefetch) <- yt-dual-subs background.js:320-729 (MIT).
- 浮窗几何/透明度/描边/双语/历史队列/设置持久化思路与常量 <- LiveSubs PORT PLAN 12 条 (Apache-2.0).
- Qt overlay flag 组合 + DPI 感知 + LRU 形态 <- local-screen-translator (Apache-2.0).

### 改造复用 (拿设计, 自己重写)
- 线协议 schema/时钟插值模型 <- dkitle (Rust 端无许可证, 只借鉴事实性设计; userscript 的 MIT 部分改写适配).
  必须修的三个坑: gap-hold 加 TTL; 重连回放 sync 不刷新 timestamp; SPA 切视频即新 source.
- provider 配置模型/密钥边界/protocol auto/SSE-or-JSON 检测/缓存 identity/单一并发权威 <- transly (MIT, 但其传输基于浏览器 fetch, 故 Python clean-room 重写).
- page-context 拦截 + CSP bypass 手法 <- dkitle.user.js (MIT 头, 改写; 解析只做 json3).

### 仅参考 (不抄)
- yt-dual-subs 的抓取策略证明了什么不可做: 桌面端独立抓轨 (pot 只能页内复用). 其无上下文/无持久缓存/无外部时钟正是我们要补的.
- transly 证明了浏览器侧 Key 隔离做法; 其缺失 (重试/backoff/429/队列取消) 正是我们要加的.
- LiveSubs 的 bug 不学: 透明度双重相乘; click-through 单向无解锁; overlay 尺寸不恢复; CWD 存设置.
- local-screen-translator 的 DOM 回显是错误架构, 只当反面教材 + sink 安全教训.

### 必须新写
- WS 服务端 + /health + Origin 检查 (server.py).
- 播放时钟 + gap TTL + seek/rate 即时重算 (clock.py).
- 上下文拼接 (前后句) 与 prompt 模板 (provider.py 内, yt-dual-subs/transly 都没有上一句/下一句上下文).
- 优先级调度: 播放点附近 > 前方 prefetch > 远处; seek 后取消/失效无关任务 (queue_cache.py; transly 无取消, yt-dual-subs 只有 shed).
- SQLite 持久翻译缓存 + 跨重启命中 (两家都没有持久化翻译缓存).
- 重试/退避/jitter/429-Retry-After (transly 明确缺失).
- PySide6 浮窗本体 + 设置 UI + hover 工具栏 + click-through 解锁 (overlay.py).
- Mock 翻译服务 (无真实 Key 时的验证替身) 与集成测试.

## 3. 翻译请求形态 (v1)
- unit = 句子组 (ADR-004; 组的划分判据见 ADR-006). urgent: 当前组; normal: 后方 4 组/12 cues; seek: 当前组提 urgent, 旧 urgent 取消.
- prompt: system(可配模板) + 本组全文 + 上一组/下一组各一段 (上下文, 至多各 1 组, 防膨胀).
- 对齐模式 (组内多 cue): 要求 `N|译文` 行, 校验行数 == 组内 cue 数, 失败则整组降级为单行存组级翻译 (不逐 cue 拆).
- 并发 5, 超时 180s(可配), 429/5xx 退避 + Retry-After, 同一 identity 合并在途请求 (无取消信号时).
- 缓存 identity = SHA-256(version, {base_url, model, protocol, mock}, clientKey(video_id+track+组起止+原文), instructions, prompt). 永不含 Key.
  **mock 是身份的维度** (ADR-008): Mock 回显与真实译文是两个不可能互相命中的命名空间; 身份方案随之上到 version 2, 旧方案写下的行全部不可达.

## 4. 验证计划 (摘要, 证据为准)
- 单元: 解析/分句/映射/cachekey/时钟/输出校验/脱敏 — pytest 全绿.
- 集成: 模拟浏览器客户端按 PROTOCOL 发 cues+sync, 跑真实 server+clock+queue+Mock 翻译, 断言 overlay 文本.
- 真实: 经代理抓真实 timedtext (人工轨 + 自动轨); 真实 Chrome + Tampermonkey 跑脚本 (最小化/遮挡/seek/变速/SPA/断线重连);
  真实 Key 到位后补翻译成功链路, 在此之前记为部分验证.
