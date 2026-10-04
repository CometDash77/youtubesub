"""视觉 token：调试窗口的色板与窗口底色配方。

唯一来源 = `wayfinder/debug-window-style-tokens.md` 的「角色映射」表（用户裁定：
奶油纸底 + 靛蓝主调 + 松绿次调 + 赭红危险 + 芥末黄高亮）。本模块只做映射，
且按该文档第四节**不得**用到调试窗口以外的界面。
"""
from PySide6 import QtCore, QtWidgets

# 从风格图提取的原色（未调色）
PAPER = "#E6E3DA"
CARD = "#E0DDD2"
INDIGO = "#343E68"
PINE = "#38544D"
TERRACOTTA = "#B94D37"
MUSTARD = "#CCA13D"

# 角色取值
TEXT_PRIMARY = "#2D3662"      # 主文字（靛蓝深一档）
TEXT_SECONDARY = "#355044"    # 次文字 / 辅助说明（松绿深一档）
TERRACOTTA_DARK = "#8F3A29"   # 正文级错误文字（3.92:1 不够，用加深档）
BORDER = "#C9C4B6"            # 分隔线与描边：纸底上肉眼可见的柔和档，不用纯灰

# 状态徽标（松绿 = 正常 / 芥末黄 = 注意 / 赭红 = 错误）
OK = PINE
WARN = MUSTARD
ERROR = TERRACOTTA

# 窗口底色：**不透明**奶油底。外层不做透明/磨砂（用户 2026-10-03 裁定：「透明毛玻璃
# 效果没有必要」），视觉结构交给内层卡片。配方 = 奶油底 + 24 圆角 + 1px 内描边 + 48px 柔阴影。
WINDOW_RGBA = (246, 243, 235, 255)
WINDOW_STROKE_RGBA = (255, 255, 255, 110)
RADIUS = 24
SHADOW_BLUR = 48

# 主按钮的悬停/按下档：从靛蓝主调各提亮/压暗一档（token 文档只钉了静态色）
INDIGO_HOVER = "#3F4B7D"
INDIGO_PRESSED = "#2A3355"


def primary_button_qss():
    """主按钮（确定 / 立即刷新）的靛蓝配色。

    **必须设在按钮自身**：Fluent 按钮自带 widget 级样式表，窗口级 QSS 赢不过它
    （实测：窗口级 `QPushButton#debugPrimary` 被库的 teal 主题色盖掉）。追加而不是
    覆盖，并把 hover / pressed / disabled 一起钉住，免得悬停时跳回库主题色。"""
    return f"""
PushButton, PrimaryPushButton {{ color: {PAPER}; background: {INDIGO};
    border: 1px solid {INDIGO}; border-radius: 6px; padding: 6px 18px; }}
PushButton:hover, PrimaryPushButton:hover {{ background: {INDIGO_HOVER};
    border: 1px solid {INDIGO_HOVER}; }}
PushButton:pressed, PrimaryPushButton:pressed {{ background: {INDIGO_PRESSED};
    border: 1px solid {INDIGO_PRESSED}; }}
PushButton:disabled, PrimaryPushButton:disabled {{ color: {TEXT_SECONDARY};
    background: {BORDER}; border: 1px solid {BORDER}; }}
"""


def apply_primary_button(button):
    """Recolour a Fluent push button without touching the global theme."""
    button.setStyleSheet(button.styleSheet() + primary_button_qss())
    return button


def card_frame(parent=None):
    """分组卡片：一个由 `qss()` 的 `QFrame#debugCard` 全权定型的 QFrame。

    **别用库的 `CardWidget`**：它自己 `paintEvent` 画背景（实测库主题色 #F5F4F0），
    盖住 QSS 与 token —— 卡片就会跟不透明窗底（#F6F3EB）几乎同色，等于没有卡片。
    `WA_StyledBackground` 是让 QSS 背景真正画出来的开关（无边框 QFrame 默认不画）。"""
    frame = QtWidgets.QFrame(parent)
    frame.setObjectName("debugCard")
    frame.setAttribute(QtCore.Qt.WA_StyledBackground, True)
    return frame


def qss():
    """窗口与卡片的样式表。芥末黄只作填充，永不承字（对比度 1.87:1）。

    每条规则都有消费者（`debug_window` / `debug_tuning_page` / `debug_diag_page`）：
    状态条用徽标三级；正文值 debugValue；次要说明 debugHint；过期值 debugStale；
    错误值 debugError。主按钮另走 `primary_button_qss()`（必须设在按钮自身）。"""
    return f"""
QWidget#debugWindow {{ background: transparent; }}
QFrame#debugCard {{ background: {CARD}; border: 1px solid {BORDER}; border-radius: 12px; }}
QLabel#debugTitle {{ color: {TEXT_PRIMARY}; font-size: 15px; font-weight: bold; }}
QLabel#debugSection {{ color: {TEXT_PRIMARY}; font-weight: bold; }}
QLabel#debugValue {{ color: {TEXT_PRIMARY}; }}
QLabel#debugHint {{ color: {TEXT_SECONDARY}; }}
QLabel#debugStale {{ color: {TEXT_SECONDARY}; }}
QLabel#debugError {{ color: {TERRACOTTA_DARK}; }}
QLabel#debugBadgeOk {{ color: white; background: {OK}; border-radius: 7px; padding: 1px 8px; }}
QLabel#debugBadgeWarn {{ color: {TEXT_PRIMARY}; background: {WARN}; border-radius: 7px; padding: 1px 8px; }}
QLabel#debugBadgeError {{ color: white; background: {ERROR}; border-radius: 7px; padding: 1px 8px; }}
"""
