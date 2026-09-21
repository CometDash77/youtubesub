"""Offscreen screenshots of the overlay's display rules (issue #1) for eyeballing.

Throwaway: the assertions live in desktop/tests/test_overlay_labels.py; this only
renders the same rows to PNG so a human (or a vision model) can look at them.
"""
import os, sys
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "desktop"))

from PySide6 import QtWidgets
from suboverlay.overlay import OverlayWindow
from suboverlay.settings import default_settings

OUT = os.path.join(os.path.dirname(__file__), "logs", "overlay-shots")
os.makedirs(OUT, exist_ok=True)
app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])

MOCK = "\u3010\u8bd1\u3011FIXTURE ALPHA one"  # what the mock translator produces
CASES = [
    ("a-trans-no-provider", "trans", "FIXTURE ALPHA one", "", False),
    ("b-bilingual-no-provider", "bilingual", "FIXTURE ALPHA one", "", False),
    ("c-bilingual-with-translation", "bilingual", "FIXTURE ALPHA one", MOCK, True),
    ("d-orig", "orig", "FIXTURE ALPHA one", MOCK, True),
    ("e-between-cues", "bilingual", "", "", False),
]
for name, mode, orig, trans, avail in CASES:
    w = OverlayWindow(default_settings())
    w.resize(470, 135)
    w.mode = mode
    w.set_display({"state": "ok", "orig": orig, "trans": trans,
                   "trans_available": avail, "playing": True})
    path = os.path.join(OUT, name + ".png")
    w.grab().save(path)
    print(name, "->", path)
