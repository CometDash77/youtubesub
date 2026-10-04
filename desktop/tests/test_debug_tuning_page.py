"""地图 #152 / 实施票 #158 -- 调参页（spec #161 窗口接缝）。

offscreen Qt；写盘用注入的 save 替身抓取（照 `test_settings_dialog.py` 的
`_save_spy` 先例），生效通知用假浮窗替身。断言只看外部行为：控件的范围与
文案、写盘内容、通知是否发生——不断言控件类名，也不读 QSS 颜色。
"""
import json
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtWidgets

from suboverlay import settings as S
from suboverlay.debug_tuning_page import TuningPage

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


class FakeOverlay:
    def __init__(self):
        self.rereads = 0

    def reread_settings(self):
        self.rereads += 1


def _page(cfg=None):
    cfg = cfg if cfg is not None else S.default_settings()
    saved = []
    overlay = FakeOverlay()

    def save(c, path=None):
        saved.append(json.loads(json.dumps(c, ensure_ascii=False)))

    page = TuningPage(cfg, overlay=overlay, save=save)
    return page, cfg, saved, overlay


def test_controls_expose_the_spec_ranges():
    page, cfg, _, _ = _page()
    assert page.field_value(("display", "history_lines")) == 2
    page.set_field_value(("display", "history_lines"), 999)
    assert page.field_value(("display", "history_lines")) == 10
    page.set_field_value(("display", "history_lines"), -5)
    assert page.field_value(("display", "history_lines")) == 0
    page.set_field_value(("display", "stroke"), 99.0)
    assert page.field_value(("display", "stroke")) == 10.0
    page.set_field_value(("provider", "max_concurrent"), 0)
    assert page.field_value(("provider", "max_concurrent")) == 1
    page.set_field_value(("display", "mode"), "trans")
    assert page.field_value(("display", "mode")) == "trans"
    page.set_field_value(("display", "mode"), "nonsense")
    assert page.field_value(("display", "mode")) == "bilingual"
    page.set_field_value(("display", "bg_color"), [300, -1, 7])
    assert page.field_value(("display", "bg_color")) == [255, 0, 7]


def test_opening_a_hand_broken_file_shows_clamped_values():
    cfg = S.default_settings()
    cfg["provider"]["timeout_s"] = "abc"
    cfg["display"]["bg_opacity"] = 999
    cfg["display"]["bg_color"] = [300, 0, 0]
    cfg["display"]["mode"] = "bogus"
    page, _, _, _ = _page(cfg)
    assert page.field_value(("provider", "timeout_s")) == 60.0
    assert page.field_value(("display", "bg_opacity")) == 255
    assert page.field_value(("display", "bg_color")) == [255, 0, 0]
    assert page.field_value(("display", "mode")) == "bilingual"


def test_ok_writes_only_the_edited_keys_exactly_once():
    cfg = S.default_settings()
    cfg["display"]["font_size"] = 99          # 用户手写的越界值
    cfg["prefetch"]["draft_note"] = "keep me"
    page, cfg, saved, _ = _page(cfg)
    page.set_field_value(("prefetch", "lead_s"), 30.0)
    page.ok_button.click()
    assert len(saved) == 1
    written = saved[0]
    assert written["prefetch"]["lead_s"] == 30.0
    assert written["display"]["order"] == "trans_first"
    assert written["batch"]["max_chars"] == 8000
    assert written["display"]["font_size"] == 99
    assert written["prefetch"]["draft_note"] == "keep me"
    assert cfg["prefetch"]["lead_s"] == 30.0


def test_ok_without_edits_does_not_touch_the_file():
    page, _, saved, overlay = _page()
    page.ok()
    assert saved == []
    assert overlay.rereads == 0


def test_cancel_discards_everything_and_never_saves():
    page, cfg, saved, overlay = _page()
    page.set_field_value(("prefetch", "lead_s"), 30.0)
    page.cancel_button.click()
    assert saved == []
    assert cfg["prefetch"]["lead_s"] == 90.0
    assert page.field_value(("prefetch", "lead_s")) == 90.0
    assert overlay.rereads == 0


def test_ok_notifies_the_overlay_only_for_the_two_snapshotted_fields():
    page, cfg, _, overlay = _page()
    page.set_field_value(("prefetch", "lead_s"), 30.0)
    page.ok()
    assert overlay.rereads == 0, "只改预取时长不该碰浮窗"
    page.set_field_value(("display", "mode"), "trans")
    page.ok()
    assert overlay.rereads == 1
    page.set_field_value(("display", "history_lines"), 5)
    page.ok()
    assert overlay.rereads == 1, "没改 mode/order 不该重复通知"


def test_order_is_disabled_outside_bilingual_but_keeps_its_value():
    page, cfg, _, overlay = _page()
    assert page.is_field_enabled(("display", "order")) is True
    page.set_field_value(("display", "order"), "orig_first")
    page.set_field_value(("display", "mode"), "trans")
    assert page.is_field_enabled(("display", "order")) is False
    assert page.field_value(("display", "order")) == "orig_first"
    page.ok()
    assert cfg["display"]["order"] == "orig_first"
    assert cfg["display"]["mode"] == "trans"
    assert overlay.rereads == 1
    page.set_field_value(("display", "mode"), "bilingual")
    assert page.is_field_enabled(("display", "order")) is True


def test_seek_is_shown_in_seconds_and_stored_in_milliseconds():
    page, cfg, saved, _ = _page()
    assert page.field_value(("prefetch", "seek_debounce_ms")) == 0.4
    page.set_field_value(("prefetch", "seek_debounce_ms"), 0.5)
    page.ok()
    assert cfg["prefetch"]["seek_debounce_ms"] == 500
    assert saved[0]["prefetch"]["seek_debounce_ms"] == 500


def test_opacity_is_a_slider_and_a_number_box_that_stay_in_sync():
    """spec #161 字段表：背景不透明度 = 滑条 + 数字框（用户故事 18）。"""
    page, cfg, saved, _ = _page()
    sliders = page.findChildren(QtWidgets.QSlider)
    assert len(sliders) == 1, "只有背景不透明度这一项带滑条"
    slider = sliders[0]
    assert (slider.minimum(), slider.maximum()) == (0, 255)
    assert slider.value() == 150
    slider.setValue(200)
    assert page.field_value(("display", "bg_opacity")) == 200
    page.set_field_value(("display", "bg_opacity"), 40)
    assert slider.value() == 40
    page.ok()
    assert cfg["display"]["bg_opacity"] == 40
    assert saved[0]["display"]["bg_opacity"] == 40


def test_group_titles_and_hints_match_the_spec():
    page, _, _, _ = _page()
    assert page.group_title("display") == "显示"
    assert page.group_title("network") == "网络与服务"
    assert "未校准" in page.group_title("experimental")
    assert page.hint_for(("provider", "max_concurrent")) == "重启后生效"
    assert page.hint_for(("server", "port")) == "重启后生效"
    assert page.hint_for(("display", "stroke")) == "0 = 不描边"
    for field in S.TUNING_FIELDS:
        if field["uncalibrated"]:
            assert "未校准" in page.hint_for(field["path"]), field["path"]
        if field["restart"]:
            assert page.hint_for(field["path"]) == "重启后生效", field["path"]


def test_no_credential_path_is_reachable_or_rendered():
    cfg = S.default_settings()
    cfg["provider"]["api_key"] = "sk-secret-do-not-render"
    page, _, _, _ = _page(cfg)
    for path in (("provider", "api_key"), ("provider", "base_url"), ("provider", "model"),
                 ("provider", "protocol"), ("display", "font_size"), ("window", "w"),
                 ("prompt", "active")):
        try:
            page.set_field_value(path, "x")
        except KeyError:
            continue
        raise AssertionError("%r must not be settable from the tuning page" % (path,))
    for widget in page.findChildren(QtWidgets.QWidget):
        text = getattr(widget, "text", None)
        if callable(text):
            assert "sk-secret-do-not-render" not in (text() or "")
