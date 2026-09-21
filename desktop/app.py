"""youtubesub desktop app entry point.
Wires: WSServer -> Engine -> OverlayWindow (Qt timer pump)."""
import queue, sys, os, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PySide6 import QtCore, QtWidgets

from suboverlay.engine import Engine
from suboverlay.hotkey import ComboWatcher
from suboverlay.overlay import OverlayWindow
from suboverlay.server import WSServer
from suboverlay import settings as S
from suboverlay.protocol import DEFAULT_PORT


class SettingsDialog(QtWidgets.QDialog):
    def __init__(self, settings, parent=None):
        super().__init__(parent)
        self.settings = settings
        self.setWindowTitle("AI Translation Settings")
        prov = settings["provider"]
        form = QtWidgets.QFormLayout(self)
        self.base_url = QtWidgets.QLineEdit(prov.get("base_url", ""))
        self.api_key = QtWidgets.QLineEdit(prov.get("api_key", ""))
        self.api_key.setEchoMode(QtWidgets.QLineEdit.Password)
        self.model = QtWidgets.QLineEdit(prov.get("model", ""))
        self.protocol = QtWidgets.QComboBox()
        self.protocol.addItems(["auto", "responses", "chat-completions"])
        self.protocol.setCurrentText(prov.get("protocol", "auto"))
        self.system = QtWidgets.QPlainTextEdit(settings["prompt"].get("system", ""))
        self.system.setFixedHeight(80)
        self.mock = QtWidgets.QCheckBox("Mock mode (no real API)")
        self.mock.setChecked(bool(prov.get("mock")))
        self.font_size = QtWidgets.QSpinBox()
        self.font_size.setRange(6, 40)
        self.font_size.setValue(int(settings["display"].get("font_size", 10)))
        form.addRow("Base URL", self.base_url)
        form.addRow("API Key", self.api_key)
        form.addRow("Model", self.model)
        form.addRow("Protocol", self.protocol)
        form.addRow("System Prompt", self.system)
        form.addRow("", self.mock)
        form.addRow("Font size", self.font_size)
        buttons = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Ok | QtWidgets.QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        form.addRow(buttons)

    def accept(self):
        prov = self.settings["provider"]
        prov["base_url"] = self.base_url.text().strip()
        prov["api_key"] = self.api_key.text()
        prov["model"] = self.model.text().strip()
        prov["protocol"] = self.protocol.currentText()
        prov["mock"] = self.mock.isChecked()
        self.settings["display"]["font_size"] = self.font_size.value()
        self.settings["prompt"]["system"] = self.system.toPlainText()
        S.save(self.settings)
        super().accept()


class App:
    def __init__(self):
        self.settings = S.load()
        self.app = QtWidgets.QApplication.instance() or QtWidgets.QApplication(sys.argv)
        self.overlay = OverlayWindow(self.settings)
        self.engine = Engine(self.settings, workers=5)
        self.evq = queue.Queue(maxsize=2000)
        self.server = WSServer(self.settings.get("server", {}).get("port", DEFAULT_PORT), self.evq,
                               status_provider=self._status)
        # Build the menu here, not in run(): the unlock hotkey timer must never be
        # able to fire before the click-through action it manipulates exists.
        self.overlay._ctx_menu = self._menu()

    def run(self):
        self.overlay.show()
        self.server.start()

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
        sys.exit(self.app.exec())

    def _menu(self):
        from PySide6 import QtWidgets as QW
        m = QW.QMenu()
        a_mode = m.addAction("Mode: original/translation/bilingual")
        a_mode.triggered.connect(self.overlay.cycle_mode)
        a_order = m.addAction("Swap bilingual order")
        a_order.triggered.connect(self.overlay.swap_order)
        m.addSeparator()
        a_fu = m.addAction("Font +")
        a_fu.triggered.connect(lambda: self.overlay.nudge_font(1))
        a_fd = m.addAction("Font -")
        a_fd.triggered.connect(lambda: self.overlay.nudge_font(-1))
        a_ou = m.addAction("Opacity +")
        a_ou.triggered.connect(lambda: self.overlay.nudge_opacity(25))
        a_od = m.addAction("Opacity -")
        a_od.triggered.connect(lambda: self.overlay.nudge_opacity(-25))
        m.addSeparator()
        self._ct_action = m.addAction("Click-through (Ctrl+Alt+U to unlock)")
        self._ct_action.setCheckable(True)
        self._ct_action.triggered.connect(self._toggle_click_through)
        a_set = m.addAction("Settings...")
        a_set.triggered.connect(self._open_settings)
        m.addSeparator()
        a_q = m.addAction("Quit")
        a_q.triggered.connect(QtWidgets.QApplication.instance().quit)
        return m

    def _toggle_click_through(self):
        self._set_click_through(self._ct_action.isChecked())

    def _set_click_through(self, on):
        """Click-through ignores the mouse, so the menu that would switch it back
        off is unreachable: Ctrl+Alt+U is the way back (see suboverlay/hotkey.py)."""
        self.overlay.set_click_through(on)
        self._ct_action.setChecked(on)
        self._ct_action.setText("Click-through ON (Ctrl+Alt+U to unlock)" if on
                                else "Click-through (Ctrl+Alt+U to unlock)")

    def _check_unlock_hotkey(self):
        if self._unlock_watcher.poll():
            self._set_click_through(False)

    def _open_settings(self):
        if self.overlay._click_through:
            self.overlay.set_click_through(False)
            self._ct_action.setChecked(False)
        dlg = SettingsDialog(self.settings)
        dlg.exec()
        self.engine.settings = self.settings

    def _status(self):
        """GET /status payload: lets the user (and the E2E test) see what the
        overlay is showing without screenshots. Loopback only, same rules as /health."""
        s = self.engine.status()
        d = s.get("display") or {}
        return {"state": d.get("state", ""), "orig": d.get("orig", ""),
                "trans": d.get("trans", ""),
                "trans_available": bool(d.get("trans_available", False)),
                "playing": d.get("playing"),
                "rate": d.get("rate"), "title": d.get("title", ""),
                "hook_error": d.get("hook_error", ""),
                "capture_error": d.get("capture_error", ""),
                "sources": s.get("sources", 0), "active_source": s.get("active_source"),
                "mode": self.overlay.mode, "order": self.overlay.order,
                "history": list(self.overlay.history),
                "click_through": bool(self.overlay._click_through)}

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
    App().run()


if __name__ == "__main__":
    main()