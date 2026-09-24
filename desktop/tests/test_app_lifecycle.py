"""Application lifetime must outlive the non-primary overlay and its dialogs."""
import http.client
import json
import os
import socket
import sys
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtCore, QtWidgets

from app import App, SettingsDialog
from suboverlay import settings as S

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def test_closing_settings_dialog_does_not_quit_the_application(tmp_path, monkeypatch):
    """All production settings close paths leave the overlay and service alive."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    saved = []
    monkeypatch.setattr(S, "save", lambda settings, path=None: saved.append(settings.copy()))

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    settings = S.default_settings()
    settings["server"]["port"] = port
    monkeypatch.setattr(S, "load", lambda: settings)

    # Re-establish Qt's default so this test exercises App's startup policy.
    _QAPP.setQuitOnLastWindowClosed(True)
    instance = App()
    assert instance.app.quitOnLastWindowClosed() is False

    completed = []
    instance.overlay.show()
    instance.server.start()
    actions = (
        ("ok", lambda dialog: dialog.accept()),
        ("cancel", lambda dialog: dialog.reject()),
        ("window-close", lambda dialog: dialog.close()),
    )

    def health_is_ok():
        for _ in range(100):
            try:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.2)
                connection.request("GET", "/health")
                response = connection.getresponse()
                payload = json.loads(response.read())
                connection.close()
                return response.status == 200 and payload.get("ok") is True
            except (OSError, http.client.HTTPException, json.JSONDecodeError):
                time.sleep(0.01)
        return False

    def show_next(index=0):
        if index == len(actions):
            QtCore.QTimer.singleShot(0, instance.app.quit)
            return
        name, close_dialog = actions[index]

        def close_open_dialog():
            dialogs = [widget for widget in QtWidgets.QApplication.topLevelWidgets()
                       if isinstance(widget, SettingsDialog) and widget.isVisible()]
            if not dialogs:
                QtCore.QTimer.singleShot(1, close_open_dialog)
                return
            close_dialog(dialogs[-1])

        QtCore.QTimer.singleShot(0, close_open_dialog)
        instance._open_settings()
        assert instance.overlay.isVisible(), f"overlay closed after {name}"
        assert health_is_ok(), f"/health stopped responding after {name}"
        completed.append(name)
        QtCore.QTimer.singleShot(0, lambda: show_next(index + 1))

    try:
        assert health_is_ok(), "test server did not start"
        QtCore.QTimer.singleShot(0, show_next)
        instance.app.exec()
        assert completed == [name for name, _ in actions]
        assert len(saved) == 1, "only OK should persist settings"
    finally:
        instance.server.stop()
        instance.overlay.close()
        instance.engine._queue.shutdown()
        _QAPP.setQuitOnLastWindowClosed(True)
