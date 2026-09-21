# CONTEXT — youtubesub (自包含, 新 session 从这里读起)

## 事实
- 用户工作目录 D:\Documents\vibe 建项目时为空; 落地目录为 `d:\Documents\vibe\youtubesub`. 现为 **git 仓库** (origin: github.com/CometDash77/youtubesub, 分支 master; 早期"不是 git 仓库"的记录已过时)。
- 本机: Windows 10, Node 22.23.1, Python 3.12.10 (pytest 9.1.1 / websockets 16.1.1 / requests / PySide6_Essentials 6.11.2 已装)。无 Rust/.NET。
- 浏览器: Chrome **153.0.8010.48** 位于 `C:\Program Files\Google\Chrome\Application\chrome.exe`; Edge 153。
  Chrome User Data 里**没有 Tampermonkey** (未装任何扩展) -> "真 Tampermonkey" 场景需要用户手动装。
- DNS 污染, 直连 YouTube 失败; 代理 `127.0.0.1:10809` 可用 (实测 youtube.com 200)。环境变量已设 HTTP(S)_PROXY 与 NO_PROXY=localhost,127.0.0.1,::1,...。
  凡访问公网的 HTTP 客户端必须代理感知; loopback 流量不走代理 (测试里用 `http.client` 最稳, `urllib` 会读代理环境变量)。
- 实测: 裸 `https://www.youtube.com/api/timedtext?v=...&lang=en` (无 pot) -> 200 且 **0 字节** -> 印证必须页内复用播放器带 pot 的请求。

## 访谈结论 (grill-with-docs, 已锁定)
- 桌面栈: Python + PySide6.
- 浏览器端: Tampermonkey 用户脚本.
- AI 凭证: 用户稍后提供真实 Key/BaseURL/Model; 在此之前用 Mock 翻译服务验证链路, AI 成功场景记为部分验证。

## 术语 (跨票共用; 讨论时按此用词)
- **预取 (prefetch)**: 调度行为 —— 在播放点到达之前把前方尚未播出的句子组送去翻译, 使到达时译文已就绪或已在途。
- **批量 (batch)**: 请求形态 —— 把多个句子组放进**同一次** provider 请求。
- 两者正交、可独立取舍。注意参照实现 kiss-translator 的 `batchSize=20` 是它 DOM 段落翻译的通用参数, **与字幕预取无关** (取证见 #3); 讨论"批大小"时先确认说的是哪一个。
- **翻译命名空间 (provider namespace)**: 由 provider 配置 + 系统提示词确定的缓存身份前缀 —— 同一命名空间内按 identity 命中缓存, 跨命名空间绝不命中。`mock` 是它的一个维度 (ADR-008), 所以"勾 Mock 跑过的句子"与"真实 provider 的同一句"是两个命名空间; 命名空间变动时内存里的旧译文同样作废。

## 许可证边界
- dkitle: Rust 端无 LICENSE (GitHub license:null) -> 只参考设计, 不抄代码; 其 userscript 有 @license MIT 头, 可改写适配。
- yt-dual-subs: MIT -> 可改写复用 (保留版权). transly: MIT -> 设计吸收为主, 建议 clean-room Python 重写。
- LiveSubs / local-screen-translator: Apache-2.0 -> 可复用 (保留声明, 改动注明)。

## 研究报告 (recon 要点已折入 docs/DESIGN.md)
- dkitle: 线协议 + 桌面时钟模型 (primary). 缺陷: gap-hold 无 TTL / 重连回放旧 sync 带新 timestamp / 无 SPA 处理 / /ws 无鉴权.
- yt-dual-subs: pot 复用抓轨 / parseJson3(lastOff) / lastOff 分句 / trans 随 cue / nearestTcue 1200ms / 对齐协议与校验 / lane 模型与实测常量.
- transly: 配置 schema 与 Key 边界 / protocol auto 适配 / SSE-or-JSON 检测 / 缓存 identity SHA-256 / 单一并发权威 / 严格对齐校验. 缺: 重试/backoff/429/队列取消.
- LiveSubs: WPF 浮窗 PORT PLAN (12 条, Qt 版). 注意: 透明度双重相乘 bug 不要学; click-through 要补解锁路径.
- local-screen-translator: DOM 回显是错误架构, 仅复用 LRU/dpi/overlay flag 思路; localhost sink 教训: JSON + Origin 检查.

## 状态 (详见 PROGRESS.md 与 `.scratch/handoff/` 下最新交接文档, 随做随更)
- 桌面端全部实现完毕; **pytest 88 passed** (~20s)。含真实 WS 集成、引擎全管线(mock)、浮窗 resize 回归、
  /health 与 /status 路由、无 provider 不泄露、provider 抛错不 500、跨语言解析夹具 11 例、
  **真浏览器 E2E 7 条 (夹具页 + 真 userscript + 真 app.py, 只经 /status 黑盒观察; 无 Chrome 则 skip)**、热键 4 条、浮窗状态 2 条。
- **Node 测试台: 38 passed** (命令 `cd userscript; node --test "tests/*.test.mjs"`; 传目录会 MODULE_NOT_FOUND)。
  共享夹具 `userscript/tests/fixtures/parse_cases.json` 被 JS 与 Python 两侧断言同一份内容 (解析一致性)。
- userscript 现在 **471 行**。上一轮修了 3 处: (1) 去重改为内容签名 (`cuesSignature`) —— 修"同 cue 数不同轨道被误判为重复";
  (2) 无 GM_xmlhttpRequest 时 health 回退为直接尝试 WS; (3) `trackLangFromUrl` 优先 tlang。
- userscript E2E 会话再改: 注入改为 **Trusted Types 感知的三级回退** (GM_addElement → trustedTypes policy → 主世界 new Function,
  最后一级若身处沙箱则主动跳过以免装进错的 realm); 新增 `hookError` 状态 + 面板 `[NO PAGE HOOK]` 标记 + register 帧携带 `hook_error`。
  根因是真实 youtube.com 上 `el.textContent = code` 被 `require-trusted-types-for script` 拒绝, 页面钩子静默失败 (详见交接文档 §2 bug#4)。
- 浮窗已真实运行并经假浏览器驱动验证 (截图像素证据: 原文白字+译文黄字均渲染; 暂停后清空)。
- 用户反馈已修: 无窗口尺寸限制; 字号下限6/默认10可设; 放大后无法缩小的 resize bug (按下锁定边缘)。
- **`GET /status`**: `{ok,version,stats}` + `state/orig/trans/trans_available/playing/rate/title/mode/order/history/click_through/hook_error/capture_error`。
  用途: 不截图就能看"连上了吗/浮窗在显示什么"; 也是浏览器 E2E 的黑盒观察口。会回显字幕文本 (仅 loopback, 无 provider 时不回显)。
  `trans_available` = `_provider_usable` (显式 Mock, 或 base_url+model 非空), 浮窗据此在没有译文可显示时回退显示原文
  (issue #1: 行带常驻【原】/【译】标签; bilingual 两行之间恒画一条横向分割线; 没有 provider 的默认设置不再表现成空白)。
- ✅ **浏览器侧已在真 Chrome 里跑过** (E2E 7 条全绿 + `--demo`/`--live` 人工入口): 页面钩子在真实主世界抓到 timedtext、
  真实 Origin 过 WS 白名单、真 cue 走到浮窗显示态、play/pause/seek/rate/SPA 语义均经 `/status` 黑盒断言。
  该会话据此修掉 4 个真 bug (cues 清零时钟 / click-through 无解锁路径 / 菜单时序 / YouTube Trusted Types 静默失败)。
- ⚠ 仍未验证: **真 Tampermonkey** (本机没装扩展)、**真实 AI Key 翻译链路** (等 Base URL+Key+Model)、
  **真实 youtube.com 抓不到 cue 的根因** (注入成功、站点确实在发 timedtext、但 bridge 没抓到; 根因未定论, 用户已归入手动验收)。
- 手动验收入口: `docs/MANUAL-ACCEPTANCE.md` (四层); 一键启动 `start-desktop.cmd`; 依赖 `requirements.txt`。
- ✅ (2026-09-21) **断句判据已定**: 对齐 kiss-translator 的规则分支 (ADR-006 取代 ADR-004 的判据部分; 翻译单位不变), 规格 = issue「字幕断句判据对齐 kiss-translator（规格）」#22。**代码尚未改动**。
- ✅ (2026-09-21) **提前批翻译已定**: 预取改用**时间量纲** (默认 90 秒 + 组数硬上限 20), 触发保持事件原生增量 + seek 去抖 (不照搬它的 30s 扫描节流), **新增批请求** (只在填充爆发点同步切块, 全局连续编号 + 精确全覆盖, 失败整批作废交紧急补翻, 批内保留每组上下文以维持 cache identity 不变式), 在途请求一律不中断 (ADR-007)。规格 = issue「提前批翻译：预取窗口与批请求契约（规格）」#24。**代码尚未改动**。

- ✅ (2026-09-21) **#31 已修**: Mock 回显与真实译文不再共用缓存身份 (mock 进 identity, 身份方案版本 1 -> 2, 见 ADR-008); 队列任务改为携带提交时的 provider 快照与命名空间, 命名空间变动时内存里的旧译文作废并重取, 晚到的旧命名空间结果被丢弃。升级后本地缓存全量失效一次 (旧库里两类行同 key, 无法只作废被污染的那类)。**待人工验收** (L4: 勾 Mock 跑一句 -> 取消勾选 -> 同一句必须真实请求)。

## 下一步 (断点, 完整清单见 `.scratch/handoff/` 下最新交接文档 §5)
0. **(已落盘, 待裁决)** P0 思维对齐: `.scratch/alignment/20260921-112756-E2E与手测入口.md` (D/K/C/O/F + 可疑遗漏 A/B);
   O 类与 A/B 类的"请裁决"项仍待用户回答。**不要重做对齐**。
1. 用户按 `docs/MANUAL-ACCEPTANCE.md` 手动验收 (L1 夹具演示 / L2 真实站点诊断 / L3 真 Tampermonkey / L4 真实 Key)。
2. (已定论 2026-09-21) "真实 YouTube 抓不到 cue" = **headless 指纹**, 不是产品缺陷: headless 下 youtube.com 给 `200 + text/html + 0 字节`,
   headed 下同一 URL 给 `200 + application/json + 8079 字节`、桥接 61 条 cue、浮窗显示真实歌词 + 【译】。
   所以 `--live` **不要加 `--headless`**; 失败原因现在会以 `capture_error` 上浮 (浮窗状态行 + `/status` + 面板 `[NO CAPTION BODY]`)。
3. 剩余 P2 打磨: 历史字幕行渲染 / 打包分发 / 多标签 source UI。
4. 收尾双轴评审: 当时本项目还不是 git 仓库、没有 fixed point, 故改为对交接文档 §1 的文件清单评审 (需用户确认这种替代)。**注: 仓库现已建立并有提交历史, 此事可用 git fixed point 重议**。
5. (2026-09-21 新增) 断句判据对齐 kiss 的**实现**尚未开始: 规格 #22 (ready-for-agent) → 拆票 → 逐票实现 (TDD); 验收按规格里的判据表。
6. (2026-09-21 新增) 提前批翻译的**实现**尚未开始: 规格 #24 (ready-for-agent) → 拆票 → 逐票实现 (TDD)。注意三个上限默认值 (组数硬上限 / 批组数上限 / 批字符上限) 目前**无实测依据**, 要等真实 Key 到位后用"译文就绪率"校准。
