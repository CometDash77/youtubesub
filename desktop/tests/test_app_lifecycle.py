"""Application lifetime must outlive the non-primary overlay and its windows."""
import http.client
import json
import os
import socket
import pytest
import sys
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtCore, QtWidgets

from app import App
from suboverlay import settings as S

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def test_tray_menu_hides_and_restores_overlay_without_stopping_app(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.setattr(S, "load", S.default_settings)
    instance = App()
    try:
        instance.overlay.show()
        assert instance.tray.contextMenu() is instance.overlay._ctx_menu
        instance._toggle_overlay()
        assert not instance.overlay.isVisible()
        instance.overlay.pulse_topmost()
        assert not instance.overlay.isVisible()
        instance._toggle_overlay()
        assert instance.overlay.isVisible()
    finally:
        instance.overlay.close()
        instance.engine._queue.shutdown()


def test_tray_quit_action_exits_the_app_and_stops_the_service(tmp_path, monkeypatch):
    """#148 acceptance: the tray menu's Quit is effective. The Quit action comes
    from the very QMenu the tray and the overlay share; triggering it must end
    the event loop and release the service port (no orphaned server thread)."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    settings = S.default_settings()
    settings["server"]["port"] = port
    monkeypatch.setattr(S, "load", lambda: settings)

    instance = App()
    try:
        assert instance.tray.contextMenu() is instance.overlay._ctx_menu
        quits = [action for action in instance.overlay._ctx_menu.actions()
                 if action.text() == "退出程序"]
        assert len(quits) == 1, "the tray menu offers exactly one Quit"
        # Safety net: a wrongly wired Quit must fail the assertion below, not
        # hang the suite on app.exec().
        watchdog = []
        QtCore.QTimer.singleShot(0, quits[0].trigger)
        QtCore.QTimer.singleShot(5000, lambda: (watchdog.append(True),
                                                instance.app.quit()))
        with pytest.raises(SystemExit):
            instance.run()
        assert watchdog == [], "Quit action did not end the event loop"
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))  # freed => aboutToQuit stopped it
    finally:
        instance.server.stop()
        instance.tray.hide()
        instance.overlay.close()
        instance.engine._queue.shutdown()


def test_closing_the_settings_window_does_not_quit_the_application(tmp_path, monkeypatch):
    """All production close paths of the settings/debug window leave the overlay
    and the service alive: 保存 / 取消 / × 关窗（#164 起它们是同一个非模态窗口）。"""
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

    def run_path(name, act):
        instance._open_window("settings")
        window = instance.debug_window
        assert window.isModal() is False, "窗口必须是非模态的 (%s)" % name
        assert window.current_page_name() == "settings"
        act(window)
        assert instance.overlay.isVisible(), f"overlay closed after {name}"
        assert health_is_ok(), f"/health stopped responding after {name}"
        completed.append(name)

    def type_then(action):
        def act(window):
            window.settings_page.api_key.setText("sk-half-typed")
            action(window)
        return act

    try:
        assert health_is_ok(), "test server did not start"
        run_path("save", type_then(lambda window: window.save()))
        run_path("cancel", type_then(lambda window: window.cancel()))
        run_path("window-close", lambda window: window.close())
        assert completed == ["save", "cancel", "window-close"]
        assert not instance.debug_window.isVisible(), "× 关窗要真的关掉"
        assert len(saved) == 1, "只有「保存」那一条路径会写盘"
    finally:
        instance.server.stop()
        instance.overlay.close()
        instance.engine._queue.shutdown()
        _QAPP.setQuitOnLastWindowClosed(True)
