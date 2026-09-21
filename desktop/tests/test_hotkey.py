"""Ctrl+Alt+U unlock hotkey: edge detection + the app wiring that uses it."""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from suboverlay.hotkey import COMBO, DOWN, ComboWatcher

from PySide6 import QtWidgets

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def reader_for(flag, missing=()):
    return lambda vk: (0 if vk in missing else (DOWN if flag["down"] else 0))


def test_fires_once_per_press():
    state = {"down": False}
    w = ComboWatcher(COMBO, reader=reader_for(state))
    assert w.poll() is False
    state["down"] = True
    assert w.poll() is True, "a fresh press must fire"
    assert w.poll() is False, "holding the combo must not fire again"
    state["down"] = False
    assert w.poll() is False
    state["down"] = True
    assert w.poll() is True, "the next press fires again"


def test_partial_combo_never_fires():
    w = ComboWatcher(COMBO, reader=reader_for({"down": True}, missing=(0x55,)))
    assert w.poll() is False, "Ctrl+Alt alone is not the hotkey"


def test_a_broken_reader_is_not_a_crash():
    def boom(vk):
        raise OSError("user32 unavailable")
    assert ComboWatcher(COMBO, reader=boom).poll() is False


def test_app_unlocks_click_through_when_the_hotkey_fires(tmp_path, monkeypatch):
    """The whole point: with click-through on, the overlay's own menu is
    unreachable, so this hotkey is the only way back.

    APPDATA is redirected: App() loads settings, and the real
    %APPDATA%/SubOverlay/setting.json holds the user's API key (and a corrupt file
    is renamed to .bak by settings.load) - a test must never touch it."""
    monkeypatch.setenv("APPDATA", str(tmp_path))
    import app as app_module

    instance = app_module.App()
    assert instance.settings["provider"]["api_key"] == "", \
        "the test must not load the user's real settings"
    try:
        instance._set_click_through(True)
        assert instance.overlay._click_through is True
        assert instance._ct_action.isChecked() is True

        instance._unlock_watcher = ComboWatcher(COMBO, reader=reader_for({"down": False}))
        instance._check_unlock_hotkey()          # nothing pressed: stays on
        assert instance.overlay._click_through is True

        instance._unlock_watcher = ComboWatcher(COMBO, reader=reader_for({"down": True}))
        instance._check_unlock_hotkey()
        assert instance.overlay._click_through is False, "hotkey must unlock"
        assert instance._ct_action.isChecked() is False
        assert "ON" not in instance._ct_action.text()
    finally:
        instance.engine._queue.shutdown()
