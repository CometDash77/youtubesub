"""youtubesub desktop app entry point.
Wires: WSServer -> Engine -> OverlayWindow (Qt timer pump)."""
import queue, sys, os, time, uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PySide6 import QtCore, QtWidgets

from suboverlay.engine import Engine
from suboverlay.hotkey import ComboWatcher
from suboverlay.overlay import OverlayWindow
from suboverlay.server import WSServer
from suboverlay import settings as S
from suboverlay import provider as P
from suboverlay.protocol import DEFAULT_PORT

# The dialog has no live neighbours, so the effective preview demonstrates the
# context label lines with these example texts when (and only when) the
# context_groups switch is on - the switch state must be visible in the
# preview (#39 Implementation Decision 5).
PREVIEW_PREV_EXAMPLE = "(previous group)"
PREVIEW_NEXT_EXAMPLE = "(next group)"


def _ask_new_name(parent, initial):
    """Rename prompt. Module-level seam so offscreen tests can stub the
    modal input dialog instead of blocking on it."""
    name, ok = QtWidgets.QInputDialog.getText(
        parent, "Rename preset", "Name:", text=initial)
    return (name or "").strip() if ok else ""


class SettingsDialog(QtWidgets.QDialog):
    """Settings panel. The prompt section implements #39 / ADR-010: a preset
    dropdown (built-in / custom groups), copy-as-custom, rename/delete (both
    disabled on built-ins), a multiline editor (read-only on built-ins), a
    read-only effective preview built by the ONE assembly function, and the
    prompt.context_groups checkbox. Edits only persist on OK (#4 semantics)."""

    def __init__(self, settings, parent=None):
        super().__init__(parent)
        self.settings = settings
        self.setWindowTitle("AI Translation Settings")
        prov = settings["provider"]
        prompt = settings["prompt"]
        self._presets = [dict(p) for p in prompt.get("presets", [])]  # working copy
        self._active = prompt.get("active") or "default"
        if self._find_custom(self._active) is None and not any(
                b["id"] == self._active for b in S.BUILTIN_PROMPTS):
            self._active = "default"
        form = QtWidgets.QFormLayout(self)
        self.base_url = QtWidgets.QLineEdit(prov.get("base_url", ""))
        self.api_key = QtWidgets.QLineEdit(prov.get("api_key", ""))
        self.api_key.setEchoMode(QtWidgets.QLineEdit.Password)
        self.model = QtWidgets.QLineEdit(prov.get("model", ""))
        self.protocol = QtWidgets.QComboBox()
        self.protocol.addItems(["auto", "responses", "chat-completions"])
        self.protocol.setCurrentText(prov.get("protocol", "auto"))
        self.preset = QtWidgets.QComboBox()
        self.preset.currentIndexChanged.connect(self._on_preset_changed)
        btn_row = QtWidgets.QHBoxLayout()
        self.copy_btn = QtWidgets.QPushButton("Copy as custom")
        self.rename_btn = QtWidgets.QPushButton("Rename")
        self.delete_btn = QtWidgets.QPushButton("Delete")
        self.copy_btn.clicked.connect(self._copy_preset)
        self.rename_btn.clicked.connect(self._rename_preset)
        self.delete_btn.clicked.connect(self._delete_preset)
        btn_row.addWidget(self.copy_btn)
        btn_row.addWidget(self.rename_btn)
        btn_row.addWidget(self.delete_btn)
        btn_row.addStretch(1)
        self.system = QtWidgets.QPlainTextEdit()
        self.system.setFixedHeight(80)
        self.system.textChanged.connect(self._on_text_edited)
        self.preview = QtWidgets.QPlainTextEdit()
        self.preview.setFixedHeight(80)
        self.preview.setReadOnly(True)
        self.context_groups = QtWidgets.QCheckBox(
            "Carry context (prev/next group)")
        self.context_groups.setChecked(bool(prompt.get("context_groups", 1)))
        self.context_groups.toggled.connect(self._refresh_preview)
        self.mock = QtWidgets.QCheckBox("Mock mode (no real API)")
        self.mock.setChecked(bool(prov.get("mock")))
        self.font_size = QtWidgets.QSpinBox()
        self.font_size.setRange(6, 40)
        self.font_size.setValue(int(settings["display"].get("font_size", 10)))
        form.addRow("Base URL", self.base_url)
        form.addRow("API Key", self.api_key)
        form.addRow("Model", self.model)
        form.addRow("Protocol", self.protocol)
        form.addRow("Prompt preset", self.preset)
        form.addRow("", self._wrap(btn_row))
        form.addRow("Prompt text", self.system)
        form.addRow("Effective preview", self.preview)
        form.addRow("", self.context_groups)
        form.addRow("", self.mock)
        form.addRow("Font size", self.font_size)
        buttons = QtWidgets.QDialogButtonBox(QtWidgets.QDialogButtonBox.Ok | QtWidgets.QDialogButtonBox.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        form.addRow(buttons)
        # Populate last: _rebuild_preset_combo -> _sync_buttons needs the
        # buttons and the editor to exist already.
        self._rebuild_preset_combo()
        self._load_active_into_editor()
        self._refresh_preview()

    @staticmethod
    def _wrap(layout):
        w = QtWidgets.QWidget()
        w.setLayout(layout)
        return w

    # ---- preset working set (#39 / ADR-010) ----
    def _find_custom(self, pid):
        for p in self._presets:
            if p.get("id") == pid:
                return p
        return None

    def _rebuild_preset_combo(self):
        """Two groups: built-ins first (locked), then custom. Selection is
        restored to the current active id."""
        keep = self._active
        self.preset.blockSignals(True)
        self.preset.clear()
        self.preset.addItem("--- Built-in ---", None)
        for b in S.BUILTIN_PROMPTS:
            self.preset.addItem(b["name"], b["id"])
        self.preset.insertSeparator(self.preset.count())
        self.preset.addItem("--- My presets ---", None)
        for p in self._presets:
            self.preset.addItem(p.get("name") or p["id"], p["id"])
        idx = self.preset.findData(keep)
        self.preset.setCurrentIndex(idx if idx >= 0 else self.preset.findData("default"))
        self.preset.blockSignals(False)
        self._sync_buttons()

    def _current_id(self):
        return self.preset.currentData()

    def _is_builtin(self, pid=None):
        pid = self._current_id() if pid is None else pid
        return any(b["id"] == pid for b in S.BUILTIN_PROMPTS)

    def _sync_buttons(self):
        builtin = self._is_builtin()
        self.rename_btn.setEnabled(not builtin)
        self.delete_btn.setEnabled(not builtin)
        self.system.setReadOnly(builtin)

    def _active_text(self):
        pid = self._current_id()
        if self._is_builtin(pid):
            for b in S.BUILTIN_PROMPTS:
                if b["id"] == pid:
                    return b["text"]
        custom = self._find_custom(pid)
        return custom["text"] if custom else S.DEFAULT_PROMPT_TEXT

    def _load_active_into_editor(self):
        self.system.blockSignals(True)
        self.system.setPlainText(self._active_text())
        self.system.blockSignals(False)
        self._sync_buttons()

    def _on_preset_changed(self, *_):
        pid = self._current_id()
        if pid is None:
            # Group header or separator clicked - snap back to the real
            # selection; headers carry no preset id.
            idx = self.preset.findData(self._active)
            if idx >= 0:
                self.preset.blockSignals(True)
                self.preset.setCurrentIndex(idx)
                self.preset.blockSignals(False)
            return
        self._active = pid
        self._load_active_into_editor()
        self._refresh_preview()

    def _on_text_edited(self, *_):
        # Editing applies only to custom presets; built-ins are read-only.
        if not self._is_builtin():
            custom = self._find_custom(self._current_id())
            if custom is not None:
                custom["text"] = self.system.toPlainText()
        self._refresh_preview()

    def _unique_copy_name(self, base):
        name = base + " \u526f\u672c"   # 副本 - naming fixed by #39
        n = 2
        existing = {p.get("name") for p in self._presets}
        while name in existing:
            name = "%s \u526f\u672c %d" % (base, n)
            n += 1
        return name

    def _copy_preset(self):
        """Copy the selected preset (built-in or custom) into a new custom one
        and select it - the only way to edit a built-in (#39 / ADR-010)."""
        pid = self._current_id()
        text = self.system.toPlainText()  # unsaved edits included
        base = pid
        for b in S.BUILTIN_PROMPTS:
            if b["id"] == pid:
                base = b["name"]
                break
        else:
            custom = self._find_custom(pid)
            base = (custom.get("name") if custom else pid) or pid
        new_id = "prompt_" + uuid.uuid4().hex[:8]
        self._presets.append({"id": new_id,
                              "name": self._unique_copy_name(base),
                              "text": text})
        self._active = new_id
        self._rebuild_preset_combo()
        self._load_active_into_editor()
        self._refresh_preview()

    def _rename_preset(self):
        if self._is_builtin():
            return
        custom = self._find_custom(self._current_id())
        if custom is None:
            return
        name = _ask_new_name(self, custom.get("name", ""))
        if name:
            custom["name"] = name
            self._rebuild_preset_combo()
            self._refresh_preview()

    def _delete_preset(self):
        if self._is_builtin():
            return
        pid = self._current_id()
        self._presets = [p for p in self._presets if p.get("id") != pid]
        if self._active == pid:
            # Deleting the active custom falls back to the default built-in -
            # the user never lands in a "no prompt" empty state (#39 D5).
            self._active = "default"
        self._rebuild_preset_combo()
        self._load_active_into_editor()
        self._refresh_preview()

    def _refresh_preview(self, *_):
        """Read-only effective preview: built by the SAME assembly function
        production uses (#39 Testing Decision 5 - preview == production, one
        function, not two constants). The dialog has no live neighbours, so
        the context label lines are demonstrated with example texts when the
        switch is on - that is how the switch state stays visible here."""
        on = self.context_groups.isChecked()
        self.preview.setPlainText(
            P.build_instructions(self._active_text(),
                                 PREVIEW_PREV_EXAMPLE if on else "",
                                 PREVIEW_NEXT_EXAMPLE if on else "",
                                 0))

    def accept(self):
        prov = self.settings["provider"]
        prov["base_url"] = self.base_url.text().strip()
        prov["api_key"] = self.api_key.text()
        prov["model"] = self.model.text().strip()
        prov["protocol"] = self.protocol.currentText()
        prov["mock"] = self.mock.isChecked()
        self.settings["display"]["font_size"] = self.font_size.value()
        active = self._current_id() or "default"
        if not self._is_builtin(active) and self._find_custom(active) is None:
            active = "default"
        # One-way schema (#39): the legacy "system" key is never written back.
        self.settings["prompt"] = {
            "active": active,
            "presets": [dict(p) for p in self._presets],
            "context_groups": 1 if self.context_groups.isChecked() else 0,
        }
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