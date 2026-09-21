"""Machine-checkable acceptance for the throwaway UX mock (ticket #4).

No eyes required: it re-renders each state, walks the widget tree for every
visible string inside the dialog bounds, and does a pixel probe for the
translation yellow (255,224,130) on each overlay state.

  python .scratch/prototype/config-ux/verify_ux_mock.py ; echo EXIT=$LASTEXITCODE
"""
import os, sys, io

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

LOG = open(os.path.join(HERE, "verify.log"), "w", encoding="utf-8", newline="\n")


def print(*a):  # console is GBK on this box; the log is the artifact
    LOG.write(" ".join(str(x) for x in a) + "\n")

import settings_ux_mock as M
from PySide6 import QtCore, QtGui, QtWidgets

YELLOW = QtGui.QColor(255, 224, 130)
fails = []


def check(cond, msg):
    print(("  OK   " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


def visible_texts(w):
    out = []
    for c in w.findChildren(QtWidgets.QWidget):
        t = None
        if isinstance(c, (QtWidgets.QLabel, QtWidgets.QAbstractButton)):
            t = c.text()
        elif isinstance(c, QtWidgets.QLineEdit):
            t = c.text() if c.text() else ("placeholder: " + c.placeholderText())
        if isinstance(c, QtWidgets.QComboBox) and c.isVisible():
            t = "combo:" + c.currentText()
        if t and c.isVisible():
            g = c.geometry()
            tl = c.mapTo(w, QtCore.QPoint(0, 0))
            box = QtCore.QRect(tl, c.size())
            inside = w.rect().contains(box)
            out.append((t, box, inside))
    return out


def dump_dialog(name, dlg):
    dlg.show()
    QtWidgets.QApplication.processEvents()
    print("== dialog " + name + "  size=" + str(dlg.width()) + "x" + str(dlg.height()))
    for t, box, inside in visible_texts(dlg):
        print("   [" + ("in" if inside else "OUT") + "] " + str(box.x()).rjust(4) + "," +
              str(box.y()).rjust(3) + " " + str(box.width()).rjust(4) + "x" +
              str(box.height()).rjust(3) + "  " + t.replace(chr(10), " / ")[:110])
        if not inside:
            fails.append(name + " text outside dialog: " + t)
    p = os.path.join(HERE, name)
    pm = dlg.grab()
    pm.save(p)
    QtWidgets.QApplication.processEvents()
    dlg.hide()
    return pm


def yellow_pixels(pm):
    img = pm.toImage().convertToFormat(QtGui.QImage.Format_ARGB32)
    n = 0
    for y in range(0, img.height(), 2):
        for x in range(0, img.width(), 2):
            c = QtGui.QColor(img.pixel(x, y))
            if abs(c.red() - YELLOW.red()) < 24 and abs(c.green() - YELLOW.green()) < 24 \
                    and abs(c.blue() - YELLOW.blue()) < 24:
                n += 1
    return n


def main():
    QtWidgets.QApplication([])
    mine = os.path.join(HERE, "01-unconfigured.png")
    if os.path.exists(mine):
        os.remove(mine)
    d_un = M.ProposedSettingsDialog(M.make_settings())
    d_un.resize(640, d_un.sizeHint().height())
    pm_un = dump_dialog("01-unconfigured.png", d_un)
    d_cf = M.ProposedSettingsDialog(
        M.make_settings("https://api.example.com/v1", "gpt-4o-mini", "sk-" + "x" * 48),
        saved_at="12:03:45")
    d_cf.resize(640, d_cf.sizeHint().height())
    dump_dialog("02-configured-just-saved.png", d_cf)
    d_mk = M.ProposedSettingsDialog(M.make_settings(mock=True), dirty=True)
    d_mk.resize(640, d_mk.sizeHint().height())
    dump_dialog("03-mock-mode-dirty.png", d_mk)

    print("== banner state mapping")
    check("未配置" in d_un.banner.text(), "empty provider -> 未配置 banner")
    check("Mock" in d_mk.banner.text(), "mock=true -> Mock banner")
    check("已配置" in d_cf.banner.text() and "api.example.com" in d_cf.banner.text(),
          "configured -> 已配置 banner names host")
    check("已保存 12:03:45" in d_cf.save_state.text(), "saved feedback shows timestamp")
    check("未保存的改动" in d_mk.save_state.text(), "dirty feedback shows 未保存")
    check("已保存 51 字符" in d_cf.api_key.placeholderText(), "key echo is length, not value")
    check("sk-" not in d_cf.api_key.placeholderText() and d_cf.api_key.text() == "",
          "api key never echoed as text")
    check(d_un.api_key.placeholderText().startswith("尚未设置"), "empty key shows 尚未设置")

    print("== overlay three states (real OverlayWindow paint path)")
    cases = [("unconfigured", M.make_settings(), "", 0),
             ("mock", M.make_settings(mock=True), "【译】FIXTURE ALPHA one", 1),
             ("configured", M.make_settings("https://api.example.com/v1", "gpt-4o-mini"),
              "夹具阿尔法一号", 1)]
    for name, st, trans, expect_yellow in cases:
        w = M.ProposedOverlay(st)
        w.resize(680, 118)
        w.set_display({"state": "ok", "orig": "FIXTURE ALPHA one", "trans": trans, "playing": True})
        w.show()
        QtWidgets.QApplication.processEvents()
        pm = w.grab()
        y = yellow_pixels(pm)
        print("   " + name.ljust(12) + " status_line=" + repr(w.status_text) + "  yellow_px=" + str(y))
        check((y > 0) == bool(expect_yellow),
              name + " yellow translation line " + ("present" if expect_yellow else "absent"))
        check(bool(w.status_text) == (name != "configured"),
              name + " status line " + ("shown" if name != "configured" else "silent"))
        w.hide()
        w.deleteLater()

    M.overlay_composite()
    print("== artifacts")
    for f in ("01-unconfigured.png", "02-configured-just-saved.png",
              "03-mock-mode-dirty.png", "04-overlay-three-states.png"):
        p = os.path.join(HERE, f)
        ex = os.path.exists(p) and os.path.getsize(p) > 2000
        check(ex, f + " written (" + str(os.path.getsize(p) if os.path.exists(p) else 0) + " bytes)")

    print("ACCEPTANCE_FAIL=" + str(len(fails)))
    for f in fails:
        print("  ! " + f)
    LOG.close()
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
