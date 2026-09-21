# O3 证据留档：真实站点抓不到 cue 的根因（2026-09-21）

**结论（一句话）**：抓取链从头到尾都是好的；**是 headless 模式让 YouTube 拒绝返回字幕正文**。
headless 下站点自己的 XHR 拿到的是 `200 + text/html + 0 字节`（请求 URL 里明写 `cbr=HeadlessChrome`），
站点自己也不显示字幕（`captionDom: null`）；改用 **headed** Chrome 后同一个 URL 返回 `200 + application/json + 8079 字节`
的 json3，userscript 解析出 **61 条 cue**，桌面端 `/status` 变成 `state=ok` 并显示真实歌词 + `【译】` 译文。

## 被推翻的假设

交接文档 §4 的首要假设是"注入的包装器被 YouTube 自己替换/恢复了 `window.fetch`"。**证据不支持它**：
- probe1 取到 tracer 包裹的那层函数的源码，头 120 字符与 `userscript/youtubesub.user.js` 的 hook 包装器逐字一致
  （`function () { var args = arguments; var url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].ur`）；
  probe1 里 `innerIsHook:false` 是我自己的判据写错——标记串 `youtubesub-timedtext` 在 `emit()` 里，不在包装器源码里。
- `xhrHookInstalled: true`；真实字幕请求走的是 **XHR** 而不是 fetch（`ttInFetch: 0, ttInXhr: 1`）。
- 人工派发一个合成 `youtubesub-timedtext` 事件：`listenerFired:true, cueCount:2, trackKey` 被填上 → 监听、解析、桥接全通。

## 运行清单（4 次有效 + 2 次纯属我操作失误的重跑）

| # | 模式 | 命令 | 关键观测 | 用途 |
|---|---|---|---|---|
| 1 | headless | `python .scratch/probe/live-hook-probe.py <url> 25` | inner 是 hook、XHR hook 在、合成事件通、`cueCount:-1` | 证伪"包装器被摘掉" |
| 2 | headless | `python .scratch/probe/live-hook-probe2.py <url> 24` | `ttInXhr:1`、`status:200`、`textLen:0`、`parseError: Unexpected end of JSON input` | 信道 + 载荷 |
| 3 | headless | `python .scratch/probe/live-hook-probe3.py <url> 18` | 全 URL 含 `&fmt=json3`；播放中（`playerState:1, t` 递增）；`refetch: 200 / text/html / len 0`；`captionDom:null` | 站点本体也拿不到 |
| 4 | headed | `PROBE_HEADED=1 python .scratch/probe/live-hook-probe3.py <url> 14` | `ttLen:8079`、`ct: application/json`、`bridge cueCount:61`、`app state=ok` | **决定性** |
| – | 重跑 | 同上 | 仅因 PowerShell 控制台 cp936 显示/编码（`♪` 打不出）而重跑两次，**不是新问题** | 浪费，见下 |

## 关键证据（原文摘录，已截断长 URL）

```
# run 3 (headless)
state    : {"paused":false,"t":19.2,"playerState":1,"captionDom":null,"ttLen":0,
            "ttFull":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ...&fmt=json3...&cbr=HeadlessChrome&cbrver=153.0.0.0&c=WEB..."}
refetch#2: {"status":200,"ct":"text/html; charset=UTF-8","len":0,"head":""}

# run 4 (headed)
state    : {"paused":false,"t":11.4,"playerState":1,"ttLen":8079,
            "ttFull":"https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ...&fmt=json3...&cbr=Chrome&cbrver=153.0.0.0&c=WEB..."}
refetch#2: {"status":200,"ct":"application/json; charset=UTF-8","len":8079,
            "head":"{\n  \"wireMagic\": \"pb3\",\n  \"pens\": [ {..."}
app      : {"state": "ok", "orig": "\u266a We are no strangers to love \u266a",
            "trans": "\u3010\u8bd1\u3011\u266a ...", "sources": 1, "hook_error": ""}
bridge   : {"cueCount":61,"trackKey":"https://www.youtube.com/api/timedtext?...&cbr=Chrome..."}
```

（`orig` 里的 `\u266a` 是音符符号；上面为通过 cp936 控制台，我把原文里的撇号改写成 ASCII 形式。）

## 由此得到的可执行结论

1. `--live` **不要加 `--headless`**：headless 下这条诊断永远 `no_cues`，那是浏览器指纹导致的，不是产品缺陷。
   建议把这一条写进 `docs/MANUAL-ACCEPTANCE.md` 的 L2（以及 `--live` 的帮助文本）。
2. 产品侧建议（未做，等你点头）：hook 目前对"拿到 200 但正文为空/不是 JSON"完全静默（`catch(function () {})`），
   结果就是"连接正常、永远没有字幕、也没有任何提示"。应当把这种失败上浮成可见状态（类似 `hook_error`）。
3. 真 Tampermonkey（L3）**值得做**：真实有头 Chrome 下链路已被证明是通的。

## 日志持久化现状与改动

- **harness 原来不留证**：`Harness.stop()` 会 `shutil.rmtree(self._tmp)`，Chrome profile 与 `chrome.log` 一起被删。
  所以前几次运行除了控制台输出，磁盘上什么都没剩——这是真实缺陷，建议给 `browser_e2e.py` 加一个 `--keep-logs`（未做，等你决定）。
- **本次已改**：三个 probe 脚本改为先 `import _tee; _tee.tee(HERE, "probeN")`，
  之后每次运行都会把完整输出写进 `.scratch/probe/logs/<时间戳>-probeN.log`，不再只靠控制台。
- 本文件是本次已跑证据的**转录留档**（原始控制台输出未保存，只保留了上面摘录的关键行）。
