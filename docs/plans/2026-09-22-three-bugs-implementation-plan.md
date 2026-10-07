# #41 / #42 / #44：诊断结论与无上下文实施计划

日期：2026-09-22（Asia/Shanghai）。仓库：`CometDash77/youtubesub`。取证基线：`1fd31fa36d0d11f831b7e3724796fea102316a5d`。

本文是交给新 agent 的独立实施契约，不要求读取原聊天。本轮只诊断和制定计划，没有修改产品代码、更新远端 issue、提交或推送。文中「决定」是本计划选定的实施方案，不冒充历史维护者决定；「已复现」仅指列出的确定性场景，不表示已经证明报告人现场的唯一根因。

## 1. 接手后先做什么

1. 在仓库根目录读取 `AGENTS.md`、`CONTEXT.md`、`docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`、`docs/agents/domain.md`，然后读本文。若存在 `CONTEXT-MAP.md`，读取本次涉及的上下文。阅读 ADR-002、003、005、006、007、008、009、010；修改日志/设置存储时同时读 ADR-011。这些文件均在 `docs/adr/`，以文件名编号检索。
2. `git status --short`、`git rev-parse HEAD`、`git log -5 --oneline`；用 `gh issue view 41 --json title,body,comments,labels,state` 分别读取 41、42、44 的最新内容。若新的维护者决定与本文冲突，执行最新明确决定并记录差异；不要覆盖已有工作。
3. 本次取证时 `master` 比 `origin/master` 领先 3 个提交，`AGENTS.md` 和 `data/translations.db` 已修改，另有大量未跟踪 `.scratch/`、`.local/`、`docs/research/` 等。它们不是本计划的实施产物。禁止 reset/clean、覆盖、整库 `git add .`，禁止自动推送这 3 个提交。需要隔离时从核对过的当前 HEAD 创建 `codex/three-bugs-reliability` 分支/工作树；未提交指令不自动复制，须同时遵守用户已提供的有效约定。
4. **先建立隔离工作树再跑第 10 节全量基线**，随后按第 9 节实施。现有 `desktop/tests/browser_e2e.py` 只设置临时 APPDATA，`App` 却通过默认 `TranslationCache` 读写代码目录下的 `data/translations.db`；临时 APPDATA 不等于缓存隔离。工作树必须有自己的 data 路径，禁止指向用户主工作区。所有新回归必须先在未修代码上失败，修复后通过；不能只把本文的「当前坏行为成立」探针当作验收测试。
5. 自动测试与探针用临时 SQLite、临时 APPDATA、假的 provider/本地 HTTP 服务。不得修改真实 `data/translations.db`、真实 `%APPDATA%/SubOverlay/setting.json`，不得擅自发出付费模型请求。

技能说明：本次在已安装的 Matt Skills Curated 1.1.0 中未找到名为 `ask matt` 的技能；实际采用该插件 `diagnosing-bugs` 的确定性复现方法和 `to-spec` 的规格写法。不要声称调用过不存在的技能。后续若使用 `implement`，以本文件为规格来源。

## 2. 三张票的范围及证据等级

| 原票 | 当前管理状态（取证时） | 本轮确定的关键问题 | 尚不能确定的部分 |
|---|---|---|---|
| [#41 原文未透传](https://github.com/CometDash77/youtubesub/issues/41) | OPEN，bug，ready-for-human | 注入自证已在 `81cf035` 完成。另复现早期 cue 身份错误、SPA 事件先于轮询导致 cue 丢失、捕获恢复状态未传播 | 新发现是否解释报告人原始故障；真 Tampermonkey L3 仍由维护者验收 |
| [#42 行内多个【译】](https://github.com/CometDash77/youtubesub/issues/42) | OPEN，bug，needs-triage | Mock 给每个片段写标签，Engine 拼接后正文含多个标签；UI 只检查行首 | 报告人当时是否开启 Mock；真实 provider 是否也输出标签 |
| [#44 译文空白/滞后及日志诉求](https://github.com/CometDash77/youtubesub/issues/44) | OPEN，bug，needs-triage | 错误结果被丢弃；NORMAL 不能提升；批内缓存命中不通知；播放进入在途批成员后批失败无补翻 | 用户 API 是否有效、真实服务延时、批输出遵约率、是否还有其他瓶颈 |

上述代码缺陷信心高：已有可复跑探针并由主 agent 复核。与报告人现场的完整因果联系为未知：没有对应运行的事件链日志。不得把 AUTH 探针写成「用户 Key 错误」。

重要反证：预取与批量已经在桌面端实现，不能因为 userscript 没有 `prefetch` 字符串就判定未实现。`Engine._fill_window` 使用 90 秒窗口、最多 20 组，填充时按 8 组/8000 字符切批。问题是已有链路在特定状态转换下没有履行契约，而不是再造一套提前批翻译。

本轮自动基线：`python -m pytest desktop/tests -q` → **215 passed in 30.78s，0 skipped**；userscript Node → **46 passed，0 failed**。数量仅是本次证据，不是新实现必须维持的固定数量。新增探针揭示现有绿测漏掉事件交错、结果回调和 Engine→UI 跨层行为。本轮基线在主工作区运行后才发现E2E缓存隔离缺口，因此它可能更新了原本已修改的本地数据库；没有事前文件哈希，无法区分本轮增量，不应回滚覆盖用户已有数据。后续按第1节隔离运行。

## 3. 系统与不可破坏的边界

数据链：页面主世界 fetch/XHR 钩子 → 自定义事件 → Tampermonkey `Bridge` → 回环 WebSocket → `WSServer` 事件队列 → `Engine` → 句子组/翻译队列 → provider/SQLite → Engine 内存 → Qt 浮窗。`GET /status` 是只读观察口，不能触发翻译或连接测试。

- **cue** 是带时间的字幕片段；**句子组**是翻译单位，一个组可能含多个 cue。预取是提前调度，batch 是一次请求装多个组，二者不同。
- 沿用 JSON3 页内抓取，不引入 DOM 字幕兜底、浏览器扩展替换、OCR、音频识别（#41 Q2）。保留已实现的 document-start、每级 500ms 回执验证、迟到回执恢复。
- **#41 Q3 明确禁止 agent 安装 Tampermonkey，独立 profile 也不例外；禁止 agent 代跑 L3。**维护者手跑。已有文档「本机未安装」是历史描述，#44 环境已报告 Tampermonkey 5.5.0；不得继续当作当前事实。
- ADR-007：在途请求不取消；seek 只取消 pending；seek 前瞻去抖 400ms，当前组紧急请求不去抖；窗口参数、稳态增量、批精确编号全覆盖和整批失败作废均保留。传输层既有重试不等于新增整批语义重试。
- ADR-008/009/010：Mock 与真实 provider 命名空间隔离；job 携带配置快照；邻组上下文参与 identity；单发/批发同一组 identity 相同。Key 不进 identity，不把 API Key 改动变成真实缓存全失效。
- 不更改句子分组规则，不通过调大窗口/并发/超时掩盖调度缺陷。不承诺外部模型任何时候都能实时产出译文。
- 日志仅本地，回环端口与 Origin 边界不放宽。不把整个配置、请求头、请求正文、原始响应、完整 timedtext URL 写入日志。
- `harness/` 不在本计划范围；两模型维护指令层若被修改，必须逐条执行 `docs/agents/dual-model-checklist.md` 的静态检查。模型 id 保持 `deepseek-flash` / `mimo-v2.6-flash`。

## 4. 用户故事与完成含义

1. 作为观看者，我希望早于页面加载完成收到的字幕仍属于正确视频，使原文和后续翻译不丢失。
2. 作为观看者，我希望页面内切换视频后只收到新视频字幕，旧视频迟到结果不污染当前画面。
3. 作为观看者，我希望捕获失败和恢复都正确显示，使我不用猜测抓取是否仍然失败。
4. 作为观看者，我希望每个显示槽只生成一次行标签，字幕正文不因修复被篡改。
5. 作为观看者，我希望已经预取/缓存的译文能按时显示，当前句优先于尚未播放的字幕。
6. 作为观看者，我希望正在看的句子遇到批失败后仍获得一次单组补翻，而不是一直空白；永久失败也不能无限重试消耗额度。
7. 作为使用者，我希望区分未配置、排队、请求中、成功、失败和无字幕，失败时原文仍可查看。
8. 作为维护者，我希望一份当日日志串起字幕捕获、队列、请求、缓存与显示，并在每天保留独立归档，以便定位真实环境故障。
9. 作为维护者，我希望自动测试证据、真实扩展验收、真实模型验收分开，避免「单测全绿」替代用户问题闭环。

「代码完成」= 本计划所有自动验收通过；「三票现场闭环」= 对应维护者 L3/L4 证据也齐备。两者必须分别报告。

## 5. #41 相邻时序缺陷：来源一致性与捕获状态

归属：这是本轮新发现的实现任务，不重写 #41 已完成的注入自证，也不把原票的未验证假设升级成根因。发布管理票时作为独立 bug 子任务关联 #41。

入口：`userscript/youtubesub.user.js` 中 `Bridge` 构造、`onTimedtext`、`onTimedtextFailure`、`newSource`、`poll`、`afterDomReady`、`republishRegister`、`openSocket`；测试 `userscript/tests/userscript.test.mjs`。

### 5.1 已复现的三个事件序列

| 序列 | 当前坏结果 | 必须达到的结果 |
|---|---|---|
| 有效 cue → 捕获失败 → 相同有效 cue | `captureError` 本地清空，register 仍旧错误，面板仍 NO CAPTION BODY | 不重发重复 cues，但必须新增清错误 register 并刷新面板 |
| `document.readyState=loading` → 有效 cue → DOMContentLoaded → WS 连上 | register 有视频 ID，缓存 cues 的 video_id 却为空 | register/cues/sync 的 source_id 与非空 video_id 一致 |
| 位置从 A 变 B → B cue 到达 → poll | B cue 标成 A；poll 新建 source 后清空已收到的 B cue | B cue 直接归 B；后续 poll 不再清掉它 |

### 5.2 确定的修改契约

1. 提取唯一的视频身份协调行为，供 `onTimedtext`、`onTimedtextFailure`、`poll` 和 DOM ready 初始化共用。优先读取当前页面位置的视频 ID；只有页面 ID 发生真实变化才换 source。构造/最早有效事件即可建立身份，不等 DOM ready；DOM ready 不得无条件覆写已有身份。
2. 对 timedtext URL 的 `v` 做归属核对：若非空且与当前页面 ID 不一致，丢弃该响应或失败通知，不回切旧视频、不修改字幕/轨道/捕获错误。当前页面无可识别视频 ID 时不接纳为当前视频；URL 缺失 `v` 时可沿用已有非空页面 ID，但记录 `video_id_unverified` 诊断原因，不凭空创造 ID。这是兼容决策，需有独立测试。
3. 新 source 创建后立即发 register；若已有 video 元素，立即发它的当前 sync，即使元素对象未换。新 source 清空旧 cue/轨道元数据/捕获错误，保留文档级 hookError。poll 调用同一协调行为，避免重复换源。
4. 解析出非空有效 cues 后才清 `captureError`。清错误的 register/面板刷新必须发生在 cue 去重早退之前。空/无有效 cue 的载荷不得清旧错误；不得伪造「已经恢复」。
5. 重连时 register 必须由当前状态重建，或缓存必须在每次状态变化同步；选择前者以减少双状态维护。随后重放该 source 当前 cues 与 sync。sync 的原 timestamp 不得刷新。不得重放前一个 source 的缓存。
6. 桌面 `_stamp_meta` 不作为浏览器错误身份的掩盖手段。本任务主要修源头；新增跨语言/WS 验收确保真实帧不会用空 ID 覆盖正确 ID。

页面 A→无可识别视频 ID（如首页）的行为也锁定：发送旧 source 的 deactivate，清浏览器当前身份及 register/cues/sync 重放缓存；没有可识别视频时不发新 register，不重放 A。重新进入 B 才创建新 source。桌面收到 active source 的 deactivate 时撤销 active_source 并令显示回到无活动内容，取消其 pending 消费者；非active的 deactivate 不干扰其他活动源，在途照常缓存。相应更新协议中 deactivate 的语义，不再只当作 pause；pause 仍走 sync。补 B41-8：A→首页→断线重连→B，不残留 A，不产生空 ID 注册。

无active source时Engine必须交付明确的空显示快照（state=no_cues、orig/trans为空、translation.state=idle），App据此清窗；不得只返回None，因为现有App会忽略None并保留上一帧。新视频进入后的register/cues仍按原规则激活。

验收编号 B41-1～B41-7：分别覆盖上述三个序列、B 切换后迟到 A 成功、迟到 A 失败、无有效 cue 不清错、复用 video 元素立即 sync。再覆盖断线期间恢复后重连收到清错误状态。所有断言观察实际发帧/面板，不仅检查函数调用。

## 6. #42：标签只属于显示层，旧 Mock 缓存有明确退场方式

证据：三条英文 cue `We` / `are` / `indeed.` 被组成 `We are indeed.`；显式 Mock 经实际 Engine/队列/缓存/Overlay 后，译文为 `【译】We 【译】are 【译】indeed.`。路径是 `Engine._translate_single` 为每个 aligned value 加前缀，`_on_done` 拼接 values，`OverlayWindow._labelled` 只判断整串行首。

修改范围：`desktop/suboverlay/engine.py`、`queue_cache.py`、`overlay.py`；相关 engine/provider/overlay/browser E2E 测试；新增 ADR 澄清标签职责。

明确决定：

1. Mock 单组 `text` 与 aligned `values` 均是纯正文，禁止生成显示标签；Engine/cache/status 只存正文。批 Mock 同样遵守。
2. Overlay 为每个逻辑显示槽添加一个自身标签；删除「startsWith 相同字符就把正文当已装饰」的隐式来源判断。合法正文中的 `【译】`/`【原】` 必须原样保留，包括正文开头。若正文真的引用这些字符，画面可能出现多个相同字样，但其中只有一个是 UI 装饰；不能以全局字符计数验收合法引用场景。
3. 禁止全局 `replace('【译】','')`，禁止修改真实 provider 输出。若维护者证据证明真实 provider 自行输出多余标签，应另行记录输出契约问题，不能混入此已证实 Mock 修复。
4. **只失效旧 Mock 缓存**：`cache_identity` 的 provider 子载荷仅当 mock 为 true 时新增 `mock_output_version: 2`。全局 `CACHE_VERSION` 保持 2；mock=false 不增加字段，序列化规则不变，使真实 provider 的 hash 逐字不变。旧 Mock 行不删除，由原有 TTL/trim 机制处理；不新增全库清理。namespace 使用同一 identity 函数自然分叉。
5. 保留已有 #31 的 Mock/真实隔离、配置快照、命名空间切换重取、旧结果拒收。修改依赖 Mock 前缀的断言，改为纯正文精确值、调用记录、已知 fake provider 输出。不得为保留旧测试继续把标签写进数据层。
6. 用新 ADR 说明 ADR-008 中「Mock 带前缀回显」的历史描述被此决定替代，ADR-008 的身份隔离决定不变；更新 `docs/MANUAL-ACCEPTANCE.md` 的 demo 预期和 browser E2E 的 `MOCK_MARK` 判据。

验收：B42-1 三 cue 经 Engine→Overlay 绘制原语，译文正文恰为 `We are indeed.`，显示行为恰有一个 UI 译槽标签；B42-2 单 cue/多 cue、single/batch、冷缓存/第二个 Engine 暖缓存结果一致；B42-3 用旧 Mock 算法预置带标签缓存，新版本不得读取它；B42-4 修前记录的真实 provider identity golden 值修后不变；B42-5 正文含字面标签完全保留；B42-6 三种模式、双语顺序、空 cue、无 provider 回退和分隔线不回归；B42-7 Mock→真实及迟到旧结果的 #31 测试保留。

## 7. #44：调度需求不能被去重和失败吞掉

入口：`Engine._tick_locked/_submit_group/_on_done/_set_cues/_sync_namespace`，`TranslationQueue.submit/submit_batch/_worker/_run/cancel_source`，`TranslationJob`。测试优先使用真实 Engine/真实 queue + 可控 provider，`threading.Event` 控制先后，固定播放时间，不用随机 sleep 猜时序。

### 7.1 三个已复现调度缺陷

**优先级升级丢失**：单 worker 被阻塞；目标组已在 NORMAL 批中；提交同 identity 的 URGENT，`submit` 返回 false，原任务仍 NORMAL。

**缓存命中无交付**：批排队后给其一个成员写入成功缓存；取批时剔除了 cached 成员，未请求 provider，却也没有对该成员执行 `on_done`。缓存有值不等于 Engine 已显示。

**批失败与播放交错**：播放组 0，前瞻批 `[1,2]` 在途；播放点进入组 1，紧急提交被在途去重；此后批返回 SHAPE_MISS。当前代码连续 tick 20 次仍译文空白、pending/inflight 都为 0，provider 调用只有 `[0]` 和 `[1,2]`，没有 `[1]`。现有测试先等失败再进组，漏掉了该交错。

### 7.2 调度与生命周期契约

1. pending NORMAL 单任务收到同 identity URGENT 时，提升为 URGENT 并重建正确堆序；批中目标成员必须从原批抽出、单独紧急排队，原批不能再保留该成员。空批删除，剩一成员按 single 执行。相同优先级重复提交保持去重。不得把整个普通批一律提升，从而让无关远期字幕抢占当前句。
2. 已在途同 identity 不再发第二个 provider 请求，但必须保留有效消费者的需求关联；去重是合并工作，不是丢弃结果交付。消费者由 source_id、字幕 generation、group_idx、provider namespace、provider_run_epoch、identity 标识。结果可缓存，投递时只投给仍有效消费者。cancel_source 只取消该source消费者：其他消费者仍有效则保留共享工作；没有消费者的pending工作移除，在途仍完成并缓存。追加 A/B 同identity、取消A、B恰交付一次的验收。
3. source 的每次 `_set_cues` 增加内存 generation；job 携带提交 generation。`_on_done` 在应用成功/失败/补偿前同时核对 generation、namespace、组索引及**消费者所指 group_idx 在当前 generation 下重算的 identity**；不能要求该组必须正在播放，否则会丢掉所有预取成功。generation 不进持久缓存 key，以免破坏同内容复用。换轨后的旧在途结果仍可存入其原 identity 的缓存，但不能写入新轨同索引。这是新增生命周期保护要求，不能把未单独取证的污染现场声称为已复现。
4. 批取活时缓存命中的每个有效消费者收到一次成功通知，`from_cache=True`；取消的消费者不通知。在 queue lock 外调用 Engine，避免 Engine→queue 与 queue→Engine 锁顺序死锁。未命中剩 ≥2 为批、剩 1 为单、剩 0 不请求。禁止缓存命中触发重复网络请求。
5. 每次进入当前组登记一份「当前需求」。即使 submit 因共享在途而不发新请求，这份需求仍存在。当前需求在离组、换 source、换 generation、namespace 变化时失效；同一组连续 tick 不产生新需求。
6. 批失败时整批不落缓存、不部分落地、不重发批。若其成员此时仍是有效当前需求，下一次 tick 前/中安排**一次** URGENT single 补偿；无需等待重新进组。失败成员在 source/generation/namespace/provider_run_epoch 生命周期内标记 `single_only`：后续窗口填充跳过它们，不再预取，仅到当前播放点走single。该标记是内存调度状态，不是持久失败批；生命周期失效时清除。补测 `[1,2,3]` 失败→进入1重填窗口，2/3不得又被组批。当前补偿失败后状态为 failed，连续 tick 不再次补偿。
7. provider 内部既有有限传输重试保持原策略；single 的 SHAPE_MISS 既有整句降级保持。新逻辑不叠加无限 retry。离开后重新进入可新建一次当前需求；用户保存 provider 设置也新建运行需求，即使仅改 Key 不改变持久 cache identity；仍不改 Key 不进 identity 的规则。

   实现上引入内存 `provider_run_epoch`，每次保存provider设置递增，job/消费者携带它，不进持久identity、不写Key到事件。新epoch与旧epoch同identity在途相撞时等待旧请求结束，不加入旧失败、不并发重发；旧成功若已合法写入同identity缓存可直接用缓存满足新需求，否则用新快照发起一次请求。旧epoch结果不能决定新需求failed。补测旧Key在途→保存新Key→旧AUTH→新快照成功；保存没有改provider的纯外观设置不递增。
8. 暂停不预取，但已有当前需求结果仍可显示，失败批对暂停在本组的需求仍可补偿一次。seek 丢 pending、保留在途；400ms 只影响前瞻，不影响当前组。
9. 不新增旁路 worker 池，不超过 `provider.max_concurrent`。批提交也要遵守现有队列容量；明确 pending 统计分别给 entry 数和 group 数，避免把一个 batch 算作一组误判容量。保留 `max_pending` 构造参数，单位明确改为group，默认400，取消项不计数。仅新URGENT可淘汰NORMAL腾位：按提交seq从大到小（最新预取优先淘汰）直到腾出一格；剩余全URGENT仍满则rejected。新NORMAL不能挤走旧NORMAL，按输入顺序接纳剩余容量可装的前段，其余shed。当前需求被拒绝转 `failed + QUEUE_FULL`，普通前瞻shed不改变当前状态；不每tick反复尝试。此容量语义变更写入新ADR，禁止声称旧代码已经按group限额。

### 7.3 必须新增的测试

| 编号 | 验收场景与不可模糊的判据 |
|---|---|
| B44-Q1 | worker 屏障占满；普通单任务/批成员升级；释放后目标先于剩余 NORMAL 执行，目标只请求一次 |
| B44-Q2 | 缓存预置/入队后再命中两种顺序；cached 成员恰交付一次，Engine 可显示，provider 不收到它 |
| B44-Q3 | `[1,2]` 在途→进入 1→SHAPE_MISS→一次 `[1]` 成功；无需离组重入即可显示 |
| B44-Q4 | 同 Q3 但补偿也失败；后续至少 20 tick 请求数不增长，状态 failed；原文保持 |
| B44-Q5 | 批成功时不补偿；进入后又离开、换源、换轨、改 namespace 后失败，不补偿已失效需求 |
| B44-Q6 | 旧轨在途、新轨复用 group_idx，旧结果不得写新轨；原 identity 缓存仍可复用；同 identity 多消费者各自只交付一次 |
| B44-Q7 | 单组/批总并发不超过配置，容量满时不越界；取消旧源任务不挤占容量；被拒绝有原因 |
| B44-Q8 | 90s/20组、8组/8000字符、上下文关仍预取、seek 去抖、在途不取消、限流后补窗口的既有测试保持 |

## 8. #44：生产状态和每天一份的诊断日志

这部分是报告人明确提出的新能力，也是现场根因仍不可知的主要缺口。现有 `Engine._on_done` 对 error 直接返回，`Engine.status()` 没有队列/请求错误；App 的 `/status` 又仅挑选部分 display 字段。不要只加一条 console 输出。

### 8.1 状态模型与界面

保留旧字段兼容：`state=ok|no_cues` 与 `trans_available` 不改语义。文档必须纠正措辞：`trans_available` 表示「已配置/Mock 可用的静态条件」，**不是已经验证真实服务能翻译**。

新增 `/status.translation` 对象，由 Engine 提供，App 透传允许字段：

| 字段 | 契约 |
|---|---|
| `state` | `idle / not_configured / queued / inflight / ready / failed`，只描述当前需求；无活动 cue 为 idle，缺配置为 not_configured |
| `source_id`, `generation`, `group_idx` | 当前目标；无目标为 null，不沿用上一视频值 |
| `request_id` | 当前服务调用关联 ID；尚未启动/纯 cache 命中可 null |
| `result_origin` | `null / cache / mock / provider`；ready 时有值 |
| `error_code` | 失败代码，非 failed 为 null；成功/新需求必须清旧错误 |
| `message` | 受控错误说明，不复制原始异常/响应；上限 300 字符 |
| `attempts`, `elapsed_ms`, `queue_wait_ms` | 实际已知值，未知为 null，不能编造 0；attempts 是实际 HTTP 尝试数，cache/mock 为 0 |

新增 `/status.queue`：`pending_entries`、`pending_groups`、`inflight_groups`、`active_requests`、`backoff_remaining_ms`、`dropped_groups`（进程累计）。新增 `/status.diagnostics`：`logging_ok`、`log_error_code`、`session_id`、`script_build_id`（尚未收到为 null）、`writer_dropped_events`、`browser_dropped_events`、`invalid_diagnostic_frames`（均桌面进程累计非负整数）；不暴露本机用户名路径或凭证。浏览器drop按每个browser_session_id的累计最大值计算增量，重复重放不重复累加。logger满时 `logging_ok=false, log_error_code=LOG_QUEUE_FULL`；恢复成功写盘且已记录丢失摘要后恢复true/null，但累计数不清。I/O失败仅在实际成功写盘恢复后清错；LOG_IN_USE本进程不自动争抢文件。

queue 增加可选事件通知（默认 no-op，旧测试构造可继续使用），在锁外通知 queued/promoted/started/completed/failed/cancelled/shed/cache_hit，Engine 为当前需求更新状态。状态读口不可推进队列，不能在 `/status` 调用 provider。provider 的 single 与 batch 均返回一致的受控错误码和 attempts；batch 的 OSError/超时也应映射为 NETWORK/TIMEOUT，未知异常才 WORKER。新增本地假 HTTP/异常探针确认单/批的错误分类，不用外网验证。

补充事件顺序契约：另有 `rejected` 通知。每份当前需求生成唯一 demand_id，每次single/batch执行生成 run_id，每个run的事件序号在状态转换发生处单调递增；锁外投递不得导致旧queued覆盖已started、旧batch failed覆盖single补偿结果。Engine保存当前demand/run及最后接纳序号，拒绝过期事件。补偿转换为 `inflight(batch) → queued(single) → inflight(single) → ready/failed`，不对外停留在可自动补偿的旧batch failed；补偿资格在single成功入队时消费一次，若入队拒绝直接failed/QUEUE_FULL并结束该需求的自动尝试。T1先建立最小demand/run/epoch状态结构，T4/T5扩展使用，不再另起一套状态模型。

浮窗沿用状态栏显示简短说明：排队中、翻译中、翻译失败（代码）、未配置；不要将错误文字写进 `trans`/缓存/历史字幕。bilingual 原文继续显示；translation-only 在 failed/not_configured 时回退原文并以【原】标记，在 queued/inflight 时维持原有等待行为。错误不得因 repaint 或普通 sync 被清掉，只因新的有效需求/成功/配置保存转换。

### 8.2 日志文件、轮转与故障行为（本计划选定默认值）

- 目录：`%APPDATA%/SubOverlay/logs`，跟随现有 `settings_dir()`，测试用临时目录。
- 写入：UTF-8 无 BOM，JSONL，一条完整事件一行。每个有事件的本地自然日一个 `youtubesub-YYYY-MM-DD.jsonl`；当天文件实时追加，过去日期文件就是日归档。同日重启追加，不覆盖；日期变化后的第一条事件进入新文件；无事件日期不制造空文件。
- 这一定义实现「滚动更新、一天一份备份」，并非异地灾备。默认保留最近 **30 个本地日历日（含当天）**，仅清理严格匹配此命名规则且早于窗口的日志；不递归删除目录、用户文件或数据库。该保留期是本计划新决策，不是用户历史要求。
- 默认单 desktop 实例；日志模块仍需串行化本进程多线程写入，确保无半行/交错。若第二进程打开同一日志目录，日志初始化应检测占用并显示 `LOG_IN_USE`，不截断现有文件、不阻止字幕主链运行；不以多进程共享 handler 冒险写同一文件。
- 使用队列转交单一日志 writer，业务线程不等磁盘 I/O。缓冲上限 10000 事件；满时不阻塞字幕，累计 dropped 数，恢复后写一条 `log.events_dropped` 并令状态可见。不声称日志零丢失。
- 正常关闭 flush/join writer，最多等待 2 秒；写盘/目录权限/空间失败时主链继续，`logging_ok=false`、固定错误码，stderr 输出一次脱敏提示，不递归通过坏 logger 报错。异常退出的最后缓冲可能未落盘，记录此边界。
- 测试注入时钟模拟午夜/重启/保留期，不真的等一天。不要把改系统时钟作为测试步骤。

### 8.3 事件覆盖与关联

公共字段：`schema_version=1`、带时区 ISO8601 `ts`、`session_id`、进程内递增 `seq`、`level`、`event`。按需附带 `source_id`、`generation`、`group_idx`、`job_id`、`request_id`、`batch_id`。ID 不含字幕、Key、URL；一次 HTTP retry 共用 request_id，另带 attempt 序号。

| 链路 | 必记事件及最小信息 |
|---|---|
| 生命周期/配置 | start/stop、desktop 提交或 build ID、版本；保存配置时仅变更字段名和是否配置，禁止值/Key；测试连接 start/cancel/verdict，不持久化 sample/完整 connection_test |
| 脚本/传输 | script build ID、hook attempted/confirmed/failed/recovered、capture failure/recovery、source/track 切换、WS connect/disconnect/retry、无效帧与队列丢帧计数 |
| 字幕/时钟 | cues 接收/去重/拒收原因、数量与时间范围；play/pause/seek/rate；每条收到的 sync 记录媒体时间/速率，禁止记录相同 60Hz Qt tick |
| 调度/缓存 | window fill 原因与范围、enqueue/promote/dedup/shed/cancel、cache hit/miss/write、batch 成员数/字符数、仅使用身份摘要作关联 |
| provider | started/attempt/finished、single/batch、耗时、HTTP 状态（有则写）、错误分类、attempts、对齐是否成功；不记 prompt、headers、响应全文 |
| 显示/操作 | current group/state/result_origin 变化、结果被拒绝的原因；模式/顺序/字号/透明度/click-through/热键/设置打开保存取消/退出；拖动缩放仅结束时最终几何，不记每个鼠标像素 |

浏览器日志上送为新增可选 `type: diagnostic` 帧，只允许已列出的事件枚举与字段；每帧≤4096 UTF-8 字节，超限/非法计数后丢弃。桌面 `sanitize_event` 和 `VALID_TYPES` 同步扩展，diagnostic 不得切换 active_source、修改 cue 或进入翻译调度。register 增加可选 `script_build_id`；旧客户端没有新字段仍工作，旧桌面忽略未知 type 也不破坏字幕。

diagnostic线协议固定如下；其他业务帧不套此schema：

- 必选字段：`type="diagnostic"`；`browser_session_id`（每次文档脚本启动生成UUID字符串，最长64）；`seq`（本browser session递增正整数）；`timestamp_ms`（事件发生的Date.now，有限非负整数）；`event`（下表枚举）；`data`（对象）。可选 `source_id` 为非空字符串、最长128；尚无有效视频身份时省略。
- 允许的event及data字段：`hook.attempted`=level；`hook.confirmed`=level,entries；`hook.failed`=level,reason_code；`hook.recovered`=level；`capture.failed`=reason_code；`capture.recovered`={}；`source.changed`=reason_code；`track.changed`=track_kind,track_lang；`ws.connected/ws.disconnected`={}；`ws.retry`=delay_ms；`cues.received`=cue_count,start_ms,end_ms；`cues.duplicate`=cue_count；`cues.rejected`=reason_code；`diagnostic.dropped`=dropped_total。
- 各event所列字段均必选，不允许额外字段。level枚举 `gm/script-element/direct-eval/sandboxed`；entries为不重复的 `fetch/xhr` 数组；track_kind枚举 `manual/asr/tlang/unknown`；track_lang为≤32字符的字母/数字/连字符字符串或空串。计数/延迟为非负安全整数；cue时间为有限非负数且end≥start。
- reason_code为受控枚举 `NO_RECEIPT/EMPTY_ENTRIES/INJECTION_REJECTED/EMPTY_BODY/INVALID_JSON/NO_CUES/STALE_VIDEO/NO_VIDEO/VIDEO_CHANGED/VIDEO_ID_UNVERIFIED`，不可用任意原始异常代替。已有hook_error面板原因仍按原协议显示；日志只保存映射代码。
- 编码后字节限制以服务器收到的原始JSON文本UTF-8长度计算（bytes帧则取原始长度）；通用8MiB传输上限仍保留。解析type后、进入任何业务处理前校验diagnostic大小/schema；未知event/字段/不合法类型整体丢弃并增加invalid_diagnostic_frames，不回显原载荷。数值不得把bool视为整数。
- register.script_build_id为可选≤64字符字母/数字/点/下划线/连字符字符串；缺失保持兼容。桌面只为已知source关联build信息；无source的早期诊断仅入日志，不注册source。通用日志ts为桌面接收时间，额外client_timestamp_ms保留原发生时刻。

脚本早期/断线诊断缓存在内存 FIFO，最多 200 条；溢出丢最早项并累计计数，重连先 register/cues/sync，再发诊断与一次 dropped 计数。原始事件时间保留，桌面另记录 received 时间，不刷新成伪造的发生时间。无需新持久化浏览器存储。

`script_build_id` 使用显式维护的版本标识，更新脚本行为时同步更新测试/安装说明；验收另记录源文件 SHA-256，不能仅靠当前恒定的 `@version 0.1.0` 证明文件一致。不要求在脚本中嵌入自身全文 hash。

### 8.4 脱敏与可执行验收

日志按允许字段构造，禁止 `repr(settings)`、`str(job.context)`、原始异常 message 直接落盘；base_url 仅允许解析后的 hostname（去 userinfo、路径、query），timedtext URL 不保存。API Key、Authorization、Cookie、pot/signature/查询参数、字幕正文、完整提示词、模型响应均不保存。日志记录操作和处理结果，「全量」不解释为复制所有敏感载荷。`/status` 既有 orig/trans 回显保持回环用途，不能自动复制为日志。

验收 B44-D1：注入 AUTH、NETWORK、TIMEOUT、SHAPE_MISS、WORKER 后 status/浮窗可区分，原文不断；B44-D2：cache/mock/provider ready 来源准确；B44-D3：当前组状态不被旧组/旧 namespace 回调覆写；B44-D4：单组失败 20 tick 无新增请求；B44-D5：生产与连接测试两条路径都有事件，但 connection_test 仍不落盘完整报告（ADR-005 的历史边界保留）。

日志验收 B44-L1：午夜前后两文件、同日重启追加、30日窗口删除精确；B44-L2：并发事件每行 JSON 可解析且 seq 唯一；B44-L3：路径不可写、磁盘写失败、第二进程占用、队列满均可见且字幕不崩；B44-L4：用假的 canary Key/Authorization/Cookie/URL token/字幕正文注入正常和异常路径，搜索当前日志、归档、状态与stderr，所有禁止泄露项均不得出现（status 的字幕正文例外仅限原有 orig/trans，不得出现 Key/token）；B44-L5：断线200条上限、重连顺序、旧客户端兼容、invalid diagnostic 不改变 active source。

## 9. 分阶段实施任务与仓库管理

本表是计划内任务编号，不是假 GitHub issue 编号。当前请求只要求计划书，远端未变更。若随后用户授权发布到 tracker，再用 `gh` 建 map/子任务、回读校验；若仅授权本地 implement，就按本表执行并记录本地结果，不发送远端评论。

| 任务 | Blocked by | 交付与完成条件 |
|---|---|---|
| T0 基线与红测 | 无 | 核对 HEAD/远端决定、临时配置与缓存隔离、重现 B41/B42/B44，记录失败的行为断言 |
| T1 生产失败可见与日文件日志最小闭环 | T0 | Engine→App /status→浮窗 failed 状态；provider 单/批受控错误；日志 writer 与生产请求关联；B44-D1/D2/D4、L1/L2/L3/L4；先覆盖一条完整翻译失败路径 |
| T2 来源/捕获恢复 | T1 | 第5节全部契约与 B41 验收；通过日志记录被丢弃的旧视频响应，不改 hook 架构 |
| T3 纯正文与 Mock 缓存迁移 | T1 | 第6节全部 B42；新 ADR、真实缓存 golden、跨重启暖缓存和实际绘制验证 |
| T4 队列交付与紧急升级 | T1 | pending 升级、cached 通知、多消费者关联、容量、锁外通知；B44-Q1/Q2/Q6/Q7 |
| T5 当前需求与批失败补偿 | T4 | generation/identity 结果保护、一次补偿、配置保存恢复；B44-Q3/Q4/Q5/Q8、D3；与T2兼容 |
| T6 浏览器诊断与操作覆盖 | T2、T3、T5 | 第8.3节完整事件表、脚本 build ID、新帧校验与缓冲；L5、连接测试事件边界；更新协议与使用文档 |
| T7 全链自动验收与冷启动交接 | T6 | 第10节全量检查、夹具时序E2E、检查日志一条链可追溯；提交清单与剩余现场验收交接 |
| H1 维护者现场验收 | T7 | 按第11节L3/L4执行；无证据则保持未验证，不以自动完成代替关闭原票 |

执行顺序固定 T0→T1→T2→T3→T4→T5→T6→T7，避免 engine/queue/overlay 并行写冲突；无必要不先做大重构。每个任务提交只包含自身文件，必须记录新增行为验收与基线结果。T4 需要的 generation 数据结构可先新增并接入，T5 完成状态失效与补偿；中间提交不能接受错误旧结果。

Tracker 发布规则：

- issue 在 GitHub，全部走 `gh`。正文/评论一律 UTF-8 无 BOM 文件配 `--body-file`，真实换行；写后回读检查首字符非 U+FEFF、没有字面反斜杠+n。不要直接拼带转义的 shell 正文。
- 新 map 标 `wayfinder:map`；实现子票标 `wayfinder:task`，缺陷任务另加 `bug`，新日志能力可标 `enhancement`。建立原生 sub-issue；不可用才用 map 任务列表与 `Part of #实际编号`。
- 依赖使用原生 blocked_by，传的是 blocker 数据库 id，不是 #number/node_id；不可用才用 `Blocked by: #实际编号`。未发布前不编造编号。
- 仅规格完整且无开放 blocker 的实现票标 `ready-for-agent`；执行认领按 issue-tracker 约定赋给本人。#41 继续保持 `ready-for-human`，不要因为相邻修复把其历史状态倒退。
- #42/#44 的原始报告正文不改写成未经证实根因。另附「确定性代码缺陷」诊断说明和关联票。关闭子票必须有测试证据；不自动关闭父 map、#41、#42、#44。原票关闭还需对应现场复核结果。
- 本计划不授权发布/推送/合并。若新 agent 收到明确授权，再执行授权范围；不要把「写计划」误解为发布消息授权。

## 10. 自动验收与证据留档

PowerShell，仓库根目录执行：

```powershell
python -m pytest desktop/tests -q
node --test "userscript/tests/*.test.mjs"
node --check userscript/youtubesub.user.js
git diff --check
```

浏览器 E2E 必须真实运行，skip 不算通过。新测试至少补一个跨 Bridge→真实 WS→App `/status` 的 source 切换/旧响应拒收场景，及一个 Engine→真实 queue→可控 fake provider→显示的批失败后当前句补偿场景。不要要求网络真实 YouTube作为自动化夹具；不要用 Qt 内部字段断言替代最终绘制状态的 #42 测试。

本次诊断探针（均在工作区 `.scratch/`，可能不会随 git clone 携带；即使缺失，也可按第5～8节事件序列重建永久测试）：

| 命令 | 本次观察 | 退出语义 |
|---|---|---|
| `node .scratch/probe/issue41-boundaries-20260922.mjs` | RECOVERY远端旧错误；EARLY空视频ID；SPA新cue标旧源后清空 | 0 表示坏行为成立，非修复成功 |
| `python .scratch/probe42-labels.py` | 三cue组合后正文含三个【译】 | 输出证据，需看内容，非完整验收 |
| `python .scratch/issue44-queue-probe.py` | 无提升、无cached回调、批失败后20tick空白 | 0 表示坏行为成立，非修复成功 |
| `python .scratch/three-bugs-plan/probe_hidden_failure.py` | 原文Hello.、trans空、trans_available=true、status无AUTH | **预期退出1**，断言失败即红色证据 |

将新增永久测试放回现有 `desktop/tests` 与 `userscript/tests`，不要依赖探针中硬编码的本机绝对路径。用临时目录、屏障、固定时钟实现确定性；所有自建 worker/服务/日志 writer 在测试结束停止并等待，Windows 临时 SQLite 清理不能掩盖测试断言。

提交前核对：无凭证、无真实数据库、无 `.scratch` 无关产物；无临时 DEBUG 输出；协议/ADR/手测文档与行为一致。若修改 AGENTS/CONTEXT/docs/agents，另跑双模型静态清单。保留失败→通过的命令与摘要、最终提交SHA、完整自动测试统计、日志样例（仅合成数据）。

## 11. 维护者现场验收与停止条件

**L3 只由维护者执行**（#41 Q3；不是本计划新设审批要求）。使用实际安装脚本的内容与本次提交源文件核对 SHA-256，记录 `script_build_id`、desktop SHA、浏览器/Tampermonkey版本。不能只报 @version。

1. 人工轨和 ASR 分别播放；核对页面原字幕与浮窗原文；记录 source、cue 数、hook/capture 状态。先开视频再启动桌面、重新加载、SPA切视频、切语言、断线重连均检查；至少覆盖一次复用 video 元素的 SPA。
2. #41 原票允许两种诊断验收：字幕显示；或无字幕但 hook_error 明确失败级别与原因。后者仅表示「注入自证任务达标」，不表示用户字幕可用，也不能因此关闭整个修复计划。具体收尾交维护者按原票决定。
3. Mock 模式查看多cue组：只由UI加标签。关闭Mock后用维护者明确选择的真实服务执行 L4；现有测试连接通过只能证明其单组路径，不证明 batch 对齐和吞吐。
4. L4至少记录同一段冷缓存播放、重复播放暖缓存、seek、暂停/恢复、错误恢复；用日志确认单/批请求、缓存命中、当前需求和补翻。不要为了制造错误去改真实Key并保存；可用隔离配置/维护者控制的测试端点。
5. 真实性能记录：对至少20个播放进入的句子组，逐组记录开始显示时译文是否ready、若晚到则延迟、cache/provider来源；冷缓存与暖缓存分开统计。首组没有预热时间，单独列出。此为采样方案，不是已有实测结论；不设无依据的「必须95%」门槛。
6. 若原文存在而译文缺失，日志必须能归入未配置/排队/在途/失败/丢弃/就绪但未显示之一；如果仍只能看到空白且没有解释，则 #44 未完成。若provider延迟确实超过字幕提前量，应报告量测而非继续猜测或承诺绝对实时。

停止并交接的情形：无法获得 L3/L4 授权或凭证时，完成全部可离线实施/自动测试工作，交付明确的人工作业清单；不能编造通过、不能关闭未验原票。需要改 DOM 抓取架构、放宽批对齐契约、删除真实缓存、放宽网络安全边界时，超出本计划，不擅自实施。

## 12. 新 agent 的最终交付格式

最终报告必须包含：完成的 T 编号与提交SHA；每个 B41/B42/B44 验收通过/失败/未执行及证据；全套自动测试统计与skip原因；真实L3/L4是否由维护者执行；日志目录/轮转/保留说明；真实provider缓存未变而旧Mock缓存失效的证明；未关闭的issue及下一步。不得只写「三个bug已修复」。

本计划覆盖的核心改进是：来源事件有明确归属、正文与显示装饰分离、去重后的需求与结果不会丢失、失败状态和操作可以追溯。现场唯一根因仍须由这些观测与维护者复核共同确认。
