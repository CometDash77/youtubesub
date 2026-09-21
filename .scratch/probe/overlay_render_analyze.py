"""Pixel-level check, take 2: the divider is white@80 over the 150-alpha bg, so
it composites to ~alpha 183 - a relaxed threshold finds it; the gap profile shows
where it sits relative to the two text bands."""
import os, sys
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "desktop"))

from PySide6 import QtGui

SHOTS = os.path.join(os.path.dirname(__file__), "logs", "overlay-shots")
def profile(path):
    img = QtGui.QImage(path).convertToFormat(QtGui.QImage.Format_ARGB32)
    w, h = img.width(), img.height()
    rows = []
    for y in range(h):
        n = 0
        for x in range(w):
            c = img.pixelColor(x, y)
            if c.alpha() > 100 and (c.red() + c.green() + c.blue()) > 150:
                n += 1
        rows.append(n)
    return w, h, rows

for name in sorted(os.listdir(SHOTS)):
    if not name.endswith(".png"):
        continue
    w, h, rows = profile(os.path.join(SHOTS, name))
    content = [(y, n) for y, n in enumerate(rows) if n > 3]
    full = [y for y, n in content if n > 0.8 * w]
    bands = []
    for y, _ in content:
        if bands and y - bands[-1][1] <= 2:
            bands[-1][1] = y
        else:
            bands.append([y, y])
    print(name, "| bands:", [(a, b, max(n for y, n in content if a <= y <= b)) for a, b in bands],
          "| divider rows:", (full[0], full[-1], len(full)) if full else None)
    if name.startswith("b-"):
        print("   gap profile y=27..46:", [(y, rows[y]) for y in range(27, 47)])
