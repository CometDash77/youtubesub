"""youtubesub desktop app entry point.
Wires: WSServer -> Engine -> OverlayWindow (Qt timer pump).

The one settings/debug surface is `suboverlay/debug_window.py` (three pages:
设置 / 调参 / 排障, map #164). Both menu entries open that same non-modal
window and only differ in which page it lands on.
"""
import queue, sys, os, traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PySide6 import QtCore, QtWidgets

from suboverlay.connection_test import ConnectionTester
from suboverlay.debug_window import DebugWindow
from suboverlay.engine import Engine
from suboverlay.hotkey import ComboWatcher
from suboverlay.overlay import OverlayWindow
from suboverlay.server import WSServer
from suboverlay import settings as S
from suboverlay.protocol import DEFAULT_PORT


class App:
    def __init__(self):
        self.settings = S.load()
        self.app = QtWidgets.QApplication.instance() or QtWidgets.QApplication(sys.argv)
        # The overlay is a Qt.Tool window, so Qt does not count it as a primary
        # window. Opening/closing the settings-and-debug window must not end the
        # app either.
        self.app.setQuitOnLastWindowClosed(False)
        # One app-lifetime connection tester: its last report must outlive the
        # window so /status can keep serving it (#23 decision 17).
        self.tester = ConnectionTester()
        self.overlay = OverlayWindow(self.settings)
        # The settings-and-debug window is created on first use and then reused
        # (its diag page stops polling when it closes); App holds the reference
        # so the non-modal window is never garbage collected (#158).
        self.debug_window = None
        # Worker pool follows provider.max_concurrent (clamped [1,16];
        # restart-effective - the SpinBox entry lives in the window's tuning
        # page, #158).
        self.engine = Engine(self.settings)
        self.evq = queue.Queue(maxsize=2000)
        self.server = WSServer(self.settings.get("server", {}).get("port", DEFAULT_PORT), self.evq,
                               status_provider=self._status)
        # Build the menu here, not in run(): the unlock hotkey timer must never be
        # able to fire before the click-through action it manipulates exists.
        self.overlay._ctx_menu = self._menu()
        self.tray = QtWidgets.QSystemTrayIcon(
            self.app.style().standardIcon(QtWidgets.QStyle.SP_MediaPlay), self.app)
        self.tray.setToolTip("YouTube 字幕浮窗")
        self.tray.setContextMenu(self.overlay._ctx_menu)
        self.tray.activated.connect(self._tray_activated)

    def run(self):
        self.server.start()
        self.overlay.show()
        self.tray.show()

        pump = QtCore.QTimer()
        pump.timeout.connect(self._drain)
        pump.start(50)
        self._pump = pump

        tick = QtCore.QTimer()
        tick.timeout.connect(self._tick)
        tick.start(33)
        self._tick_timer = tick

        top = QtCore.QTimer()
        top.timeout.connect(self.overlay.pulse_topmost)
        top.start(5000)
        self._top = top

        self._unlock_watcher = ComboWatcher()
        hk = QtCore.QTimer()
        hk.timeout.connect(self._check_unlock_hotkey)
        hk.start(120)
        self._hotkey_timer = hk

        self.app.aboutToQuit.connect(self.server.stop)
        self.app.aboutToQuit.connect(self.tray.hide)
        sys.exit(self.app.exec())

    def _menu(self):
        from PySide6 import QtWidgets as QW
        m = QW.QMenu()
        self._visibility_action = m.addAction("隐藏浮窗")
        self._visibility_action.triggered.connect(self._toggle_overlay)
        m.addSeparator()
        a_mode = m.addAction("显示内容：原文 / 译文 / 双语（点一下换下一种）")
        a_mode.triggered.connect(self.overlay.cycle_mode)
        a_order = m.addAction("上下顺序：原文 ↔ 译文（点一下对调）")
        a_order.triggered.connect(self.overlay.swap_order)
        m.addSeparator()
        a_fu = m.addAction("字号调大")
        a_fu.triggered.connect(lambda: self.overlay.nudge_font(1))
        a_fd = m.addAction("字号调小")
        a_fd.triggered.connect(lambda: self.overlay.nudge_font(-1))
        a_ou = m.addAction("背景调浓")
        a_ou.triggered.connect(lambda: self.overlay.nudge_opacity(25))
        a_od = m.addAction("背景调淡")
        a_od.triggered.connect(lambda: self.overlay.nudge_opacity(-25))
        m.addSeparator()
        self._ct_action = m.addAction("鼠标穿透（开启后点不到浮窗，Ctrl+Alt+U 解锁）")
        self._ct_action.setCheckable(True)
        self._ct_action.triggered.connect(self._toggle_click_through)
        # 两个入口打开的是**同一个**窗口，只是落到不同的一页（#164 目标）。
        a_set = m.addAction("设置……")
        a_set.triggered.connect(lambda: self._open_window("settings"))
        a_debug = m.addAction("调试……")
        a_debug.triggered.connect(lambda: self._open_window("tuning"))
        m.addSeparator()
        a_q = m.addAction("退出程序")
        a_q.triggered.connect(QtWidgets.QApplication.instance().quit)
        return m

    def _toggle_overlay(self):
        if self.overlay.isVisible():
            self.overlay.hide()
            self._visibility_action.setText("显示浮窗")
        else:
            self.overlay.show()
            self._visibility_action.setText("隐藏浮窗")

    def _tray_activated(self, reason):
        if reason == QtWidgets.QSystemTrayIcon.DoubleClick and not self.overlay.isVisible():
            self._toggle_overlay()

    def _toggle_click_through(self):
        self._set_click_through(self._ct_action.isChecked())

    def _set_click_through(self, on):
        """Click-through ignores the mouse, so the menu that would switch it back
        off is unreachable: Ctrl+Alt+U is the way back (see suboverlay/hotkey.py)."""
        self.overlay.set_click_through(on)
        self._ct_action.setChecked(on)
        self._ct_action.setText(
            "鼠标穿透：已开启（Ctrl+Alt+U 解锁）" if on
            else "鼠标穿透（开启后点不到浮窗，Ctrl+Alt+U 解锁）")

    def _check_unlock_hotkey(self):
        if self._unlock_watcher.poll():
            self._set_click_through(False)

    def _open_window(self, page):
        """One window, many ways in: created on first use, then reused - the two
        menu entries only choose the page it lands on. Closing it hides it
        (its diag page stops polling and the in-flight connection test is
        abandoned), so the instance and the app outlive the visit."""
        if self.overlay._click_through:
            # 穿透状态会让新窗口点不到：先用同一条路径解开（文案也会跟着回到关态）。
            self._set_click_through(False)
        if self.debug_window is None:
            self.debug_window = DebugWindow(self.settings, port=self.server.port,
                                            overlay=self.overlay, tester=self.tester)
        self.debug_window.show_page(page)
        self.debug_window.show()
        self.debug_window.raise_()
        self.debug_window.activateWindow()

    def _status(self):
        """GET /status payload: lets the user (and the E2E test) see what the
        overlay is showing without screenshots. Loopback only, same rules as /health."""
        s = self.engine.status()
        d = s.get("display") or {}
        payload = {"state": d.get("state", ""), "orig": d.get("orig", ""),
                   "trans": d.get("trans", ""),
                   "trans_state": d.get("trans_state") or "idle",
                   "trans_available": bool(d.get("trans_available", False)),
                   "playing": d.get("playing"),
                   "rate": d.get("rate"), "title": d.get("title", ""),
                   "video_description": d.get("video_description", ""),
                   "hook_error": d.get("hook_error", ""),
                   "capture_error": d.get("capture_error", ""),
                   "sources": s.get("sources", 0),
                   "active_source": s.get("active_source"),
                   "mode": self.overlay.mode, "order": self.overlay.order,
                   "history": list(self.overlay.history),
                   "click_through": bool(self.overlay._click_through)}
        # The connection-test report rides /status as an OPTIONAL key: absent
        # until a run has produced one - never an empty "not configured" read.
        payload.update(self.tester.status_payload())
        return payload

    def _drain(self):
        n = 0
        while True:
            try:
                ev = self.evq.get_nowait()
            except queue.Empty:
                break
            self.engine.handle_event(ev)
            n += 1
            if n > 500:
                break

    def _tick(self):
        d = self.engine.tick()
        if d:
            self.overlay.set_display(d)


def main():
    try:
        App().run()
    except Exception as exc:  # noqa: BROAD_EXCEPT_OK - GUI entry point
        app = QtWidgets.QApplication.instance() or QtWidgets.QApplication(sys.argv)
        box = QtWidgets.QMessageBox()
        box.setIcon(QtWidgets.QMessageBox.Critical)
        box.setWindowTitle("字幕浮窗启动失败")
        box.setText(str(exc) or type(exc).__name__)
        box.setDetailedText(traceback.format_exc())
        box.exec()
        raise SystemExit(1) from exc


if __name__ == "__main__":
    main()
