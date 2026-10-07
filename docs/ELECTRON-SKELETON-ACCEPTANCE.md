# Electron 骨架验收细则 — youtubesub（Phase 1）

Phase 1 Electron 骨架票的**验收口径**：五能力各自「等价可用」的可执行断言，逐条标注判定通道（【CI】= CI/脚本可自动断言；【真机】= 真机人工复核）。
同时是 [Phase 1 TS 重构切分 grilling](https://github.com/CometDash77/youtubesub/issues/191) 票的输入（骨架顺序：最难 = 穿透态局部可点，其余四项 API 直给）。

- 事实底稿：[Electron 五能力真机验证](https://github.com/CometDash77/youtubesub/issues/193)（六场景判定 + 实现方式 + 坑 + 环境限制）；本文只引用其结论，不复述全文。
- 证据链：CI run 37567439635（GitHub Actions windows-latest）artifact `capcheck-evidence`；分支 `capcheck-ci-evidence@878c197` 留档；本机 `.scratch/electron-cap-check/evidence-ci/`（report.json / hotkey.log / 六场景截图）。
- 定案票：[Electron 骨架验收细则定案](https://github.com/CometDash77/youtubesub/issues/195)；运行时选型依据 [ADR-013](docs/adr/ADR-013-desktop-runtime-electron.md)。
- 对照现状：desktop/ PySide6 行为（等价口径见文末参照表）。

---

## 使用规则

1. **判定通道只有两种**，每条断言必须落在其中一种，无一条悬空：
   - `【CI】` = CI/脚本可自动断言，输出即判定，不给解释空间；
   - `【真机】` = 真机人工复核（CI 不可判定），骨架票验收时人工执行并留记录。
2. **真机复核前置 = 版本一致性核对**：复核所用副本必须与被验收的骨架代码同版（对照 git rev / 构建产物），**先核对版本，再测**。#193 真机首轮悬停解锁失败即因复核副本未同步取证分支修复——是复核事故，不是产品缺陷。
3. **假阳性红线**：#193 本机三轮假阳性教训——探测时序早于被测状态 = 测了寂寞。所有状态类断言以**应用态确认**（主进程日志 / `/status` 字段）为时序锚，禁止用固定 sleep 猜时序；CI 冷启动会暴露这类巧合，本机慢路径会掩盖它。
4. **等价口径**：断言比对**效果与能力位**，不比对 PySide6 的实现路径（坑 3）。

## 断言表

### ① 无边框置顶窗 + 逐像素半透明

| 编号 | 通道 | 断言（怎么判） | 通过标准 |
|---|---|---|---|
| A1.1 | 【CI】 | 置顶位：`GetWindowLongW(hwnd, GWL_EXSTYLE)` 读数 | `WS_EX_TOPMOST (0x8)` 位为 1（#193 场景 A：基线 rawExStyle `0x200008` 含 TOPMOST） |
| A1.2 | 【CI】 | 无边框：`GetWindowLongW(hwnd, GWL_STYLE)` 读数 + 窗口矩形截图 | `WS_CAPTION (0x00C00000)` 位为 0；截图内无系统标题栏 / 边框像素（旁证 sceneA-base-window.png） |
| A1.3 | 【CI】 | 逐像素半透明：窗口隐藏时同屏区域参照帧 vs 窗口显示时截图，对透明区域（圆角外 / 底板 alpha=0 处）逐像素比对 | 透明区域逐像素相等（背景内容透窗）；正文区域为 rgba 底板合成结果（旁证 sceneA-base-full.png） |
| A1.4 | 【CI】 | 穿透开启佐证位：穿透态重读 GWL_EXSTYLE | `WS_EX_LAYERED\|WS_EX_TRANSPARENT (0x80028)` 出现（实测 `0x280028`）；**仅作穿透佐证，不作半透明判据**（坑 3） |

> **坑 3（#193）**：Electron 44 的 `transparent` 走 DWM 路径，初始 rawExStyle 不设 `WS_EX_LAYERED`（`0x200008`，含 `NOREDIRECTIONBITMAP`）；PySide6 `WA_TranslucentBackground` 设 LAYERED——路径不同、视觉效果等价。半透明断言比对截图透窗效果与 TOPMOST 能力位，**不得**要求 LAYERED 位常在。

### ② 鼠标穿透 + 局部可点（renderer↔main 状态联动）

三判点（#193 场景 B / C 实证）：穿透基线 before=false → 热区 hotspot=true → 离开恢复 mid=false。

| 编号 | 通道 | 断言（怎么判） | 通过标准 |
|---|---|---|---|
| A2.1 | 【CI】 | 穿透基线（before）：主进程日志 `set_click_through true` 落盘后（时序锚，坑 1），`WindowFromPoint(热区中心)` | 命中**非本窗**（isOverlay=false，点击落到背后窗口） |
| A2.2 | 【CI】 | 热区可点（hotspot）：主进程 `sendInputEvent` 合成 mousemove 至热区 → renderer `elementFromPoint→closest(".hot")` 判定 → `setIgnore(false)` | renderer 日志 `hot=true` + `set-ignore false`；`WindowFromPoint(热区中心)` 命中本窗（isOverlay=true） |
| A2.3 | 【CI】 | 离开恢复（mid）：合成 mousemove 移至窗体中央（非热区） | renderer 日志 `hot=false` + `set-ignore true`；`WindowFromPoint` 恢复 isOverlay=false |
| A2.4 | 【真机】 | **真实鼠标路径解锁**（独立断言，CI 合成事件不替代——硬输入 1）：真实鼠标悬停热区 → 点击解锁图标 | **完整状态翻转**（硬输入 3）：锁图标消失 + 状态文字清空 + 主进程日志 `set_click_through false` + 窗口恢复可点 + 移出热区**不再复透** |

> **点锁 = 完整状态翻转，不是仅鼠标层 `setIgnore(false)`**（硬输入 3）：#193 真机第二轮取证（hotkey.log）——点击全部到达 renderer，但 click handler 只直调 set-ignore、不走主进程 `setClickThrough(false)`，clickThrough 标志不复位，移开即复透。骨架实现要求点锁与热键**走同一条完整翻转路径**（renderer → preload unlock-through → main `setClickThrough(false)`）。CI 合成事件若只打到 set-ignore 层，会漏检「点击到达但应用态未翻转」这类缺陷。
>
> **坑 2（#193）**：body 状态类与热区标记类**不得同名**——状态类已改名 `hot-bg`；若同名，`closest(".hot")` 会命中 body 自身恒真，热区判定失效。复核前先查 DOM：状态类 ≠ `.hot`。

### ③ 托盘图标与右键菜单

| 编号 | 通道 | 断言（怎么判） | 通过标准 |
|---|---|---|---|
| A3.1 | 【CI】 | 行为侧：Tray 创建 + `setContextMenu` 注册 + `popUpContextMenu` 真实执行 | `closed` 事件打点闭环（模态循环真实运行；hotkey.log：`tray popUpContextMenu` → `tray menu closed`） |
| A3.2 | 【真机】 | 视觉弹出态：真机右键托盘图标 | 菜单视觉弹出、条目可点（穿透开关勾选态随 `setClickThrough` 翻转、「退出」可退出） |

> 无人值守会话（CI runner）菜单弹出被系统立即 dismiss（tray 锚 189ms / 窗口锚 2ms），视觉弹出态不可捕获——A3.1 行为侧绿**不替代** A3.2。

### ④ 全局热键（Ctrl+Alt+U）

| 编号 | 通道 | 断言（怎么判） | 通过标准 |
|---|---|---|---|
| A4.1 | 【CI】 | `globalShortcut.register("Control+Alt+U", …)` 返回值 | `true`（返回 false = RegisterHotKey 冲突，如实记失败——注册表式热键的失败模式，PySide6 GetAsyncKeyState 轮询没有这一失败面） |
| A4.2 | 【CI】 | OS 级真实键序投递（SendInput / keybd_event 序列，非 Electron 合成事件）触发热键 | 主进程日志 `hotkey fired Control+Alt+U -> click_through off` + `set_click_through false`；`WindowFromPoint` 恢复 isOverlay=true（**窗口状态 + 主进程日志互证**） |

### ⑤ 本地 WebSocket 服务（协议 v1 语义）

| 编号 | 通道 | 断言（怎么判） | 通过标准 |
|---|---|---|---|
| A5.1 | 【CI】 | `GET http://127.0.0.1:<port>/health` | 200 `{"ok":true,"version":1}` |
| A5.2 | 【CI】 | Origin allowlist：非白名单 Origin（如 `https://evil.example.com`）发起 upgrade；白名单（空 Origin / localhost / `*.youtube.com`）对照 | 非白名单 HTTP 403 拒绝且连接销毁；白名单放行 |
| A5.3 | 【CI】 | 坏帧容错：同一连接先发非 JSON 帧、再发未知 type 帧、最后发合法帧 | `bad_frames` 计数随坏帧增加；**连接不断**，后续合法帧照常处理（#193 实测 frames:6 bad:2 error:0 state:ok） |
| A5.4 | 【CI】 | cue 下发 → 状态回报：register → cues → sync 依序下发，读 `/status` | `sources` +1、`title` 更新、`state` waiting→ok、`orig` = 最后一条 cue 文本、`playing` 随 sync 翻转、`stats.frames` 与发送帧数一致 |
| A5.5 | 【CI】 | 只绑 loopback：服务 listen 地址 | `127.0.0.1`（[ADR-003](docs/adr/ADR-003-localhost-security.md) localhost 安全边界；协议 v1 语义不变，重构期间不改） |

## 固化进断言的三个坑（全部来自 #193）

1. **穿透断言测穿透态本身**（坑 1）：时序锚 = 主进程日志 `set_click_through true` / 应用态确认，禁止固定 sleep 早于穿透定时器——#193 本机三轮假阳性（3s 穿透定时器晚于秒级探测，测成整窗可点）即此。对应 A2.1。
2. **状态类与热区类不得同名**（坑 2）：`closest(".hot")` 命中 body 恒真会让热区判定失效；状态类 `hot-bg` 与热区类 `.hot` 分名。对应 A2.2 / A2.4 复核前置。
3. **DWM 路径无 LAYERED**（坑 3）：Electron 44 transparent 与 PySide6 半透明实现路径不同、效果等价；断言比对效果与能力位，不照抄 PySide6 路径。对应 A1.3 / A1.4。

## 真机人工复核流程（骨架票验收时一并执行，不单独立票）

0. **版本一致性核对**（前置，硬输入 2）：核对复核副本 git rev / 构建产物与被验收骨架一致；不一致 → 先同步再测，此前结果作废重录。
1. **A3.2 托盘视觉**：右键托盘图标 → 菜单弹出 → 勾 / 取消「鼠标穿透」→ 观察浮窗状态行翻转 →「退出」退出。
2. **A2.4 真实鼠标路径解锁**：开启穿透 → 真实鼠标移入解锁图标热区（图标背景变亮）→ 点击 → 逐项核对完整翻转清单：图标消失 / 状态文字清空 / 移出热区不复透 / （可选）Ctrl+Alt+U 再锁复测。
3. **记录**：每条留截图 + 现象 + 代码版本；失败按 [MANUAL-ACCEPTANCE](docs/MANUAL-ACCEPTANCE.md) 口径区分环境结论与产品结论。

## 与 PySide6 现状的等价参照

| 能力 | PySide6 现状 | Electron 对应 | 等价口径 |
|---|---|---|---|
| 置顶 | `WindowStaysOnTopHint` | `alwaysOnTop: true` | TOPMOST 位一致（A1.1） |
| 逐像素半透明 | `WA_TranslucentBackground`（LAYERED） | `transparent: true`（DWM / NOREDIRECTIONBITMAP） | 截图透窗效果一致（A1.3）；路径不同不算不等价 |
| 穿透 | `WindowTransparentForInput` | `setIgnoreMouseEvents(true, {forward: true})` | 三判点全过（A2.1–A2.3） |
| 局部解锁 | 热区 + `GetAsyncKeyState` 轮询 Ctrl+Alt+U（唯一解锁回路） | 热区 `closest(".hot")` + `globalShortcut`（注册表式，无轮询线程） | 完整状态翻转（A2.4 / A4.2） |
| 托盘 | `QSystemTrayIcon` + `QMenu`（托盘与浮窗共用同一 QMenu） | `Tray` + `Menu` | 行为侧闭环 + 视觉复核（A3.1 / A3.2） |
| WS | `desktop/suboverlay/server.py`（Python websockets） | 主进程 Node `ws`，协议 v1 原样重写 | A5.1–A5.5 全过；语义不变 |

## 消费与边界

- **消费者**：Phase 1 Electron 骨架票（本表即验收口径，逐条执行）；[Phase 1 TS 重构切分 grilling](https://github.com/CometDash77/youtubesub/issues/191)（骨架顺序输入：最难 = 穿透态局部可点——renderer↔main 状态联动 + OS input 路径；其余四项 API 直给）。
- **Out of scope**（[定案票](https://github.com/CometDash77/youtubesub/issues/195) brief）：骨架实施本身；切分裁定；验证代码进主干（throwaway + `capcheck-ci-evidence` 分支留档不变）；协议 v1 语义的任何变更。
