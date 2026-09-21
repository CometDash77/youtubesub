"""Regression: overlay resize must keep working when dragging inward.
Runs offscreen; no real window server needed."""
import os, sys
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from PySide6 import QtCore, QtWidgets
from suboverlay.overlay import OverlayWindow
from suboverlay.settings import default_settings

app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def mk_window():
    w = OverlayWindow(default_settings())
    w.resize(380, 64)
    w._press_geom = w.geometry()
    w._press_global = QtCore.QPoint(1000, 1000)
    w._resizing = True
    return w


def test_resize_enlarge_then_shrink():
    w = mk_window()
    start_w, start_h = w.width(), w.height()
    # enlarge by dragging right edge +200
    w._apply_resize("r", QtCore.QPoint(1200, 1000))
    assert w.width() == start_w + 200
    # now shrink by dragging the same edge inward -200 (was broken before latch fix)
    w._apply_resize("r", QtCore.QPoint(1000, 1000))
    assert w.width() == start_w
    # shrink below original from bottom edge
    w._apply_resize("b", QtCore.QPoint(1000, 970))
    assert w.height() == start_h - 30
    # drag far past: clamps to 1 (zero-size guard), never crashes or goes negative
    w._apply_resize("b", QtCore.QPoint(1000, 100))
    assert w.height() == 1


def test_resize_corner_and_no_floor_limit():
    w = mk_window()
    w._apply_resize("br", QtCore.QPoint(1120, 1080))
    assert w.width() == 500 and w.height() == 144
    w._apply_resize("tl", QtCore.QPoint(1000, 1000))
    assert w.width() == 380 and w.height() == 64


def test_latched_edge_survives_inward_drag():
    w = mk_window()
    # simulate the latch: edge stays "r" even though cursor moved to window middle
    w._resize_edge = "r"
    w._apply_resize(w._resize_edge, QtCore.QPoint(950, 1000))
    assert w.width() == 330