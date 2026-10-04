"""地图 #152 / 实施票 #158 -- 浮窗「重读设置」入口（spec #161 生效语义）。

调参页在点「确定」后调用它，让浮窗在不重启的前提下换脸；除此之外浮窗的
其它状态（历史行、文本、几何、点击穿透）一律不许被动到。
"""
import os, sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtWidgets

from suboverlay import settings as S
from suboverlay.overlay import OverlayWindow

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def test_reread_settings_picks_up_mode_and_order_and_keeps_the_rest():
    cfg = S.default_settings()
    w = OverlayWindow(cfg)
    w.history.append(["orig line", "trans line"])
    w.orig_text, w.trans_text = "orig", "trans"

    cfg["display"]["mode"] = "trans"
    cfg["display"]["order"] = "orig_first"
    w.reread_settings()

    assert (w.mode, w.order) == ("trans", "orig_first")
    assert w.history == [["orig line", "trans line"]]
    assert (w.orig_text, w.trans_text) == ("orig", "trans")


def test_reread_settings_falls_back_like_the_constructor():
    cfg = S.default_settings()
    w = OverlayWindow(cfg)
    cfg["display"] = {}
    w.reread_settings()
    assert (w.mode, w.order) == ("bilingual", "trans_first")


def test_reread_settings_never_saves(monkeypatch):
    cfg = S.default_settings()
    w = OverlayWindow(cfg)
    saved = []
    monkeypatch.setattr(S, "save", lambda *a, **kw: saved.append(a))
    cfg["display"]["mode"] = "orig"
    w.reread_settings()
    assert saved == []
    assert w.mode == "orig"
