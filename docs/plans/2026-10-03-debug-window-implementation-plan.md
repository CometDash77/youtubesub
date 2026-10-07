# 调试窗口实施计划（地图 #152 · 实施票 #158）

> **状态更新（2026-10-03，维护者裁定）：外层透明 / 磨砂已废 —— 本计划的磨砂部分作废，不要照做。**
> 维护者看过渲染图后裁定「保留内卡片就好了，外卡片的透明毛玻璃效果没有必要」。据此：外层窗口改为**单版不透明**奶油底（`debug_tokens.WINDOW_RGBA=(246,243,235,255)`；原 `PSEUDO_FROST_RGBA` 已删）；`debug_frost` seam 整条删除 —— `desktop/suboverlay/debug_frost.py` 与 `desktop/tests/test_debug_frost.py` 已删（原件备份 `.scratch/wf-session/backup-frost/`）。
> 据此作废的条目：Goal 的「磨砂真/伪自动降级藏在可注入 seam 后」、Global Constraints 的「磨砂不用库的亚克力，走自建 seam」与失败路径里的磨砂、Review Focus 4、**Task 3 的 `debug_frost.*`**（`PSEUDO_FROST_RGBA`、`probe_env` / `decide` / `enable_frost` 及其 6 个启用条件与测试）、**Task 9 的 `frost_env` 参数与 `enable_frost(...)`**、Spec coverage / Review Focus 里指向磨砂的归属。**其余任务与 Step 照旧有效。**
> 现状权威：`wayfinder/debug-window-style-tokens.md` §3（窗口底规则：不透明，磨砂已废）+ issue #158 的 resolution 评论。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在桌面端做出一个独立非模态「调试」窗口（调参页 + 排障页），控件取自 PySide6-Fluent-Widgets，视觉按地图 token 文档，磨砂真/伪自动降级藏在可注入 seam 后。

**Architecture:** 三个**不依赖 Qt** 的纯逻辑模块（设置护栏表 / 取数 / 事件留痕 / 单发自续调度）承担全部易错逻辑，可在没有窗口服务器的前提下被断言；Qt 侧只做渲染与交互，通过 `S.save` 与浮窗「重读设置」两个既有 seam 与外界通信。设置护栏表落在 `settings.py`（唯一权威，规格 #161:79），GUI 只消费。

**Tech Stack:** Python 3.12 / PySide6 6.11.2 / PySide6-Fluent-Widgets 1.11.3（ADR-012）/ pytest（无 pytest-qt，offscreen + 模块级 QApplication 单例）。

**Spec:**
- 调参页：`gh issue view 161`（本地副本 `.scratch/wf-session/b161.md`）
- 排障页：`gh issue view 162`（本地副本 `.scratch/wf-session/b162.md`）
- 决策原文：#155 / #156；视觉：`wayfinder/debug-window-style-tokens.md`；观感基准：`desktop/prototype/157-debug-window/`（变体 A，分支 `prototype/157-debug-window` tip `a8786fc`）
- 技术决议：`docs/adr/ADR-012-debug-window-pyside6-fluent-widgets.md`

## Global Constraints

- 控件取自 **PySide6-Fluent-Widgets >= 1.11.3**（ADR-012）；**磨砂不用库的亚克力**，走自建 seam。
- **不改公开状态接口**：`/status` 的键一个不加、一个不改（规格 #162 范围外；`CONTEXT.md:27` 同义）。排障页读不到的信号**就不显示**（规格 #162 决策 16）。
- **不动**现有「AI 翻译设置」对话框与浮窗的既有行为；浮窗只新增一个「重读设置」入口（`overlay.reread_settings()`）。
- 调参页**只写它动过的那几个键**，其余键（含用户手写在文件里的越界值）原样保留；**凭证永不进调试窗口**。
- 既有全量测试（`python -m pytest desktop/tests -q` = **271 passed**；`cd userscript && node --test "tests/*.test.mjs"` = **40 pass**）保持全绿，断言不得删改或放宽。
- 新增测试**不得**依赖真网络、真浏览器、真实合成器；`QT_QPA_PLATFORM=offscreen` 下必须能跑、不得阻塞。
- 文案中文（沿用现有对话框风格：`确定` / `取消`）；分组名 = 显示 / 网络与服务 / 实验（未校准）。
- 失败路径不许抛异常穿透到 UI：磨砂、取数、事件记录都各自吞掉并降级。
- 工作区现状：分支 `codex/refactored-runtime`，**已有 162 项他人未提交改动**（含本地图的依赖落地 ADR-012/requirements.txt，以及托盘 `self.tray` 与 `server._startup_error` 的 WIP）。本轮**只做加法**，不提交、不 reset/clean、不覆盖他人改动。托盘与启动错误回传是既有 WIP 提供的既成事实，本计划消费它们。

## Review Focus

五类输入/失败模式，最可能先咬人：

1. **setting.json 被手改成越界或类型错误**（`timeout_s: "abc"`、`bg_opacity: 999`、`bg_color: [0,0]`）→ 调参页打开时**不得崩**，控件显示夹取后的合法值；本页不修既有读侧崩溃路径（规格 #161 范围外）。
2. **`display.mode` 非 bilingual `display.order`** → 顺序控件必须置灰并给出说明，但**不丢值**（切回双语时原值仍在）。
3. **服务不在听 / 端口不对 / 取数超时**（含「从未成功取到数」）→ 状态条转红并显示上次成功时间与龄；连续失败约 10 秒后清空数值区；**不得**呈现看似真实的旧数字，也不得空白页。
4. **offscreen / 无合成器 / 非 Win10** → 磨砂必须静默降级为伪磨砂，构造窗口不得阻塞、不得抛异常。
5. **窗口关闭后再次打开 / 编辑中按下取消** → 不残留半写的内存状态；取消后 settings 与磁盘都不得变化。

---

### Task 1: 设置护栏表（唯一权威）与控制台置零

**Files:**
- Modify: `desktop/suboverlay/settings.py`（新增常量与纯函数；改 53-57 的注释）
- Modify: `desktop/suboverlay/engine.py:15-17`、`desktop/app.py:430-431`（注释同步事实）
- Test: `desktop/tests/test_tuning_fields.py`（新建）

**Interfaces（Produces）:**
- `TUNING_GROUPS = ("display", "network", "experimental")`
- `TUNING_FIELDS = (...)`：tuple of dict，每项键固定为
  `{"path": ("display","mode"), "group": "display", "label": "显示模式", "control": "choice"|"int"|"float"|"color", "choices": (...), "labels": (...), "min": float, "max": float, "step": float, "default": <UI 单位>, "scale": 1|1000, "restart": bool, "uncalibrated": bool, "notify_overlay": bool, "hint": str}`
  （不适用的键留空/缺省；`scale=1000` 仅用于 `prefetch.seek_debounce_ms`，UI 单位=秒）
- `field_by_path(path) -> field`：不在表内 → `KeyError`（凭证与已有入口据此不可达）
- `is_scaled(field) -> bool`：True = 界面单位与存储单位不同（目前只有 `prefetch.seek_debounce_ms`）
- `display_value(field, cfg) -> value`：存储值 → 夹取 → UI 单位；类型坏/越界 → 用 `field["default"]`（**绝不抛**）
- `stored_value(field, ui_value) -> value`：UI 值 → 夹取 → 存储单位（`scale != 1` 时按 `int(round(v*scale))` 落盘）
- `tuning_ui_state(cfg) -> {path: ui_value}`：页面打开时的**工作副本**（颜色项返回新 list，不别名 cfg）
- `collect_edits(ui_state, initial_state) -> list[tuple[path, ui_value]]`：**按值比较**只挑出与打开时不同的项 —— 这是「不动没改过的键」的实现方式，手写越界值不会被顺带夹掉
- `apply_edits(cfg, edits) -> list[path]`：把 `stored_value` 后的值写进 `cfg`（原地），返回真正写入的 path

15 个字段（顺序即页面顺序，值与规格 #161 表一致）：`display.mode`/`display.order`/`display.history_lines`/`display.font_bold`/`display.stroke`/`display.bg_color`/`display.bg_opacity`；`provider.timeout_s`/`provider.max_concurrent`(restart)/`server.port`(restart)；`prefetch.lead_s`/`prefetch.max_groups`/`prefetch.seek_debounce_ms`(scale 1000)/`batch.max_groups`/`batch.max_chars`；实验组三项 + 后两项 `uncalibrated=True`。

- [ ] **Step 1: 写失败测试** `desktop/tests/test_tuning_fields.py`
  - `test_fields_cover_exactly_the_spec_paths`：15 条 path 集合 == 规格清单；且**不含** `provider.api_key`/`base_url`/`model`/`protocol`/`mock`/`prompt.*`/`display.font_size`/`window.*`。
  - `test_defaults_match_default_settings`：除 `seek_debounce_ms` 外，每字段 `display_value(field, S.default_settings())` == 规格默认值；seek 字段 UI 默认 `0.4` ↔ 存储 `400`。
  - `test_clamp_is_boundary_inclusive`：`stored_value` 对 越界/边界/区间内 三类输入分别给出 边界/边界/原值（对 int 字段做类型转换）。
  - `test_choice_field_rejects_unknown_value`：非法枚举 → 默认值。
  - `test_color_field_clamps_each_channel_and_rejects_wrong_length`：`[0, 300, -5] -> [0,255,0]`；`[0,0] -> 默认 [0,0,0]`。
  - `test_seek_seconds_milliseconds_round_trip`：`0.4/0.5/5.0` 往返一致；`9999 -> 5 秒 -> 5000`。
  - `test_collect_edits_only_returns_changed_keys`
  - `test_apply_edits_preserves_untouched_keys`：cfg 里塞一个手写的 `{"prefetch": {"max_chars_draft": 123}}` 与越界的 `display.font_size=99`，只改一个字段后二者**原样保留**。
- [ ] **Step 2: 跑测试确认失败** `python -m pytest desktop/tests/test_tuning_fields.py -q` → `ImportError: cannot import name 'TUNING_FIELDS'`
- [ ] **Step 3: 实现** `settings.py` 常量表 + 上述 5 个纯函数（风格对齐现有：纯函数、普通 dict、无类型注解）；把 53-57 注释改成「这四项已由调试窗口的调参页暴露（实验区），校准仍未做」；同步改 `engine.py:15-17`、`app.py:430-431`。
- [ ] **Step 4: 跑测试确认通过** `python -m pytest desktop/tests/test_tuning_fields.py -q` → 全绿
- [ ] **Step 5: 全量回归** `python -m pytest desktop/tests -q` → ≥271 passed（新增测试令总数上升，不得有 failed）

### Task 2: 浮窗「重读设置」入口

**Files:**
- Modify: `desktop/suboverlay/overlay.py`（新增 `reread_settings()`）
- Test: `desktop/tests/test_overlay_reread.py`（新建）

**Interfaces:**
- Produces: `OverlayWindow.reread_settings() -> None`：从 `self.settings["display"]` 重新抄 `mode`/`order` 到 `self.mode`/`self.order`，并 `update()`；**不动**其它状态（history/orig/trans/status）。

- [ ] **Step 1: 写失败测试**：offscreen 构造 `OverlayWindow(S.default_settings())`，把 `settings["display"]["mode"]`/`["order"]` 改成 `"trans"`/`"orig_first"`，调 `reread_settings()`，断言 `w.mode == "trans"`、`w.order == "orig_first"`；再断言 `w.history`/`w.orig_text` 未被清空（先塞一条进去）。
- [ ] **Step 2: 确认失败** `python -m pytest desktop/tests/test_overlay_reread.py -q` → `AttributeError: 'OverlayWindow' object has no attribute 'reread_settings'`
- [ ] **Step 3: 实现**：在 `swap_order`/`cycle_mode` 附近加该方法；`__init__` 里那两行抄写改为调用同一段读取逻辑（保持行为不变）。
- [ ] **Step 4: 确认通过**；`python -m pytest desktop/tests/test_overlay_labels.py desktop/tests/test_overlay_reread.py -q` 全绿。

### Task 3: 视觉 token 与磨砂 seam

**Files:**
- Create: `desktop/suboverlay/debug_tokens.py`
- Create: `desktop/suboverlay/debug_frost.py`
- Test: `desktop/tests/test_debug_frost.py`（新建）

**Interfaces:**
- `debug_tokens`：`PAPER="#E6E3DA"`、`CARD="#E0DDD2"`、`INDIGO="#343E68"`、`PINE="#38544D"`、`TERRACOTTA="#B94D37"`、`TERRACOTTA_DARK="#8F3A29"`、`MUSTARD="#CCA13D"`、`TEXT_PRIMARY="#2D3662"`、`TEXT_SECONDARY="#355044"`、`PSEUDO_FROST_RGBA=(246,243,235,205)`、`RADIUS=24`、`qss() -> str`（窗口/卡片/按钮/分隔线；不含任何控件类名断言依赖）
- `debug_frost`：`REAL = "real"`、`PSEUDO = "pseudo"`；`probe_env() -> dict`（键 `platform`/`qpa`/`build`/`composition`/`hwnd`/`accent_ok`，全部失败安全）；`decide(env) -> REAL|PSEUDO`（**纯函数**）；`enable_frost(widget, env=None) -> REAL|PSEUDO`（真磨砂：`ctypes` + `SetWindowCompositionAttribute(hwnd, 3, 2, 0x00000000)`；任何异常/非零返回 → PSEUDO）

**启用条件（全真才 REAL）**：`platform=="win32"` ∧ `qpa not in ("offscreen","minimal")` ∧ `19041 <= build < 22000` ∧ `composition is True` ∧ `hwnd` 为真 ∧ `accent_ok is True`。**禁用** `ACRYLICBLURBEHIND(4)`；不得用 `winId()!=0` 或 `QPixmap.isNull()` 判定。

- [ ] **Step 1: 写失败测试**：参数化 `decide` 的 6 个条件各自为假 → PSEUDO；全真 → REAL；`build=22000` 与 `build=19041-1` → PSEUDO。`enable_frost` 在 offscreen 下返回 PSEUDO 且不抛（用一个注入的假 widget 对象，`__getattr__` 抛异常也不许漏出去）。
- [ ] **Step 2: 确认失败**；**Step 3: 实现**；**Step 4: 确认通过**。
- [ ] **Step 5: 记录 token 来源**：文件头注明取自 `wayfinder/debug-window-style-tokens.md` 的角色映射表。

### Task 4: 取数模块（HTTP，无 Qt）

**Files:**
- Create: `desktop/suboverlay/debug_probe.py`
- Test: `desktop/tests/test_debug_probe.py`（新建）

**Interfaces:**
- `class Snapshot: __slots__ = ("ok", "data", "error", "at")`；`ok: bool`，`data: dict|None`，`error: str`，`at: float`
- `fetch_status(port, host="127.0.0.1", timeout=2.0, fetcher=None) -> Snapshot`：默认走 `http.client.HTTPConnection`（**不吃代理环境变量**，与既有测试同思路）；`fetcher` 注入时以其返回值为准（返回 dict → ok；抛异常 → 失败 Snapshot，`error` 为异常类名）。路径 `/status`，端口非法/连不上/超时/JSON 坏 → 失败 Snapshot（`data=None`），**绝不抛**。
- `STATUS_PATH` 复用 `suboverlay.protocol`。

- [ ] **Step 1: 写失败测试**：注入 fetcher（真 loopback 起 `HTTPServer` 一次 + 注入假 fetcher 三种：返回 dict / 抛 `ConnectionRefusedError` / 睡到超时）→ 断言 ok 区分、`data is None` 与 `error` 文案、超时 ≤2s 生效、坏 JSON → 失败。
- [ ] **Step 2-4: 失败→实现→通过**。
- [ ] **Step 5: 端到端口径**：用真 `WSServer(port, queue.Queue(), status_provider=lambda: {"state":"ok"})` 起真服务，`fetch_status(port)` 读回 `state=="ok"` 与 `stats.frames`（证明契约一致）。

### Task 5: 事件记录器（纯逻辑）

**Files:**
- Create: `desktop/suboverlay/debug_events.py`
- Test: `desktop/tests/test_debug_events.py`（新建）

**Interfaces:**
- `KINDS = ("hook_error","capture_error","state","trans_state","fetch","frames_stall")`
- `class EventRecorder:` `__init__(self, opened_at: float, capacity=200, window_s=1800)`
  - `observe(self, snapshot, now) -> list[dict]`：`snapshot` 为 `Snapshot`（Task 4）或 `None`(从未/失败)；只记**翻转**；返回本次新增事件（可能空）
  - `events(self) -> list[dict]`：**最新在上**
  - `opened_label(self) -> str`：`"本页打开于 HH:MM:SS，此前事件未记录"`
  - `clear(self)`：清空留痕（重开窗口/换服务时）
  - 事件结构：`{"at": float, "time": "HH:MM:SS", "rel": int, "kind": str, "text": str}`；`rel` = `int(now - opened_at)`
- 规则：`hook_error`/`capture_error` 空↔非空各记一条；`state`/`trans_state` 值变化各记一条；取数成功↔失败翻转记一条；`frames` 停滞 = 相邻快照 `stats.frames` 零增长且 `state == "ok"`（首次观察不记，恢复增长后可再次触发）。淘汰：**200 条或 30 分钟**，先到者为限。

- [ ] **Step 1: 写失败测试**（全部用显式时间戳驱动，不碰真实时钟）：五类各自翻转记录；**同一状态连续出现只记第一条**；第 201 条淘汰最旧；超 30 分钟淘汰（用 `now` 推进）；`rel` 秒数正确；`opened_label()` 格式；`frames_stall` 仅在 `state=="ok"` 且零增长时记录、恢复增长后再停会再记一条；`clear()` 后 `events()==[]` 且 `opened_label()` 用新时刻。
- [ ] **Step 2-4: 失败→实现→通过**。

### Task 6: 单发自续调度（纯逻辑，无 Qt）

**Files:**
- Create: `desktop/suboverlay/debug_poller.py`
- Test: `desktop/tests/test_debug_poller.py`（新建）

**Interfaces:**
- `class StatusPoller:` `__init__(self, fetch, on_result, schedule, interval=1.0)`
  - `fetch: Callable[[], Snapshot]`（Task 4）、`on_result: Callable[[Snapshot], None]`、`schedule: Callable[[float, Callable[[], None]], None]`（Qt 侧传 `QTimer.singleShot`，测试侧记录并手动触发）
  - `start()` / `stop()` / `set_interval(seconds)`（0.5/1.0/2.0）/ `refresh_now()` / `in_flight` 属性
- 语义：上一拍 `on_result` **返回后**才排下一拍（**永不重入、永不叠加**）；`stop()` 之后不得再 `fetch`；`refresh_now()` 在飞行中只标记「待补一拍」，不并发。

- [ ] **Step 1: 写失败测试**：手动触发 schedule 回调两次 → 只发生一次 `fetch`；`on_result` 之后才排下一拍（记录 schedule 调用次数与延迟）；`set_interval(2.0)` 后下一拍延迟 2.0；`stop()` 后触发残留回调不 `fetch`；`refresh_now()` 在飞行中不并发、结束后补一拍；`fetch` 抛异常 → 走 `on_result(失败 Snapshot)` 且调度继续。
- [ ] **Step 2-4: 失败→实现→通过**。

### Task 7: 调参页（Qt，offscreen 可驱动）

**Files:**
- Create: `desktop/suboverlay/debug_tuning_page.py`
- Test: `desktop/tests/test_debug_tuning_page.py`（新建）

**Interfaces:**
- `class TuningPage(QtWidgets.QWidget): __init__(self, settings, overlay=None, save=None)`
  - `save` 缺省 `S.save`（测试注入抓取替身）；`overlay` 为浮窗替身（测试注入假对象）
  - `set_field_value(path, ui_value)` / `field_value(path) -> ui_value`（测试驱动面，不依赖控件类名）
  - `is_field_enabled(path) -> bool`（`display.order` 在 `mode != "bilingual"` 时 False）
  - `hint_for(path) -> str`（`重启后生效` / `0 = 不描边` / 组内 `未校准` 标注）
  - `ok()` / `cancel()`（按钮信号连到二者）
- 控件映射：`choice -> QComboBox`、`int -> QSpinBox(min,max,step)`、`float -> QDoubleSpinBox`、`color -> 颜色按钮（QColorDialog）`；三组分区标题「显示」「网络与服务」「实验（未校准）」；底部 `确定` / `取消`。
- `ok()`：`collect_edits` → `apply_edits` 到内存 cfg → **`save(cfg)` 一次** → 若改动含 `notify_overlay` 字段则 `overlay.reread_settings()`。
- `cancel()`：丢弃改动（控件值回到 cfg 现值），**不**调用 `save`。

- [ ] **Step 1: 写失败测试**（offscreen；模块级 `os.environ.setdefault("QT_QPA_PLATFORM","offscreen")` + 模块级 QApplication 单例，照抄 `desktop/tests/test_settings_dialog.py` 的写法；`S.save` 用 monkeypatch 抓取）：
  - 控件范围/枚举与 `TUNING_FIELDS` 一致（用 `set_field_value` 越界 → 读回夹取值）。
  - 只写改动的键：改 `prefetch.lead_s` 后按 `确定` → 抓到的 cfg 里 `display.order`/`batch.max_chars` 与改前**逐键相同**；用户手写的越界 `display.font_size=99` 原样保留。
  - `取消` → `save` 未被调用，且 cfg 未变。
  - 改 `display.mode` → 假浮窗 `reread_settings` 调用**恰好一次**；只改 `prefetch.lead_s` → **不**调用。
  - `mode != bilingual` 时 `display.order` 置灰（`is_field_enabled` False）且切回双语后其值仍在。
  - `重启后生效` 出现在 `provider.max_concurrent` 与 `server.port`；实验组三项带未校准标注。
  - **不得**存在 API Key 控件：`page.findChildren(QLineEdit)` 里没有回显 key 的输入（或用 `set_field_value(("provider","api_key"))` 应抛 KeyError）。
- [ ] **Step 2-4: 失败→实现→通过**。

### Task 8: 排障页（Qt，真服务黑盒）

**Files:**
- Create: `desktop/suboverlay/debug_diag_page.py`
- Test: `desktop/tests/test_debug_diag_page.py`（新建）

**Interfaces:**
- `class DiagPage(QtWidgets.QWidget): __init__(self, port, poller=None, recorder=None)`
  - `apply(snapshot) -> None`：`snapshot.ok` → 渲染四分区与状态条；失败 → 状态条转红 + 灰化旧值 + 「上次成功 HH:MM:SS（N 秒前）」
  - `status_bar_text() -> str` / `status_bar_level() -> "ok"|"warn"|"error"`（测试只读这两个，不读 QSS 颜色）
  - `zone_rows(zone) -> list[tuple[str, str]]`（`zone in ("link","playback","queue","events")`）
  - `copy_all_text() -> str`（一行一条，纯文本）
  - `set_frequency(seconds)` / `refresh_now()`
  - 频率档位 `0.5 / 1 / 2`，默认 1；「立即刷新」按钮；「复制全部」按钮
- 分区（顺序固定）：① 连接与帧：服务可达与否 + 端口、`stats.frames`、`stats.bad_frames`、`stats.error`（非空才显示）、`sources`、`active_source`；② 播放与字幕：`state`、`title`、`playing`、`rate`、`mode`、`order`、`orig`、`trans`、`click_through`；③ 翻译队列：`trans_available`、`trans_state`、`connection_test`（**默认折叠**）；④ 事件列表（最新在上，顶部一行 `opened_label()`）。
- **不显示**（状态接口里不存在）：缓存命中率 / 条目数 / DB 大小 / 连接数 / 收帧龄 / 按来源拆帧数 / 排队数与在途数 / 是否退避中。第四块标题就叫「翻译队列」。
- 连续失败 > 10 秒（用注入时钟推进）→ 清空数值区，只留状态条。

- [ ] **Step 1: 写失败测试**：真 `WSServer` + 注入 `status_provider`（返回含 `state/orig/trans/trans_state/trans_available/stats...` 的字典）→ 页面渲染出对应行；`server.stop()` → `status_bar_level()=="error"`、文案含端口与「上次成功」；恢复服务 → 回 `ok`；注入时钟推进 11 秒仍失败 → `zone_rows("playback") == []`；`copy_all_text()` 一行一条且含时间戳；事件列表最新在上、首行含「此前事件未记录」；`set_frequency(0.5)` 传到 poller 替身；`refresh_now()` 触发一次取数；`connection_test` 默认折叠（未展开时不出现在 `copy_all_text()`）。
- [ ] **Step 2-4: 失败→实现→通过**。

### Task 9: 窗口外壳 + 菜单入口 + 装配

**Files:**
- Create: `desktop/suboverlay/debug_window.py`
- Modify: `desktop/app.py`（`_menu()` 新增「调试……」；`App.__init__` 持有 `self.debug_window = None`；新增 `_open_debug_window()`；~~`_menu()` 里加「重读设置」~~ —— 该项 2026-10-03 验收时按维护者裁定删除，见票「浮窗菜单去重」）
- Test: `desktop/tests/test_debug_menu.py`（新建）

**Interfaces:**
- `class DebugWindow(QtWidgets.QWidget): __init__(self, settings, *, port=None, overlay=None, frost_env=None)`
  - 非模态、无父窗口、`Qt.Tool`；`QtWidgets.QWidget` 顶部页切换（调参 / 排障）；`enable_frost(self, env)` 返回 `"real"|"pseudo"`；`current_page_name()` / `show_page("tuning"|"diag")`
  - `port` 缺省取 `settings["server"]["port"]`
- `App._open_debug_window()`：懒建 `DebugWindow(self.settings, port=self.server.port, overlay=self.overlay)`，已存在则 `show()` + `raise_()`（**复用同一实例**，关闭后不重建）；`App` 持有引用避免 GC。
- 菜单新增两项：`调试……`（→ `_open_debug_window`）与 `重读设置`（→ `self.overlay.reread_settings`）。**2026-10-03 更新：`重读设置` 一项后来按维护者验收裁定删除**（它只同步内存里的 display.mode / order，而调参页确定与浮窗自身的 cycle/swap 都已自动重读 —— 见票「浮窗菜单去重」）；`overlay.reread_settings()` 方法本身保留，调参页仍在用它。

- [ ] **Step 1: 写失败测试**：`App` 的菜单（构造 `App()` 需要真实 settings 文件——用 `monkeypatch` 把 `S.load` 指向临时默认配置，照 `desktop/tests/test_app_lifecycle.py` 的既有手法）里存在 `调试……` 与 `重读设置` 两个 action；触发「调试……」后 `app.debug_window` 非空、`isVisible()` 为真、再次触发**仍是同一对象**（`id()` 相同）；触发「重读设置」→ 假浮窗收到调用；offscreen 下 `DebugWindow(...).enable_frost({})` 返回 `"pseudo"` 且不抛。
- [ ] **Step 2-4: 失败→实现→通过**。
- [ ] **Step 5: 手工冒烟（agent 可做）**：offscreen 下构造真实 `DebugWindow` 并把两页各渲染一次到 PNG（写入 `.scratch/wf-session/verify/`），确认无异常、窗口尺寸与原型 A 同量级（1120×760 附近，允许按控件高度自适应）。

### Task 10: 收尾验证与票据同步

- [ ] **Step 1: 全量回归**：`python -m pytest desktop/tests -q`（≥271 + 新增）；`cd userscript && node --test "tests/*.test.mjs"`（= **40 pass**，不得下降）
- [ ] **Step 2: 逐条核对规格**（把结论写进 issue 158 的 resolution 评论）：#161 的 5 条决策 + 15 字段表 + 3 个测试接缝；#162 的 D1~D7 + 4 个分区 + 6 条硬边界（打开后才有留痕 / 不落盘 / frames 停滞判据 / 连不上不显示旧数字 / 只列既有键 / 标题叫翻译队列）
- [ ] **Step 3: 明确记录与规格的偏差**：**排队数 / 在途数 / 是否退避中不显示** —— `/status` 契约里没有这三个键（`docs/PROTOCOL.md:5-7`、`app.py:540-562` 实证），按规格 #162 决策 16 取「不显示」而不是加后端读数；如需显示须先立一张扩契约的票。同一段里说明第二轮候选（若维护者要）是什么。
- [ ] **Step 4: 更新票据**：`gh issue comment 158`（resolution）+ `gh issue edit 158 --body-file`（进度）；地图 #152 的状态追加一句；不自行关闭 158/159（验收票由维护者手测后关闭）。

---

## Self-Review

- **Spec coverage**：#161 的字段表→Task 1/7；保存与生效语义→Task 1/2/7；测试三接缝→Task 1（纯逻辑）、Task 7（窗口，注入 save）、Task 9（替身通知）。#162 的取数/留痕/调度/渲染→Task 4/5/6/8；字段边界与不显示项→Task 8；状态条与灰化→Task 8；菜单入口→Task 9；磨砂与 token→Task 3/9。规格里「不新增 ADR」「不新建接口」→ 本计划无 ADR、无 `/status` 改动。
- **Step scan**：每步一个可判定动作（写测试 / 跑出指定失败 / 实现 / 跑出通过 / 回归）。
- **Type consistency**：`Snapshot` 由 Task 4 定义，Task 5/6/8 消费同一结构；`TUNING_FIELDS` 字段字典键由 Task 1 定义，Task 7 只消费；`reread_settings()` 由 Task 2 定义，Task 7/9 消费。
- **Review Focus**：5 条各有归属（1→Task 1/7；2→Task 7；3→Task 4/8；4→Task 3/9；5→Task 7/9）。
- **Proportion**：本计划不含实现代码体，只钉接口、值、测试断言。
