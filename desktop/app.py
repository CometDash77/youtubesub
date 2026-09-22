"""youtubesub desktop app entry point.
Wires: WSServer -> Engine -> OverlayWindow (Qt timer pump)."""
import queue, sys, os, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PySide6 import QtCore, QtWidgets

from suboverlay.connection_test import ConnectionTester
from suboverlay.engine import Engine
from suboverlay.hotkey import ComboWatcher
from suboverlay.overlay import OverlayWindow
from suboverlay.server import WSServer
from suboverlay import settings as S
from suboverlay.protocol import DEFAULT_PORT


class SettingsDialog(QtWidgets.QDialog):
    # Marshals a finished connection test onto the GUI thread: the runner
    # completes on its worker thread; Qt queues this emission to the slot.
    report_ready = QtCore.Signal(object)

    def __init__(self, settings, parent=None, tester=None):
        super().__init__(parent)
        self.tester = tester
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
        # #23 thin GUI adapter over suboverlay/connection_test.py: this dialog
        # only wires signals - run mechanics and the report contract live in
        # the module, so they are testable without a window server.
        self.test_btn = QtWidgets.QPushButton("Test connection")
        self.cancel_btn = QtWidgets.QPushButton("Cancel test")
        self.cancel_btn.setEnabled(False)
        self.progress = QtWidgets.QLabel("")
        self.report_view = QtWidgets.QPlainTextEdit("")
        self.report_view.setReadOnly(True)
        self.report_view.setFixedHeight(150)
        form.addRow(self.test_btn, self.cancel_btn)
        form.addRow("Test progress", self.progress)
        form.addRow("Test report", self.report_view)
        self.report_ready.connect(self._show_report)
        self._poll = QtCore.QTimer(self)
        self._poll.setInterval(200)
        self._poll.timeout.connect(self._poll_progress)
        self.test_btn.clicked.connect(self._start_connection_test)
        self.cancel_btn.clicked.connect(self._cancel_connection_test)
        if self.tester is not None and self.tester.last_report():
            self._render_report(self.tester.last_report())
            self.progress.setText("last run - see report")
        buttons = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Ok | QtWidgets.QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        form.addRow(buttons)

    def _start_connection_test(self):
        # Snapshot semantics (#23): the run tests the inputs as they are at
        # this click; nothing is saved to disk and nothing auto-triggers.
        if self.tester is None:
            return
        snap = {"base_url": self.base_url.text().strip(),
                "api_key": self.api_key.text(),
                "model": self.model.text().strip(),
                "protocol": self.protocol.currentText(),
                "system": self.system.toPlainText(),
                "mock": self.mock.isChecked()}
        if not self.tester.start(snap, on_done=self.report_ready.emit):
            return  # single flight: a run is already in the air
        self.test_btn.setEnabled(False)
        self.cancel_btn.setEnabled(True)
        self.progress.setText("starting...")
        self._poll.start()

    def _cancel_connection_test(self):
        # Cancel = stop waiting only: the HTTP request is not interrupted and
        # its quota is not refunded - say so instead of implying a rollback.
        if self.tester is None:
            return
        self.tester.cancel()
        self._poll.stop()
        self.test_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        self.progress.setText(
            "cancelled - the in-flight request keeps running; its quota is not refunded")

    def _poll_progress(self):
        p = self.tester.progress()
        if p["running"]:
            step = max(1, min(2, int(p["step"] or 1)))
            self.progress.setText("step %d/2 - %.1fs" % (step, p["elapsed_s"]))
        else:
            self._poll.stop()

    def _show_report(self, report):
        self._poll.stop()
        self.test_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        self.progress.setText("done in %s ms" % report.get("duration_ms", 0))
        self._render_report(report)

    def _render_report(self, report):
        """Thin adapter: render the report's own fields verbatim - machine code
        and human message travel together, so there is no UI-side code table
        that could drift from the contract (#23 decision 15)."""
        lines = ["VERDICT: " + str(report.get("verdict", "")).upper()]
        for lay in report.get("layers", []):
            passed = lay.get("passed")
            mark = "PASS" if passed is True else ("FAIL" if passed is False else "--")
            code = (" [" + lay["code"] + "]") if lay.get("code") else ""
            lines.append("%s %s %s%s - %s (%s ms)"
                         % (mark, lay.get("id", ""), lay.get("title", ""), code,
                            lay.get("message", ""), lay.get("elapsed_ms", 0)))
        if report.get("skipped"):
            lines.append("Skipped: " + ", ".join(report["skipped"]))
        lines.append("Attempts: %s" % report.get("attempts", 0))
        sample = report.get("sample") or {}
        lines.append("Source: " + str(sample.get("source", "")))
        lines.append("Translation: " + (str(sample.get("translation"))
                                        if sample.get("translation") else "(none)"))
        ml = report.get("model_list") or {}
        if ml.get("observed"):
            lines.append("Models listed: %s (configured model present: %s)"
                         % (ml.get("total", 0), ml.get("contains_model")))
        for w in report.get("warnings", []):
            lines.append("Warning: " + str(w))
        for n in report.get("notes", []):
            lines.append("Note: " + str(n))
        snap = report.get("snapshot") or {}
        lines.append("Based on the inputs as of the click (base_url=%s, model=%s); "
                     "no config file was written."
                     % (snap.get("base_url", ""), snap.get("model", "")))
        lines.append(str(report.get("quota_notice", "")))
        self.report_view.setPlainText(chr(10).join(lines))

    def done(self, r):
        # Closing the dialog abandons any in-flight run (generation bump): a
        # late result must never write into a closed form (#23 decision 19).
        if self.tester is not None:
            self.tester.cancel()
        self._poll.stop()
        super().done(r)

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
        # One app-lifetime connection tester: its last report must outlive the
        # dialog so /status can keep serving it (#23 decision 17).
        self.tester = ConnectionTester()
        self.overlay = OverlayWindow(self.settings)
        # Worker pool follows provider.max_concurrent (clamped [1,16];
        # restart-effective - the SpinBox entry lives with the #21 work item).
        self.engine = Engine(self.settings)
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
        dlg = SettingsDialog(self.settings, tester=self.tester)
        dlg.exec()
        self.engine.settings = self.settings

    def _status(self):
        """GET /status payload: lets the user (and the E2E test) see what the
        overlay is showing without screenshots. Loopback only, same rules as /health."""
        s = self.engine.status()
        d = s.get("display") or {}
        payload = {"state": d.get("state", ""), "orig": d.get("orig", ""),
                   "trans": d.get("trans", ""),
                   "trans_available": bool(d.get("trans_available", False)),
                   "playing": d.get("playing"),
                   "rate": d.get("rate"), "title": d.get("title", ""),
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
    App().run()


if __name__ == "__main__":
    main()