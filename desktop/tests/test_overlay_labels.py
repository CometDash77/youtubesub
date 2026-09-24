"""Issue #1, display half: an unavailable translation must not blank the overlay.

The engine stopped fabricating a translation when no provider is configured
(cc02109, see test_engine.py::test_unconfigured_provider_never_fabricates_a_translation).
That leaves the display layer with an empty translation, and today it answers with
an empty overlay in trans mode - "no translation" reads as "no subtitles".

These tests read what the overlay actually hands to its paint primitives, so they
assert the rendered rows (offscreen, no window server, no screenshots).
"""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtCore, QtGui, QtWidgets

from suboverlay.overlay import OverlayWindow
from suboverlay.settings import default_settings

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])

ORIG_LABEL = "\u3010\u539f\u3011"   # 【原】
TRANS_LABEL = "\u3010\u8bd1\u3011"  # 【译】


class PaintLog:
    """One event per paint primitive call: ("text", s) / ("divider", y)."""

    def __init__(self, w):
        self.events = []
        w._draw_wrapped = self._draw_wrapped
        w._draw_divider = self._draw_divider

    @property
    def texts(self):
        return [t for kind, t in self.events if kind == "text"]

    @property
    def dividers(self):
        return [y for kind, y in self.events if kind == "divider"]

    @property
    def shape(self):
        return [kind for kind, _ in self.events]

    def _draw_wrapped(self, p, font, text, area, y, color, stroke_w):
        self.events.append(("text", text))
        return y + 20

    def _draw_divider(self, p, area, y):
        self.events.append(("divider", round(float(y), 1)))
        return y + 4


def paint(mode, orig, trans, order="trans_first", trans_available=False):
    w = OverlayWindow(default_settings())
    w.resize(420, 140)
    w.mode, w.order = mode, order
    w.orig_text, w.trans_text = orig, trans
    w.trans_available = trans_available
    log = PaintLog(w)
    w.paintEvent(None)
    return log


def test_trans_mode_without_a_translation_shows_the_original():
    """The reported bug: default settings (no provider), trans mode, blank window."""
    log = paint("trans", "FIXTURE ALPHA one", "", trans_available=False)
    assert log.texts == [ORIG_LABEL + "FIXTURE ALPHA one"]
    assert not [t for t in log.texts if TRANS_LABEL in t], log.texts


def test_trans_mode_with_a_configured_provider_keeps_waiting_blank():
    """A usable provider means a translation is coming: no fallback flash, and the
    row is still the translation row (today's behaviour, unchanged)."""
    log = paint("trans", "Hello", "", trans_available=True)
    assert log.texts == []
    assert log.dividers == []


def test_trans_mode_with_a_translation_still_shows_only_the_translation():
    log = paint("trans", "Hello", "\u4f60\u597d", trans_available=True)
    assert log.texts == [TRANS_LABEL + "\u4f60\u597d"]
    assert log.dividers == []


def test_bilingual_without_a_translation_keeps_both_labels_and_the_divider():
    log = paint("bilingual", "Hello there", "", trans_available=False)
    assert log.texts == [TRANS_LABEL, ORIG_LABEL + "Hello there"]
    assert log.shape == ["text", "divider", "text"]


def test_bilingual_divider_sits_between_the_rows_in_either_order():
    first = paint("bilingual", "Hello", "\u4f60\u597d", order="trans_first")
    assert first.texts == [TRANS_LABEL + "\u4f60\u597d", ORIG_LABEL + "Hello"]
    assert first.shape == ["text", "divider", "text"]
    second = paint("bilingual", "Hello", "\u4f60\u597d", order="orig_first")
    assert second.texts == [ORIG_LABEL + "Hello", TRANS_LABEL + "\u4f60\u597d"]
    assert second.shape == ["text", "divider", "text"]


def test_orig_mode_keeps_its_label_and_draws_no_divider():
    log = paint("orig", "Hello", "\u4f60\u597d")
    assert log.texts == [ORIG_LABEL + "Hello"]
    assert log.dividers == []


def test_trans_mode_with_nothing_to_show_stays_blank():
    """The fallback shows the original; with nothing to fall back to there is
    still no floating 【原】 left behind before the first cue."""
    log = paint("trans", "", "", trans_available=False)
    assert log.events == []


def test_a_none_text_is_treated_as_empty_not_a_crash():
    """set_display copies whatever the engine sent; a falsy side must not take the
    paint slot down (the old renderer skipped it)."""
    log = paint("bilingual", None, "\u4f60\u597d")
    assert log.texts == [TRANS_LABEL + "\u4f60\u597d", ORIG_LABEL]


def test_nothing_is_drawn_between_cues():
    """Both rows empty happens in every gap between cues; a row label must not
    survive on its own and leave 【译】/【原】 floating over an empty video."""
    log = paint("bilingual", "", "")
    assert log.events == []


def test_set_display_hands_the_engines_word_to_the_rows():
    """The flag travels on the display state, so the overlay never has to read
    provider config itself (Engine is the only authority on _provider_usable)."""
    w = OverlayWindow(default_settings())
    w.resize(420, 140)
    w.mode = "trans"
    w.set_display({"state": "ok", "orig": "Hello", "trans": "", "trans_available": False})
    log = PaintLog(w)
    w.paintEvent(None)
    assert log.texts == [ORIG_LABEL + "Hello"]


def test_a_text_that_already_carries_its_label_is_not_labelled_twice():
    """The mock translator writes 【译】 into its own output, and the demo / E2E
    depend on that; the row label must not double up on it."""
    log = paint("trans", "\u539f\u6587", TRANS_LABEL + "\u539f\u6587", trans_available=True)
    assert log.texts == [TRANS_LABEL + "\u539f\u6587"]


def test_long_unspaced_translation_wraps_within_the_available_width():
    w = OverlayWindow(default_settings())
    area = QtCore.QRect(10, 10, 72, 100)
    font = QtGui.QFont("Microsoft YaHei UI", 18)
    image = QtGui.QImage(140, 130, QtGui.QImage.Format_ARGB32_Premultiplied)
    image.fill(QtCore.Qt.transparent)
    painter = QtGui.QPainter(image)

    end_y = w._draw_wrapped(
        painter, font, "\u591a\u5e74\u6765\u8d5b\u8f66\u8fd0\u52a8\u4e2d\u4f7f\u7528\u7684\u53d1\u8f66\u683c\u52a8\u753b\u786e\u5b9e\u81ea\u6210\u4e00\u4f53",
        area, area.top(), QtGui.QColor(255, 224, 130), 2.0)
    painter.end()

    line_height = QtGui.QFontMetrics(font).height() + 3
    assert end_y >= area.top() + 3 * line_height
    assert all(image.pixelColor(x, y).alpha() == 0
               for x in range(area.right() + 1, image.width())
               for y in range(image.height()))


def test_long_single_word_wraps_at_large_font_and_narrow_width():
    w = OverlayWindow(default_settings())
    area = QtCore.QRect(10, 10, 48, 500)
    font = QtGui.QFont("Microsoft YaHei UI", 30)
    image = QtGui.QImage(100, 530, QtGui.QImage.Format_ARGB32_Premultiplied)
    image.fill(QtCore.Qt.transparent)
    painter = QtGui.QPainter(image)

    end_y = w._draw_wrapped(
        painter, font, "InternationalChampionshipFinals",
        area, area.top(), QtGui.QColor(255, 224, 130), 2.0)
    painter.end()

    line_height = QtGui.QFontMetrics(font).height() + 3
    assert end_y >= area.top() + 3 * line_height
    assert all(image.pixelColor(x, y).alpha() == 0
               for x in range(area.right() + 1, image.width())
               for y in range(image.height()))


def test_long_translation_renders_inside_bounds_in_trans_and_bilingual_modes():
    translation = ("\u591a\u5e74\u6765\u8d5b\u8f66\u8fd0\u52a8\u4e2d"
                   "\u4f7f\u7528\u7684\u53d1\u8f66\u683c\u52a8\u753b"
                   "\u786e\u5b9e\u81ea\u6210\u4e00\u4f53\u5e76\u4e14"
                   "\u6bcf\u4e2a\u7ec6\u8282\u90fd\u80fd\u8bf4\u660e"
                   "\u8fd9\u9879\u8fd0\u52a8\u7684\u590d\u6742\u5386\u53f2")
    for mode in ("trans", "bilingual"):
        w = OverlayWindow(default_settings())
        w.resize(220, 260)
        w.mode = mode
        w.order = "trans_first"
        w.trans_text = translation
        w.orig_text = "Original row" if mode == "bilingual" else ""
        w.trans_available = True
        image = QtGui.QImage(w.size(), QtGui.QImage.Format_ARGB32_Premultiplied)
        image.fill(QtCore.Qt.transparent)
        painter = QtGui.QPainter(image)
        w.render(painter, QtCore.QPoint())
        painter.end()

        area = w.rect().adjusted(14, 14, -14, -14)
        yellow_points = []
        white_points = []
        for y in range(image.height()):
            for x in range(image.width()):
                pixel = image.pixelColor(x, y)
                if pixel.red() > 220 and pixel.green() > 180 and pixel.blue() < 180:
                    yellow_points.append((x, y))
                if pixel.red() > 240 and pixel.green() > 240 and pixel.blue() > 240:
                    white_points.append((x, y))

        assert len({y for _, y in yellow_points}) > 3
        assert all(area.left() <= x <= area.right() and
                   area.top() <= y <= area.bottom()
                   for x, y in yellow_points)
        if mode == "bilingual":
            assert white_points
            assert len({y for _, y in white_points}) > 3
            assert min(y for _, y in white_points) > max(y for _, y in yellow_points)
