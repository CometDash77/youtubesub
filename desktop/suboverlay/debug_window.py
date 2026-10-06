"""设置与调试窗口：非模态无父 `Qt.Tool` 面板 + 顶部页切换（spec #161/#162，地图 #164）。

三页：**设置 / 调参 / 排障**（设置页由原来的模态对话框搬来，见
`suboverlay/settings_page.py`）。整窗共用**一个页脚**「保存 / 取消」：两页各自把
改动套用到同一份 settings 后**只写盘一次**（`settings.save` 的原子写盘），所以
跨页提交是一个原子动作。取消 = 全部回到那份 settings 的当前值，不写盘、不动浮窗。

关窗时若还有没保存的改动，先问一句再关（`_ask_unsaved_changes`）；选「回去继续改」
什么都不停 —— 关掉再开时 `showEvent` 会重新取基线，这正是「每次打开窗口重新快照」
的挂点（地图 #164 记录的坑：调参页的基线原本只在构造时取一次，而本窗口实例被
App 永久复用）。

窗口底色**不透明**：外层不做透明/磨砂（用户 2026-10-03 裁定「透明毛玻璃效果没有
必要」），视觉结构交给内层卡片（`debugCard`：奶油一级 + 1px 描边 + 12 圆角）。
无边框 + 自绘标题行仍是必需的——系统标题栏会吃掉 24 圆角与柔阴影，且窗口得能拖动
和关闭（拖动 / × / Esc）。

窗口只装配，不持有业务：两页写的是同一份 settings 对象，排障页自己按下单发自续
调度取数。

窗口尺寸（#180）：设计值是 1120×760，但以前被设置页的自然尺寸顶到 1120×1015，矮屏上
页脚落到屏幕外。现在高度按屏幕可用区域收敛（`fit_to_screen`），三页共用一个外层滚动区
（`self.scroll`）在矮屏兜底，页脚「取消 / 保存」始终在滚动区之外，右下角另给一个尺寸抓手。
"""
import sys

from PySide6 import QtCore, QtGui, QtWidgets

from qfluentwidgets import (BodyLabel, FluentIcon, PrimaryPushButton, PushButton,
                           SegmentedWidget, TransparentToolButton)

from . import debug_tokens as TOKENS
from . import settings as S
from .debug_diag_page import DiagPage
from .debug_tuning_page import TuningPage
from .protocol import DEFAULT_PORT
from .settings_page import SettingsPage

PAGES = ("settings", "tuning", "diag")
PAGE_TITLES = {"settings": "设置", "tuning": "调参", "diag": "排障"}
SHADOW_MARGIN = 24

# 设计尺寸（原型定的 1120×760）与矮屏兜底（#180）。分工：页内容交给外层滚动区，
# 窗口只按屏幕可用区域收敛，所以窗口可以缩到 MIN_H 而不被内容的自然高度顶住。
PREFERRED_W, PREFERRED_H = 1120, 760
MIN_W, MIN_H = 560, 360
# 标题行 + 页脚 + 内外边距的固定高度（与页面内容无关；实测 1015 - 858 = 157）。
CHROME_H = 160
SCREEN_MARGIN = 64


def fit_to_screen(wanted_w, wanted_h, avail_w, avail_h, margin=SCREEN_MARGIN):
    """把「窗口想要多大」收敛进屏幕可用区域（四周留 margin）。

    宽 / 高都取 `min(wanted, avail - margin)`，并各自不小于 `MIN_W` / `MIN_H`：
    矮屏下窗口会小于内容的自然高度，这时由外层滚动区兜住（`DebugWindow.scroll`）。
    """
    width = max(MIN_W, min(int(wanted_w), int(avail_w) - margin))
    height = max(MIN_H, min(int(wanted_h), int(avail_h) - margin))
    return width, height

# 关窗三选一的结果（`_ask_unsaved_changes` 的返回值）。
CONFIRM_STAY = "stay"
CONFIRM_SAVE = "save"
CONFIRM_DISCARD = "discard"


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


def _ask_unsaved_changes(parent, settings_dirty=False, tuning_dirty=False):
    """关窗拦截：有没保存的改动时三选一。

    默认按钮是「回去继续改」（回车与 Esc 都落在它上面）——Esc 的语义仍然是
    「关窗」，不是「丢掉」。模块级接缝：offscreen 测试直接 stub 掉它。
    """
    box = QtWidgets.QMessageBox(parent)
    box.setIcon(QtWidgets.QMessageBox.Warning)
    box.setWindowTitle("有改动还没保存")
    text = "关掉窗口，还没保存的改动会丢掉。"
    if settings_dirty:
        text += "\n设置页里没保存的密钥（API Key）和提示词会一起丢掉。"
    if tuning_dirty:
        text += "\n调参页改过的数值会回到原样。"
    box.setText(text)
    stay = box.addButton("回去继续改", QtWidgets.QMessageBox.RejectRole)
    save = box.addButton("保存并关闭", QtWidgets.QMessageBox.AcceptRole)
    box.addButton("不保存，直接关闭", QtWidgets.QMessageBox.DestructiveRole)
    box.setDefaultButton(stay)
    box.exec()
    clicked = box.clickedButton()
    if clicked is save:
        return CONFIRM_SAVE
    if clicked is stay:
        return CONFIRM_STAY
    return CONFIRM_DISCARD


def _os_label():
    """标题下面那行（原型的副标题）：这套面板跑在哪台机器上。"""
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
    def __init__(self, settings, *, port=None, overlay=None, tester=None, save=None,
                 page="tuning", parent=None):
        super().__init__(parent, QtCore.Qt.Tool | QtCore.Qt.FramelessWindowHint)
        self.setObjectName("debugRoot")
        self.setAttribute(QtCore.Qt.WA_TranslucentBackground, True)
        self.setWindowTitle("设置与调试")
        self.settings = settings
        self.overlay = overlay
        self._save = save or S.save
        self._port = int(port if port is not None else
                         settings.get("server", {}).get("port", DEFAULT_PORT))
        self._current = page if page in PAGES else PAGES[0]
        self._shown = False
        self.settings_page = SettingsPage(settings, tester=tester)
        self.tuning_page = TuningPage(settings)
        self.diag_page = DiagPage(self._port)
        self._build()
        self.setMinimumSize(MIN_W, MIN_H)
        self.fit_to_available()

    # ---- what app.py and the tests use ----

    def current_page_name(self):
        return self._current

    def wanted_size(self):
        """窗口自然想要的尺寸：宽取设计值；高取「设计目标 vs 内容全展开」的较大者。"""
        return (PREFERRED_W,
                max(PREFERRED_H, self.stack.minimumSizeHint().height() + CHROME_H))

    def fit_to_available(self, avail_w=None, avail_h=None):
        """按屏幕可用区域收敛窗口尺寸（不给参数时自己问屏幕），返回实际 (宽, 高)。

        矮屏下窗口高会小于内容的自然高度 —— 这时由外层滚动区兜住，页脚在滚动区之外，
        所以「取消 / 保存」永远可见可点（#180 的验收线：h <= avail_h - SCREEN_MARGIN）。
        """
        if avail_w is None or avail_h is None:
            screen = self.screen() or QtWidgets.QApplication.primaryScreen()
            if screen is None:
                return self.width(), self.height()
            area = screen.availableGeometry()
            avail_w, avail_h = area.width(), area.height()
        self.resize(*fit_to_screen(*self.wanted_size(), avail_w, avail_h))
        return self.width(), self.height()

    def show_page(self, name):
        if name not in PAGES:
            raise KeyError(name)
        self._current = name
        self.stack.setCurrentIndex(PAGES.index(name))
        if self.page_switch.currentRouteKey() != name:
            self.page_switch.setCurrentItem(name)

    def dirty_counts(self):
        """(设置页的改动数, 调参页的改动数) —— 关窗提示按这两半分别点名。"""
        return (self.settings_page.count_dirty(), self.tuning_page.count_dirty())

    def dirty_count(self):
        return sum(self.dirty_counts())

    def is_dirty(self):
        """整窗是否还有没落盘的改动（页脚那行与关窗拦截都看它）。"""
        return self.dirty_count() > 0

    def save(self):
        """整窗保存：两页各自套用到同一份 settings，然后**只写盘一次**。"""
        tuning_applied = self.tuning_page.apply()
        settings_applied = self.settings_page.apply()
        if tuning_applied or settings_applied:
            self._save(self.settings)          # 一次原子写盘（settings.save）
        if self.overlay is not None and any(S.field_by_path(p)["notify_overlay"]
                                            for p in tuning_applied):
            self.overlay.reread_settings()     # mode/order 是浮窗的启动快照
        self.snapshot()
        return bool(tuning_applied or settings_applied)

    def cancel(self):
        """丢弃全窗未落盘的编辑（两页都回到那份 settings 的当前值）。"""
        self.settings_page.cancel()
        self.tuning_page.cancel()
        self._refresh_footer()

    def snapshot(self):
        """重新取基线（打开窗口 / 保存成功 / 取消或放弃之后）。"""
        self.settings_page.snapshot()
        self.tuning_page.snapshot()
        self._refresh_footer()

    # ---- Qt events ----

    def closeEvent(self, event):
        if not self._confirm_close():
            event.ignore()
            return
        self._stop_pages()                           # 关窗即停取数（复用实例再开）
        super().closeEvent(event)

    def showEvent(self, event):
        super().showEvent(event)
        if not self._shown:
            # 打开窗口 = 基线重新快照 + 按屏幕可用区域收敛尺寸（实例被 App 永久复用，
            # 换屏 / 换分辨率之后只有这次重算才算数）。
            self._shown = True
            self.fit_to_available()
            self.snapshot()

    def hideEvent(self, event):
        self._shown = False
        super().hideEvent(event)

    def keyPressEvent(self, event):
        if event.key() == QtCore.Qt.Key_Escape:
            self.close()
            return
        super().keyPressEvent(event)

    # ---- internals ----

    def _refresh_footer(self):
        count = self.dirty_count()
        self.save_button.setEnabled(count > 0)
        self.status_label.setText("没有未保存的改动" if count == 0
                                  else "有 %d 项改动没保存" % count)

    def _confirm_close(self):
        if not self.is_dirty():
            return True
        settings_dirty, tuning_dirty = self.dirty_counts()
        choice = _ask_unsaved_changes(self, settings_dirty=settings_dirty > 0,
                                      tuning_dirty=tuning_dirty > 0)
        if choice == CONFIRM_STAY:
            return False
        if choice == CONFIRM_SAVE:
            self.save()
        else:
            self.cancel()
        return True

    def _stop_pages(self):
        """关窗清理，幂等：排障页先停（`DiagPage.stop()` 只停轮询），再放弃进行中的连接测试。"""
        self.diag_page.stop()
        self.settings_page.cancel_test()

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
        title = BodyLabel("设置与调试")
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
        self.stack.addWidget(self.settings_page)
        self.stack.addWidget(self.tuning_page)
        self.stack.addWidget(self.diag_page)
        # 外层滚动区（#180）：矮屏下三页一起滚，页脚仍在滚动区之外所以始终可见
        # （排障页内部那一层滚动区是自己的分区列表，不重复包）。
        self.scroll = QtWidgets.QScrollArea(self.panel)
        self.scroll.setObjectName("debugScroll")
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
        self.scroll.viewport().setAutoFillBackground(False)
        self.scroll.setStyleSheet(
            "QScrollArea{background:transparent;border:none;}"
            "QScrollArea>QWidget>QWidget{background:transparent;}")
        self.scroll.setWidget(self.stack)
        column.addWidget(self.scroll, 1)

        # 整窗一个页脚：左边一行状态，右边「取消 / 保存」（保存无事可做时禁用）。
        footer = QtWidgets.QHBoxLayout()
        self.status_label = BodyLabel("没有未保存的改动")
        self.status_label.setObjectName("debugHint")
        footer.addWidget(self.status_label, 0, QtCore.Qt.AlignVCenter)
        footer.addStretch(1)
        self.cancel_button = PushButton("取消")
        self.save_button = TOKENS.apply_primary_button(PrimaryPushButton("保存"))
        self.cancel_button.clicked.connect(self.cancel)
        self.save_button.clicked.connect(self.save)
        footer.addWidget(self.cancel_button)
        footer.addWidget(self.save_button)
        # 无边框窗口没有系统边框可拖：右下给一个尺寸抓手（#180）。
        self.size_grip = QtWidgets.QSizeGrip(self.panel)
        footer.addWidget(self.size_grip, 0, QtCore.Qt.AlignBottom)
        column.addLayout(footer)

        # Ctrl+S 保存但**不关窗**；Esc 仍是关窗（`keyPressEvent`）。
        self._save_shortcut = QtGui.QShortcut(QtGui.QKeySequence.Save, self)
        self._save_shortcut.activated.connect(self.save)
        for page in (self.settings_page, self.tuning_page):
            page.changed.connect(self._refresh_footer)

        self.show_page(self._current)
        self.setStyleSheet(TOKENS.qss() + WINDOW_QSS)
        self.env_label.setText(_os_label())
        self._refresh_footer()
