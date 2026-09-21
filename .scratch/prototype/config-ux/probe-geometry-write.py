"""Evidence probe for ticket #4: does dragging the overlay alone write setting.json?

Monkeypatches settings_path() to a temp file (the real %APPDATA% file is never
touched), constructs the real OverlayWindow, delivers one mouse-release, and
prints what landed on disk.
"""
import os, sys, json, tempfile

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "desktop"))

from PySide6 import QtCore, QtGui, QtWidgets
from suboverlay import settings as S
from suboverlay.overlay import OverlayWindow

tmp = tempfile.mkdtemp(prefix="cfgprobe-")
target = os.path.join(tmp, "setting.json")
S.settings_path = lambda: target  # nothing outside tmp is ever written

out = []
app = QtWidgets.QApplication([])
w = OverlayWindow(S.default_settings())
w.show()
QtWidgets.QApplication.processEvents()
out.append("before release: setting.json exists = " + str(os.path.exists(target)))
ev = QtGui.QMouseEvent(QtCore.QEvent.MouseButtonRelease, QtCore.QPointF(10, 10),
                       QtCore.QPointF(20, 30), QtCore.Qt.LeftButton,
                       QtCore.Qt.LeftButton, QtCore.Qt.NoModifier)
w.mouseReleaseEvent(ev)
out.append("after  release: setting.json exists = " + str(os.path.exists(target)))
if os.path.exists(target):
    data = json.load(open(target, encoding="utf-8"))
    out.append("top-level keys      = " + str(sorted(data.keys())))
    out.append("provider            = " + json.dumps(data.get("provider"), ensure_ascii=False))
    out.append("window              = " + json.dumps(data.get("window"), ensure_ascii=False))
    out.append("has _meta.saved_at  = " + str(bool((data.get("_meta") or {}).get("saved_at"))))
    out.append("the user never typed anything; api_key length = " + str(len(data["provider"]["api_key"])))
w.hide()
w.deleteLater()
print("\n".join(out))
