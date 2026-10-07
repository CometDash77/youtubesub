# 浮窗外观键表（浮窗外观细调与透明实时预览 map）

来源：[外观键定案 #174](https://github.com/CometDash77/youtubesub/issues/174) Answer 区定案；hint 全文含 [取色与字体选择的交互定案 #177](https://github.com/CometDash77/youtubesub/issues/177) 追加的默认值段。**本文件是外观键族的唯一权威**（同 `wayfinder/debug-window-style-tokens.md` 的地位）；实现规格见 [docs/plans/2026-10-06-overlay-appearance-implementation-plan.md](../docs/plans/2026-10-06-overlay-appearance-implementation-plan.md)。

## 一、6 个新键（全部 display.*，全部进 TUNING_FIELDS）

插入位置：`("display", "bg_opacity")` 之后，表 16 → 22 条；`TUNING_FIELDS[0] == ("display", "font_size")` 与老 16 条相对顺序不动。表序即页序（调参页「显示」组内顺序）。

| # | 键路径 | label | control | 默认值 | 区间 / 步进 | notify_overlay | restart | hint 全文 |
|---|---|---|---|---|---|---|---|---|
| 1 | `display.font_family` | 浮窗字体 | `font`（新种类） | `"Microsoft YaHei UI"` | 无区间 | True | False | 浮窗里用哪套字体；系统里没有的会自动换一套相近的；默认 Microsoft YaHei UI |
| 2 | `display.orig_text_color` | 原文字色 | `color` | `[255, 255, 255]` | 0..255 | True | False | 原文那几行字是什么颜色；默认 #FFFFFF |
| 3 | `display.orig_stroke_color` | 原文描边色 | `color` | `[0, 0, 0]` | 0..255 | True | False | 外面那圈边的颜色（描边宽度为 0 时看不到）；默认 #000000 |
| 4 | `display.trans_text_color` | 译文字色 | `color` | `[255, 224, 130]` | 0..255 | True | False | 译文那几行字是什么颜色；翻译失败时仍显示红色；默认 #FFE082 |
| 5 | `display.trans_stroke_color` | 译文描边色 | `color` | `[0, 0, 0]` | 0..255 | True | False | 外面那圈边的颜色（描边宽度为 0 时看不到）；默认 #000000 |
| 6 | `display.preview_font_size` | 预览字号 | `int` | `10` | 6..40 / step 1 | **False**（刻意） | False | 预览里的字多大；只影响预览，不动浮窗 |

`restart` / `uncalibrated` / `unit` / `scale` 全取 `_tune` 默认（False / False / `""` / 1）；`font` 与 `color` 都不设 `choices` / `labels`。`preview_font_size` 的 `notify_overlay=False` 是刻意的：浮窗不读它，预览刷新走 `field_edited(path)` 新信号。

## 二、存储格式与比较语义

- **颜色 = 三元素 int list（RGB，无 alpha）**：与既有 `display.bg_color` 同形，`_clamp_channels`（`desktop/suboverlay/settings.py:184-193`）与取色器（red/green/blue 三通道）直接可用；alpha 不进键，底板浓淡仍由 `display.bg_opacity` 表达。
- **比较语义零新代码，但要求两条断言**（挡「把 cfg 的 list 直接交给控件」的别名回归）：
  1. `tuning_ui_state` 产出的 UI 副本与 cfg **不共享同一 list**（`display_value` 每次返回新 list，`settings.py:196-208`）；
  2. 未被编辑的越界色值原样保留（值相等不算脏，不写回、不 clamp 进盘）。
- **kind `font` 必须新增形状校验分支**（不改就写坏配置的探针实证）：`display_value` / `stored_value` 对非 `choice` / `color` 种类走数字路径（`settings.py:205-206`、`:218-220`），字符串会被整份丢掉、`stored_value` 返回 `None`（保存写成 null）。校验规则：**非空 str（`.strip()` 非空）原值直通，否则回退 `field["default"]`**；不改写用户输入（不去空白、不做别名匹配）。`settings.py` 保持 Qt-free，字体列表由页面用 `QFontDatabase.families()` 现取。

## 三、回退式兼容（load 与 default_settings 的口径）

- **`default_settings()` 不动**：不新增这 6 键。
- **`load()` 语义不变**（默认值 + 文件一层 merge，`settings.py:267-287`）：老配置缺新键 = 正常状态——浮窗用 `disp.get(key, 硬编码常量)` 回退到今天的观感，调参页显示表默认值；保存时只有真被编辑过的项写盘（`collect_edits` 值相等不算改），老配置不被顺手升级。
- **一致性护栏（落地必须补断言，只覆盖新增 6 键）**：表 `default` == 绘制器 `DEFAULT_STYLE` == 页面初始值。既有 `font_size`（回退 15 / 表默认 10）与 `stroke`（回退 2.0 / 表默认 1.5）的历史字面量**不在本键表范围，别顺手改**（改了会动现有行为）。

## 四、键 ↔ 今天写死在哪（落地映射表）

| 键 | 今天写死的点 | 读法 |
|---|---|---|
| `display.font_family` | `desktop/suboverlay/overlay.py:136` `QtGui.QFont("Microsoft YaHei UI", int(size))` | 行循环里逐帧现读 |
| `display.orig_text_color` | `overlay.py:141` `QColor(255, 255, 255)` | 只有 role `orig` 的行（含 trans 模式回退原文的占位行，`overlay.py:180-181`） |
| `display.trans_text_color` | `overlay.py:145` `QColor(255, 224, 130)` | role `trans` 的行，**含状态占位行**（等待 / 翻译中 / 未配置，`overlay.py:175-177`）；**失败行除外**（恒 `#FF5A5A`，`overlay.py:142-143`） |
| `display.orig_stroke_color` / `display.trans_stroke_color` | `overlay.py:261` `QPen(QColor(0, 0, 0), stroke_w, …)` | 描边笔，逐行取色；`display.stroke` = 0 时无描边（`overlay.py:268` 的 `if stroke_w > 0:`），色键此时无观感 |
| `display.preview_font_size` | 新增（预览画布专用） | 预览绘制时现读 |

**不进键表的**：状态行（`Consolas 9` + 灰 `(160,160,160)`，`overlay.py:153-158`）、分割线常量 `DIVIDER_RGBA`（`overlay.py:148-151` / `:218-224`）、底板（仍是 `bg_color` + `bg_opacity`）、失败态红 `#FF5A5A`（既有契约 `desktop/tests/test_overlay_labels.py:154-165`）。

## 五、连带改写

- `display.stroke` 的 hint（`settings.py:117-119`）在描边色可调后改为中性文案：**「给字加一圈描边，压在亮画面上也看得清；颜色在「原文描边色 / 译文描边色」里调；0 = 不描边」**（#177 定案）；同步两条断言 `desktop/tests/test_tuning_fields.py:173` 与 `desktop/tests/test_debug_tuning_page.py:206` 的 `startswith("给字加一圈黑边")` 改为 `startswith("给字加一圈描边")`。
- 术语：见 `CONTEXT.md`「浮窗外观键」块（译文状态占位行算「正常行」，吃 `trans_text_color`）。
