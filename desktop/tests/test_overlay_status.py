"""The overlay's status line must distinguish "no captions here" from
"the script is connected but its page hook never installed"."""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtWidgets

from suboverlay.overlay import OverlayWindow
from suboverlay.settings import default_settings

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def test_hook_failure_is_visible_in_the_status_line():
    w = OverlayWindow(default_settings())
    w.set_display({"state": "no_cues", "title": "Some video",
                   "hook_error": "script element: TypeError: TrustedScript"})
    assert "hook" in w.status_text.lower()
    assert "waiting for subtitles" not in w.status_text


def test_no_cues_without_a_hook_error_still_says_waiting():
    w = OverlayWindow(default_settings())
    w.set_display({"state": "no_cues", "title": "Some video", "hook_error": ""})
    assert w.status_text.startswith("waiting for subtitles")
    assert "Some video" in w.status_text

def test_an_empty_caption_body_has_its_own_status_line():
    """A hook that installed fine but got no caption body is a different failure
    from a hook that never installed; the user must see which one they have."""
    w = OverlayWindow(default_settings())
    w.set_display({"state": "no_cues", "title": "Some video", "hook_error": "",
                   "capture_error": "caption response was empty (status 200)"})
    assert "caption body" in w.status_text.lower()
    assert "waiting for subtitles" not in w.status_text


def test_a_missing_page_hook_outranks_an_empty_caption_body():
    w = OverlayWindow(default_settings())
    w.set_display({"state": "no_cues", "title": "Some video",
                   "hook_error": "script element: TypeError: TrustedScript",
                   "capture_error": "caption response was empty (status 200)"})
    assert "hook" in w.status_text.lower()
