"""调试窗口外壳：非模态无父 `Qt.Tool` 面板 + 顶部页切换（spec #161/#162）。

窗口底色**不透明**：外层不做透明/磨砂（用户 2026-10-03 裁定「透明毛玻璃效果没有
必要」），视觉结构交给内层卡片（`debugCard`：奶油一级 + 1px 描边 + 12 圆角）。
无边框 + 自绘标题行仍是必需的——系统标题栏会吃掉 24 圆角与柔阴影，且窗口得能拖动
和关闭（拖动 / × / Esc）。

窗口只装配，不持有业务：调参页写的是同一份 settings 对象，排障页自己按下单发自
续调度取数。
"""
import sys

from PySide6 import QtCore, QtGui, QtWidgets

from qfluentwidgets import (BodyLabel, FluentIcon, SegmentedWidget,
                            TransparentToolButton)

from . import debug_tokens as TOKENS
from .debug_diag_page import DiagPage
from .debug_tuning_page import TuningPage
from .protocol import DEFAULT_PORT

PAGES = ("tuning", "diag")
PAGE_TITLES = {"tuning": "调参", "diag": "排障"}
SHADOW_MARGIN = 24


def window_sheet(rgba):
    """无边框窗口的圆角 / 内描边 / 底色（token 文档 §3）。"""
    r, g, b, a = rgba
    sr, sg, sb, sa = TOKENS.WINDOW_STROKE_RGBA
    return """
QFrame#debugWindow {
    background: rgba(%d, %d, %d, %d);
    border: 1px solid rgba(%d, %d, %d, %d);
    border-radius: %dpx;
}
""" % (r, g, b, a, sr, sg, sb, sa, TOKENS.RADIUS)


WINDOW_QSS = window_sheet(TOKENS.WINDOW_RGBA)


def _os_label():
    """The machine line under the title (the prototype's subtitle): which system
    this panel is running on."""
    build = 0
    if sys.platform == "win32":
        try:
            build = int(sys.getwindowsversion().build)
        except Exception:
            build = 0
    if build <= 0:
        return "非 Windows 桌面"
    return "%s build %d" % ("Windows 11" if build >= 22000 else "Windows 10", build)


class _Panel(QtWidgets.QFrame):
    """无边框窗口的拖动面：标题行与面板空白处都能拖。"""

    def __init__(self, target, parent=None):
        super().__init__(parent)
        self._target = target
        self._offset = None

    def mousePressEvent(self, event):
        if event.button() == QtCore.Qt.LeftButton:
            self._offset = (event.globalPosition().toPoint()
                            - self._target.frameGeometry().topLeft())
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._offset is not None and event.buttons() & QtCore.Qt.LeftButton:
            self._target.move(event.globalPosition().toPoint() - self._offset)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        self._offset = None
        super().mouseReleaseEvent(event)


class DebugWindow(QtWidgets.QWidget):
    def __init__(self, settings, *, port=None, overlay=None, parent=None):
        super().__init__(parent, QtCore.Qt.Tool | QtCore.Qt.FramelessWindowHint)
        self.setObjectName("debugRoot")
        self.setAttribute(QtCore.Qt.WA_TranslucentBackground, True)
        self.setWindowTitle("调试")
        self.settings = settings
        self._port = int(port if port is not None else
                         settings.get("server", {}).get("port", DEFAULT_PORT))
        self._current = "tuning"
        self.tuning_page = TuningPage(settings, overlay=overlay)
        self.diag_page = DiagPage(self._port)
        self._build()
        self.resize(1120, 760)

    # ---- what app.py and the tests use ----

    def current_page_name(self):
        return self._current

    def show_page(self, name):
        if name not in PAGES:
            raise KeyError(name)
        self._current = name
        self.stack.setCurrentIndex(PAGES.index(name))
        if self.page_switch.currentRouteKey() != name:
            self.page_switch.setCurrentItem(name)

    # ---- Qt events ----

    def closeEvent(self, event):
        self.diag_page.stop()                        # 关窗即停取数（复用实例再开）
        super().closeEvent(event)

    def keyPressEvent(self, event):
        if event.key() == QtCore.Qt.Key_Escape:
            self.close()
            return
        super().keyPressEvent(event)

    # ---- construction ----

    def _build(self):
        self._outer = QtWidgets.QVBoxLayout(self)
        self._outer.setContentsMargins(SHADOW_MARGIN, SHADOW_MARGIN,
                                       SHADOW_MARGIN, SHADOW_MARGIN)
        self.panel = _Panel(self, self)
        self.panel.setObjectName("debugWindow")
        self._shadow = QtWidgets.QGraphicsDropShadowEffect(self.panel)
        self._shadow.setBlurRadius(TOKENS.SHADOW_BLUR)
        self._shadow.setOffset(0, 8)
        self._shadow.setColor(QtGui.QColor(0, 0, 0, 70))
        self.panel.setGraphicsEffect(self._shadow)
        self._outer.addWidget(self.panel)

        column = QtWidgets.QVBoxLayout(self.panel)
        column.setContentsMargins(18, 14, 18, 16)
        column.setSpacing(10)
        header = QtWidgets.QHBoxLayout()
        titles = QtWidgets.QVBoxLayout()
        titles.setSpacing(1)
        title = BodyLabel("调试")
        title.setObjectName("debugTitle")
        titles.addWidget(title)
        self.env_label = BodyLabel("")
        self.env_label.setObjectName("debugHint")
        titles.addWidget(self.env_label)
        header.addLayout(titles)
        header.addSpacing(18)
        self.page_switch = SegmentedWidget()
        # 指示条取靛蓝主调（库默认跟全局主题色走，这里不外溢到别的窗口）
        self.page_switch.lightIndicatorColor = QtGui.QColor(TOKENS.INDIGO)
        for name in PAGES:
            self.page_switch.addItem(
                name, PAGE_TITLES[name],
                lambda _=False, page=name: self.show_page(page))
        header.addWidget(self.page_switch, 0, QtCore.Qt.AlignVCenter)
        header.addStretch(1)
        self.close_button = TransparentToolButton(FluentIcon.CLOSE)
        self.close_button.setToolTip("关闭（Esc）")
        self.close_button.clicked.connect(self.close)
        header.addWidget(self.close_button, 0, QtCore.Qt.AlignTop)
        column.addLayout(header)

        self.stack = QtWidgets.QStackedWidget()
        self.stack.addWidget(self.tuning_page)
        self.stack.addWidget(self.diag_page)
        column.addWidget(self.stack, 1)
        self.page_switch.setCurrentItem("tuning")
        self.setStyleSheet(TOKENS.qss() + WINDOW_QSS)
        self.env_label.setText(_os_label())

