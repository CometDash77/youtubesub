# 浮窗外观键与透明实时预览：落地实施规格

- 来源：[浮窗外观细调与透明实时预览 map](https://github.com/CometDash77/youtubesub/issues/173)（destination = 只裁决策、交规格，不改生产码）；本文由 [规格落盘 #179](https://github.com/CometDash77/youtubesub/issues/179) 落盘。
- 定案输入：[外观键定案 #174](https://github.com/CometDash77/youtubesub/issues/174) / [共用绘制器定案 #175](https://github.com/CometDash77/youtubesub/issues/175) / [透明实时预览定案 #176](https://github.com/CometDash77/youtubesub/issues/176) / [取色与字体选择的交互定案 #177](https://github.com/CometDash77/youtubesub/issues/177) / [截图证据 #178](https://github.com/CometDash77/youtubesub/issues/178)——决议全文在各票 Answer 区，本文只引用不重裁。
- 地位：`desktop/suboverlay/settings.py` 解冻后，落地 effort 以 **本文 + [wayfinder/overlay-appearance-keys.md](../../wayfinder/overlay-appearance-keys.md)** 为唯一施工依据，不必重读五张票。
- 日期：2026-10-06。

## 0. 目标与边界

给浮窗新增 6 个外观键（字体族 1 + 颜色 4 + 预览字号 1），把浮窗绘制与设置界面实时预览接成**同一条绘制路径**（预览画在 PS 式透明棋盘格上，所见即所得），并给出验收判据。**本文不含改码**：实现落到 settings 解冻后的独立 effort。六项已锁取舍（不得在落地时重裁）：①只交规格不落地；②「外填充/内填充」= 描边色/字身色，不是双层底板；③字体族全局 1 键、颜色原文/译文分开；④抽共用绘制器、预览底为透明棋盘格；⑤预览在「调参 → 显示」组顶部、画当前 cue 的行；⑥新增 6 键、颜色无 alpha、回退式兼容不动 `default_settings()`。

## 1. 外观键表

**唯一权威 = [wayfinder/overlay-appearance-keys.md](../../wayfinder/overlay-appearance-keys.md)**：6 键的路径 / label / control / 默认 / 区间 / notify_overlay / restart / hint 全文、颜色存储格式（三元素 int list，无 alpha）、kind `font` 的形状校验规则（非空 str 直通否则回退默认；缺了它 `stored_value` 会把字体名写成 null）、比较语义两条断言、`load()` / `default_settings()` 口径（不动 defaults、缺键回退今天硬编码值、不强制迁移）、键 ↔ 硬编码映射表、`display.stroke` hint 改写与两条 `startswith` 断言。落地时以该文件为准。要点摘录：

- `TUNING_FIELDS` 插在 `("display", "bg_opacity")` 之后，16 → 22 条，`TUNING_FIELDS[0] == ("display", "font_size")` 不动（`desktop/tests/test_debug_tuning_page.py:144-150` 钉着）。
- 6 键全进表：不进 = 调参页无控件 + `apply_edits` 对表外键 `raise KeyError`（`desktop/suboverlay/settings.py:248`）= 功能死掉。
- `preview_font_size` 的 `notify_overlay=False` 是刻意的（浮窗不读它）。
- 一致性护栏断言（只覆盖 6 新键）：表 `default` == `DEFAULT_STYLE` == 页面初始值。既有 `font_size`（回退 15 / 表 10）与 `stroke`（回退 2.0 / 表 1.5）历史字面量不在范围，别顺手改。

## 2. 共用绘制器：新模块 desktop/suboverlay/overlay_paint.py

### 2.1 模块约束与常量

- 只依赖 `QtGui` / `QtCore`，**不 import `QtWidgets`、不 import `settings`**（`settings.py` 同时保持 Qt-free，只 import `json` / `os` / `shutil`）。理由：预览画布住在调参页，让它 import 整份窗口代码（`ctypes` / `WS_EX_TRANSPARENT` / settings 依赖）是白白扩大依赖面。
- 模块常量：`CONTENT_MARGIN = 14`（内容区内缩，今天 `overlay.py:122` 的 margin）、`BOX_INSET = 4`（圆角底板外缩，`:117` 的 `adjusted(4,4,-4,-4)`）、`BOX_RADIUS = 10`（`:120` 圆角半径）、`FAILED_TEXT_COLOR = (255, 90, 90)`（失败态红 `#FF5A5A`，既有契约）、`DEFAULT_STYLE = {...}`（10 个外观键的缺省值 = 今天硬编码值，含 `bg_color` / `bg_opacity` / `font_size` / `font_bold` / `stroke` 等 display 键的绘制层缺省）。

### 2.2 函数签名（全部无状态，不读 `self`）

```python
def content_area(rect) -> QtCore.QRect   # rect.adjusted(14,14,-14,-14)，模块导出供测试与状态行共用
def translation_status_text(state) -> str   # 原 _translation_status_text
def labelled(role, text) -> str   # 原 _labelled
def rows_for(mode, order, orig_text, trans_text, trans_state, trans_available) -> list[tuple[str, str, bool]]   # 原 _display_rows，第三槽 failed
def draw_divider(painter, area, y) -> float   # 原 _draw_divider
def draw_wrapped(painter, font, text, area, y, color, stroke_color, stroke_w) -> float   # 原 _draw_wrapped + 逐行描边色
def paint_subtitles(painter, rect, rows, style) -> None   # 新绘制内核
```

- `style` 是映射（直接传 `display` 那份 dict 或页面合并出的同形状 dict），取键一律 `style.get(key, DEFAULT_STYLE[key])`——回退式兼容在绘制层的落点；**不引入值对象**。
- `rows` 第三槽 `failed`：行模型宣告该行承载译文失败态文案，绘制器据此选色（`failed=True` 仅出现在 `trans` 行 + `trans_state.startswith("failed:")`；等待 / 翻译中 / 未配置占位行是 `False`）。`rows_for` 与旧 `_display_rows` 逐例等价（12 例矩阵 0 不一致）。
- `draw_wrapped` 必须收**逐行** `stroke_color`（今天 `overlay.py:261` 写死黑）：失败行与正常行的唯一差别是字身色，描边从不分状态。不需要 `max_width` 形参——折行是 `area` 的纯函数（两个尺寸不同的窗口用同一 area 渲染逐字节相同）。

### 2.3 paintEvent 拆分边界

**进共用绘制器**（对着今天行号）：底板圆角矩形 + 两条 render hint（`overlay.py:113-120`）；内容区与剪裁（`:122-123`、`:128`）；逐行字号（译文 ×1.25）/ 加粗 / 字色 / 描边色 + 折行 + `QPainterPath` 描边填充（`:132-147`、`:226-280`）；双语分隔线（`:148-151`、`:218-224`）。**两条 render hint 必须归绘制器**——不设 hint 时同一段绘制差 2528 像素（探针实测），留在调用方等于给「两份实现」留后门。

**留在窗口里**：状态行（`:153-158`，诊断不是外观，按 `self.height()-22` 定位）——**这是预览与真浮窗唯一被允许的差异**（非空时两图差异 1064 像素全部落在底部 24px 带内）；窗口几何 / 拖拽 / 缩放 / 点击穿透（`:283-380`）；rows 的来源（`self.history` / `self.orig_text` / `self.trans_state` / `trans_available` 仍住窗口，被抽走的是「状态 → 画什么」的纯函数）。

`OverlayWindow.paintEvent` 收成三步：取 rows → 调 `paint_subtitles` → 画状态行；模块顶部 `from .overlay_paint import (CONTENT_MARGIN, content_area, paint_subtitles, rows_for)`。

### 2.4 DEFAULT_STYLE 与默认观感的辨析（写清，别混）

- `DEFAULT_STYLE` 服务「缺键的旧配置回退」，不是「默认观感」：表 `display.font_size` default=10 而 `overlay.py:133` 回退 15；`stroke` 表 1.5 而回退 2.0——这两个既有键的「表 default == overlay 常量」从来没成立过，用户看到的默认观感以表 default 为准。
- 新增 6 键上这条对齐成立：`preview_font_size` default 10 == `display.font_size` default 10，「默认配置下预览即真浮窗观感」在字号项上成立。

### 2.5 overlay.py 变更面

- `:32`（注释里的 `_display_rows`）、`:110-159`（`paintEvent` 收窄 + 删 5 个方法）、`:161-280`（搬走 `content_area` 等价逻辑与 `_display_rows` / `_translation_status_text` / `_labelled` / `_draw_divider` / `_draw_wrapped`）；新增只读「当前 cue 行」访问器供预览用（包装 `rows_for` 的输入采集）。
- **桩必须改挂模块**：`paintEvent` 以后调模块函数，`w._draw_wrapped = stub` 截不住；测试用 `monkeypatch.setattr(overlay_paint, "draw_wrapped", stub)` 并同步桩签名（多一个 `stroke_color`）。**不要**为保老桩在窗口里留转发方法——那是第二份签名，违反「一个函数」不变量。

## 3. 预览画布（debug_tuning_page.py）

**一句话**：预览 = 「调参 → 显示」组顶部的一块画布 widget（页面自己的 widget，**不是 `TUNING_FIELDS` 行**），调 `paint_subtitles` 把**当前 cue 的行**按 live style 画进按 `(宽, 高, DPR)` 缓存的 `QImage`，贴在画布空间的棋盘格 tile 上；全程不写 `settings`、不动浮窗、不画状态行。

### 3.1 位置与几何

- 排在「显示」组顶部：组内阅读序 = 预览画布 → 既有 8 条（`font_size` / `mode` / `order` / `history_lines` / `font_bold` / `stroke` / `bg_color` / `bg_opacity`）→ 新 6 条（表序即页序，`_group_card` 行序 = 表序）。
- 渲染范围 = **整窗 rect**（含底板与内边距，口径同 `desktop/tests/test_overlay_labels.py:217` 的离屏 `w.render(painter, QPoint())`）；**不画状态行**，画布高 = 真浮窗高 − 24px 状态行带。
- 缩放策略：`canvas_w ≥ 图宽` → **1:1 不重采样**；`canvas_w < 图宽` → `k = canvas_w / 图宽` 整体缩放，**下限 0.5**；触底仍放不下 → 退回「1:1 渲染 + 裁剪 + 拖动」。非 1:1 时画布角上显示缩放读数（如「缩放 62%」）。淘汰「固定 800×200 装框」——rect ≠ 真浮窗 rect 则折行必然不同（内容区宽 622 → 4 行 / 772 → 3 行），正面违背等同性。

### 3.2 棋盘格

- **固定贴图**，画布空间：格子边长按**逻辑像素**定（#178 观感结论 12px 够像 PS），物理边 `round(边长 × DPR)`；只在 **DPR 或画布尺寸变化**时重建一张可平铺 `QPixmap` tile，**缩放不触发棋盘重绘**（否则格边落半物理像素 → 发灰、摩尔纹）。
- 离屏图不含棋盘：那张图的定义是浮窗像素（含底板 alpha）；圆角外的透明由棋盘透出来。棋盘是容器的装饰（PS 口径「这里没有东西」）。

### 3.3 帧策略与信号

- 每帧重跑 `rows_for` + `paint_subtitles`（**布局不缓存**），结果写进按 `(宽, 高, DPR)` 缓存的 `QImage`（仅尺寸 / DPR 变化时重建）；预览 widget 只 `update()` 自身区域，**不整页重排**（矮屏画布在 `QScrollArea`，`desktop/suboverlay/debug_window.py:347`）。
- **不限频**：不加 `QTimer` 节流、不做「松开滑条才画」，靠 Qt update 合并（既有先例：拖边缩放 `overlay.py:340-357`）。保真承诺比帧率值钱；缓存布局（脏标记）留给日后真掉帧时再加。
- **新信号 `field_edited(path)`**：预览不走页脚的 `changed`（`debug_tuning_page.py:210-211` 只 `emit()`，页脚收到会对 22 字段跑 `collect_edits()` 全表 diff）；拖滑条只发带 path 的新信号直连画布局部重绘。测试靶点：拖滑条**不**触发页脚 `changed` / `collect_edits()`。

### 3.4 浮窗跟变与取消语义

- 浮窗本体**不跟变**：仍只在保存后对 `notify_overlay` 字段重读（`desktop/suboverlay/debug_window.py:224-226` 不变）。预览走 live style「即取即画、不改 settings」——与保存的原子写盘（`settings.save`）、取消的丢弃语义（`debug_window.py:230-234` 两页各自 `cancel()` 回 snapshot）**零冲突**，没有要回滚的东西。

### 3.5 文本来源与回退

- 只画**当前 cue** 的行：`rows_for(mode, order, 当前 orig, 当前 trans, trans_state, trans_available)`——bilingual 天然是「译/原两行 + 分隔线」。浮窗从来不显示上一句/下一句（`overlay.py:161-190` 只读当前 cue；`history` 只喂 `/status`；payload 无未来 cue）；「上一句/下一句」一词归提示词预览（`settings_page.py:25-28`）。
- 来源 = `DebugWindow` 持有的浮窗实例（`self.overlay`，`desktop/suboverlay/debug_window.py:161`）；需给 `OverlayWindow` 加**只读**的当前 cue 行访问器（今天只有私有 `_display_rows`）。预览**不调用** `reread_settings`、不触发浮窗 `update()`。
- 回退口径：浮窗未运行 / 未在显示 / 当前 cue 为空 → 回退示例文本，**示例必须同时覆盖双语两行**（否则演示不出布局与分隔线）。

### 3.6 示例画面开关

- 默认关的「垫一张示例画面」开关：打开时在浮窗图**下面**垫示意画面，判「字压在亮/暗画面上够不够清楚」——棋盘永远看不出这件事，而浮窗又不跟变，这是看该场景的唯一入口。
- 示例画面**用代码合成**（深底 + 亮区 + 中灰条）：不引二进制资源、可断言、可离线渲染。开关**不进 `settings`**（键表锁死 6 键，不加第 7 键），只在窗口会话内记忆（关窗即忘）。测试靶点：开关关/开两态像素不同。

## 4. 页面交互（四色 + 字体）

| 键 | 控件 | 交互 |
|---|---|---|
| `display.font_family` | 非可编辑 `ComboBox`（kind `font`，页面侧渲染） | 下拉选族名；列表 = 页面侧 `QFontDatabase.families()` 现取 |
| 4 个色键 | 既有 `color` kind：`PushButton` 显示 `#RRGGBB` + `QColorDialog` | 与 `bg_color` 完全同构 |
| `display.preview_font_size` | 既有 `int` SpinBox | 键表已定 |

- **摆放顺序 = 表序即页序**，六键插 `bg_opacity` 之后：字体族 → 原文字色 → 原文描边色 → 译文字色 → 译文描边色 → 预览字号；语言对内部「字色 → 描边色」相邻。不做「预览字号跳到画布正下方」的行插队（表序是页面自描述的根基）。
- **不引入 Fluent 取色组件**：同一张卡里底板走 Qt 取色器、字色再走一套 = 「一份语义两套交互」，与「同一机制」精神相反；ADR-012 接受的取色现状就是 `QColorDialog`。
- **取色器标题按字段传**：`_pick_color_for`（`debug_tuning_page.py:281-286`）硬编码「选择背景色」改为按 label 传（`f"选择{label}"`），`bg_color` 一并统一；`_pick_color` 注入缝签名 `(title, current)` 不动（`test_debug_tuning_page.py:193` 钉着）。
- **字体下拉构造**：`sorted(families(), key=str.lower)` 确定性排序；`writingSystems(family)` 含 `SimplifiedChinese` 的族 label 追加「· 中文」（userData 永远纯族名，徽标只活在下拉文案）；填充列表后若当前 `font_family` 不在列表里，**追加保值行**：label =「族名（未在系统中找到）」，userData = 族名本身，并保持选中——保证默认配置在任何环境（含 offscreen / 精简系统）都显示「Microsoft YaHei UI」而不被静默换成列表第一项。页面测试在 offscreen + `QT_QPA_FONTDIR` 下可复现（默认值显示保值行；SimHei 行带徽标）。
- **缺字体回退**：渲染侧就是 Qt 现状（`QFont("不存在的名字")` 静默替换，浮窗零新增分支）；反馈面 = 保值行标记，仅此一处，不弹窗。**不落盘清洗、不迁移**：配置只存用户意愿，且清洗要求 `settings.py` 认识 Qt、破坏 Qt-free 接缝。
- **失败态红共存**：失败行（`trans_state` 以 `"failed:"` 开头，`overlay.py:142-143`）继续硬编码 `QColor(255, 90, 90)` = `#FF5A5A`，用户色只管正常行；其余全部译文行吃 `trans_text_color` **含状态占位行**（等待 / 翻译中 / 未配置，`overlay.py:175-177`）；orig-role 占位行（`overlay.py:180-181`）吃 `orig_text_color`；失败行描边照常吃 `trans_stroke_color`。
- **默认值可见性 = 写进 hint**（全文见键表），**不做预设、不做每键「改回默认」钮、不做组级恢复钮**（#178 实测每键重置钮拥挤；`config.json` 删键 = 回默认已是零成本逃生门，实时预览把试错成本压到一次点击）。

## 5. 配图证据（#178 产物，给维护者肉眼复核）

- [docs/assets/wayfinder/issue-178/01-concept.png](../assets/wayfinder/issue-178/01-concept.png) — 概念图：棋盘格 + 底板 + 双语行的整体观感。
- [docs/assets/wayfinder/issue-178/02-opacity-matrix.png](../assets/wayfinder/issue-178/02-opacity-matrix.png) — `bg_opacity` 四档（255/180/90/40）矩阵；`bg_opacity ≤ 90` 时译文 #FFE082 在亮底上发糊、黑描边是主要依靠。
- [docs/assets/wayfinder/issue-178/03-tuning-display-group.png](../assets/wayfinder/issue-178/03-tuning-display-group.png) — 新版「显示」组整页：预览画布 + 8 条 + 拟议 6 条。
- 生成器 `.scratch/wayfinder/issue-178/render.py`（浮窗孅图出自真产码 `OverlayWindow` 离屏 ARGB `grab()`，尺寸取真实值 295×171 / 预览画布 295×143）。

## 6. 落地前置与解冻清单

### 6.1 解冻信号

- `desktop/suboverlay/settings.py` 的 schema 冻结（来自 [设置调试合并 map #164](https://github.com/CometDash77/youtubesub/issues/164)）已随 [落地：合并窗口 + 整窗说人话文案 #170](https://github.com/CometDash77/youtubesub/issues/170) 落地关闭（2026-10-06 03:54，`python -m pytest desktop/tests -q` = 363 passed）而**解除**。**⚠ #170 的工作区改动尚未提交——落地 effort 起手前先确认其已入库**，否则规格对着的工作树不是干净的基线。

### 6.2 与 #170 冲突的文件清单（本规格将改动的四个文件，全部是 #170 刚改过的）

`desktop/suboverlay/settings.py`（新增 6 条 `_tune` + kind `font` 两处形状校验分支 + `stroke` hint 改写；不改 `load()` / `apply_edits` / `default_settings()` 结构）、`desktop/suboverlay/overlay.py`（`paintEvent` 收窄 + 抽走绘制内核 + 只读访问器）、`desktop/suboverlay/debug_tuning_page.py`（4 处 `font` 分派点 + 预览画布 + `field_edited` 信号 + 取色标题）、`desktop/suboverlay/settings_page.py`（仅当取色标题统一波及——本规格不改提示词预览本身）。另新增 `desktop/suboverlay/overlay_paint.py`。

### 6.3 必须改写的既有断言（逐条）

- `desktop/tests/test_tuning_fields.py:13`（注释里的 16）、`:15-23` + `:39`（`SPEC_PATHS` 16 → 22，插入位置见键表）、`:147-162`（notify 集合 display 7 → 12，**不含** `preview_font_size`）、`:173`（`startswith("给字加一圈黑边")` → `"给字加一圈描边"`）。
- `desktop/tests/test_debug_tuning_page.py:98-103`（字段数）、`:206`（同上 startswith）。
- `desktop/tests/test_overlay_labels.py:154-165`：失败那格保持 `#ff5a5a`，其余三态（waiting / translating / unconfigured）改为随注入的 `trans_text_color` 取值；`:220-222` 与 `:240-242` 的 `_draw_wrapped` 调用改为 `overlay_paint.draw_wrapped(painter, font, text, area, area.top(), color, stroke_color, stroke_w)`。
- `desktop/tests/test_overlay_labels.py` 其余桩点：`:34` / `:35` 桩挂点、`:49` / `:54` 桩签名、`:68` / `:143` / `:197` / `:207` 的 `paintEvent(None)` 调用。

## 7. 新增断言汇总（契约测试靶点）

1. **同一性（根断言，防「两份常量」）**：`overlay.paint_subtitles is overlay_paint.paint_subtitles`，且 `debug_tuning_page.paint_subtitles is overlay_paint.paint_subtitles`（范式：`test_settings_page.py:248-282` 的 `test_preview_is_byte_identical_to_the_production_assembly`）。
2. **产物字节相同（同 rect）**：`w.status_text = ""` 下，真浮窗离屏渲染与 `paint_subtitles(QPainter(同尺寸 QImage), w.rect(), rows_for(...), dict(w.settings["display"]))` 两图逐字节相同（10 场景已探针全等：双语两行齐 / 译文失败态 / 等待态 / trans 回退原文 / orig 模式 / `orig_first` / 半透明底板 40 / 字号 22 + 描边 0 / 长中文折行 / 窄画布 300×60）。
3. **负向边界**：`status_text` 非空时两图必须**不等**，且差异像素全部落在 `y >= height - 24`。
4. **一致性**：表 `default` == `DEFAULT_STYLE` == 页面初始值（只覆盖 6 新键），落 `test_tuning_fields.py`。
5. **颜色别名与越界**：UI 副本与 cfg 不共享 list；未编辑的越界色值原样保留。
6. **kind font 往返**：`font_family` 字符串往返不经过 `float()`；空 / 非串值回退默认。
7. **预览画布**：k=1 时预览图与真浮窗离屏图逐字节相同（状态行带除外）；k<1 输出尺寸 = `round(图宽 × k)`、下限 0.5、触底裁剪+拖动；示例画面关/开两态像素不同；拖滑条不触发页脚 `changed` / `collect_edits()`。
8. **预览 == 生产同一函数**（既有不变量的同款写法，`settings_page.py:307-311` 先例）。

## 8. 验收判据草案（沿用 docs/MANUAL-ACCEPTANCE.md 范式）

### 8.1 自动基线（L0，先跑）

```
python -m pytest desktop/tests -q    # 期望全绿（363 passed 基线 + 本规格新增断言）；0 failed / 0 skipped
```

### 8.2 像素等同契约（机器可验，第 7 节全部）

通过标准：第 7 节 1-8 全部成立。任何一条失败 = 落地没成，不许靠改断言凑绿。

### 8.3 手测清单（维护者本人）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 打开设置与调试 → 调参 → 显示 | 预览画布在组顶部，棋盘格 + 当前 cue 双语行（或回退示例文本，双语两行齐） |
| 2 | 拖「底板浓淡」滑条 | 预览**立即**变（不等保存）；页脚脏计数与 `collect_edits` 不被每帧触发；浮窗本体不变 |
| 3 | 改「译文字色」 | 预览立即变色；保存后浮窗即时生效（`notify_overlay`）；失败行仍恒红 #FF5A5A |
| 4 | 改「浮窗字体」为某中文族 | 下拉带「· 中文」徽标；预览与浮窗同字体；系统里没有的族走 Qt 替换 + 保值行显示 |
| 5 | 保存 → 重开窗口 | 新值回显（写盘生效）；老配置文件（无新键）打开 = 今天观感 + 表默认值显示 |
| 6 | 取消改动 | 预览与浮窗都回到打开时状态，不写盘 |
| 7 | 「垫一张示例画面」开关 | 默认关；打开后浮窗图下垫出深底+亮区示意画面；关窗后不记忆 |
| 8 | 浮窗拖边放大 / 缩小 | 预览画布按 1:1 / 缩放 / 裁剪+拖动策略跟随，缩放读数出现 |
| 9 | 对照 [03-tuning-display-group.png](../assets/wayfinder/issue-178/03-tuning-display-group.png) | 页面结构与拟议版一致 |

失败时记什么：操作步骤、截图、`/status` 原文、控制台 `[youtubesub]` 行。

## 9. Out of scope（本规格不裁、落地别顺手做）

- 状态行样式与 `DIVIDER_RGBA`（不进外观键）；提示词预览改动（`settings_page.py`）；`experimental` 组校准；失败态红的废立（既有契约只共存不推翻）。
- map 剩余迷雾（挂键表落地之后才看得清，落地 effort 完成后另议）：浮窗右键菜单是否补「外观」快捷项；`Font ±` / `Opacity ±` 快捷方式在新键族下的定位（保留 / 改名 / 扩子菜单）。
