"""地图 #152 / 实施票 #158 -- 调参页（spec #161 窗口接缝；#164 / #170 起整窗提交）。

offscreen Qt；断言只看外部行为：控件的范围与文案、`apply()` 写进那份 settings 的
内容、脏状态计数、`changed` 信号是否发出 —— 不断言控件类名，也不读 QSS 颜色。
写盘与浮窗通知搬到了窗口级（`debug_window.DebugWindow.save`），所以这里不再有
save 替身与假浮窗。
"""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtWidgets

from suboverlay import settings as S
from suboverlay.debug_tuning_page import TuningPage

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


def _page(cfg=None):
    cfg = cfg if cfg is not None else S.default_settings()
    return TuningPage(cfg), cfg


def test_controls_expose_the_spec_ranges():
    page, cfg = _page()
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
    page, _ = _page(cfg)
    assert page.field_value(("provider", "timeout_s")) == 60.0
    assert page.field_value(("display", "bg_opacity")) == 255
    assert page.field_value(("display", "bg_color")) == [255, 0, 0]
    assert page.field_value(("display", "mode")) == "bilingual"


def test_apply_writes_only_the_edited_keys():
    cfg = S.default_settings()
    cfg["display"]["font_size"] = 99          # 用户手写的越界值：没动就不许改它
    cfg["prefetch"]["draft_note"] = "keep me"
    page, cfg = _page(cfg)
    page.set_field_value(("prefetch", "lead_s"), 30.0)
    assert page.apply() == [("prefetch", "lead_s")]
    assert cfg["prefetch"]["lead_s"] == 30.0
    assert cfg["display"]["order"] == "trans_first"
    assert cfg["batch"]["max_chars"] == 8000
    assert cfg["display"]["font_size"] == 99
    assert cfg["prefetch"]["draft_note"] == "keep me"


def test_apply_without_edits_touches_nothing():
    page, cfg = _page()
    before = repr(cfg)
    assert page.apply() == []
    assert page.count_dirty() == 0
    assert repr(cfg) == before


def test_cancel_discards_everything():
    page, cfg = _page()
    page.set_field_value(("prefetch", "lead_s"), 30.0)
    assert page.is_dirty() is True
    page.cancel()
    assert cfg["prefetch"]["lead_s"] == 90.0
    assert page.field_value(("prefetch", "lead_s")) == 90.0
    assert page.is_dirty() is False


def test_applied_display_fields_are_the_ones_the_overlay_has_to_repaint():
    """整窗保存时窗口只对 notify_overlay 的字段喊浮窗重画（#167 决议）。

    这里断言的是权威表这一侧的事实：改字号/描边/底板/加粗/显示内容都要喊，
    改预取时长不喊。
    """
    page, _ = _page()
    for path in (("display", "font_size"), ("display", "mode"), ("display", "order"),
                 ("display", "stroke"), ("display", "bg_color"),
                 ("display", "bg_opacity"), ("display", "font_bold")):
        assert S.field_by_path(path)["notify_overlay"] is True, path
    assert S.field_by_path(("prefetch", "lead_s"))["notify_overlay"] is False
    assert S.field_by_path(("display", "history_lines"))["notify_overlay"] is False


def test_order_is_disabled_outside_bilingual_but_keeps_its_value():
    page, cfg = _page()
    assert page.is_field_enabled(("display", "order")) is True
    page.set_field_value(("display", "order"), "orig_first")
    page.set_field_value(("display", "mode"), "trans")
    assert page.is_field_enabled(("display", "order")) is False
    assert page.field_value(("display", "order")) == "orig_first"
    page.apply()
    assert cfg["display"]["order"] == "orig_first"
    assert cfg["display"]["mode"] == "trans"
    page.set_field_value(("display", "mode"), "bilingual")
    assert page.is_field_enabled(("display", "order")) is True


def test_seek_is_shown_in_seconds_and_stored_in_milliseconds():
    page, cfg = _page()
    assert page.field_value(("prefetch", "seek_debounce_ms")) == 0.4
    page.set_field_value(("prefetch", "seek_debounce_ms"), 0.5)
    page.apply()
    assert cfg["prefetch"]["seek_debounce_ms"] == 500


def test_opacity_is_a_slider_and_a_number_box_that_stay_in_sync():
    """spec #161 字段表：背景不透明度 = 滑条 + 数字框（用户故事 18）。"""
    page, cfg = _page()
    sliders = page.findChildren(QtWidgets.QSlider)
    assert len(sliders) == 1, "只有背景不透明度这一项带滑条"
    slider = sliders[0]
    assert (slider.minimum(), slider.maximum()) == (0, 255)
    assert slider.value() == 150
    slider.setValue(200)
    assert page.field_value(("display", "bg_opacity")) == 200
    page.set_field_value(("display", "bg_opacity"), 40)
    assert slider.value() == 40
    page.apply()
    assert cfg["display"]["bg_opacity"] == 40


def test_font_size_lives_in_the_display_group_with_the_authority_range():
    """#167 归位：字号补进权威表并归「显示」组（此前只有设置对话框有它）。"""
    field = S.field_by_path(("display", "font_size"))
    assert field["group"] == "display"
    assert (field["control"], field["min"], field["max"], field["step"]) == \
        ("int", 6, 40, 1)
    assert S.TUNING_FIELDS[0]["path"] == ("display", "font_size"), "显示组第一项就是字号"
    page, cfg = _page()
    page.set_field_value(("display", "font_size"), 999)
    assert page.field_value(("display", "font_size")) == 40
    page.apply()
    assert cfg["display"]["font_size"] == 40


def test_dirty_counts_only_what_apply_would_write():
    page, _ = _page()
    assert page.is_dirty() is False and page.count_dirty() == 0
    page.set_field_value(("display", "history_lines"), 5)
    assert page.count_dirty() == 1
    page.set_field_value(("display", "history_lines"), 2)     # 改回原值
    assert page.is_dirty() is False, "值相等不算脏（不是 dirty flag）"
    page.set_field_value(("display", "mode"), "trans")
    page.set_field_value(("prefetch", "lead_s"), 30.0)
    assert page.count_dirty() == 2


def test_snapshot_rolls_the_controls_back_to_the_settings_dict():
    cfg = S.default_settings()
    page, cfg = _page(cfg)
    page.set_field_value(("display", "history_lines"), 5)
    page.apply()
    assert cfg["display"]["history_lines"] == 5
    page.set_field_value(("display", "history_lines"), 7)
    assert page.is_dirty() is True
    page.snapshot()                                            # 打开窗口 / 保存成功后的再快照
    assert page.field_value(("display", "history_lines")) == 5
    assert page.is_dirty() is False


def test_every_edit_fires_the_changed_signal():
    """窗口页脚的「保存」可用态靠这条信号刷新 —— 编辑不通知，按钮就永远点不了。"""
    page, _ = _page()
    seen = []
    page.changed.connect(lambda: seen.append(True))
    page.set_field_value(("display", "history_lines"), 5)      # 数字框
    page.set_field_value(("display", "mode"), "trans")          # 下拉
    page.set_field_value(("display", "bg_opacity"), 40)         # 滑条 + 数字框
    assert len(seen) >= 3, seen
    # 取色按钮也接了线（点它会弹真模态取色器，这里把取色替身换成「取消」）
    page._pick_color = lambda title, current: None
    page._controls[("display", "bg_color")].clicked.emit()
    assert len(seen) >= 4, seen


def test_group_titles_and_hints_match_the_spec():
    page, _ = _page()
    assert page.group_title("display") == "显示"
    assert page.group_title("network") == "网络与服务"
    assert "未校准" in page.group_title("experimental")
    # 重启生效 / 未校准 由页面统一补成徽标，字段自己的 hint 只写「改了会发生什么」。
    assert page.hint_for(("provider", "max_concurrent")).endswith("重启后生效")
    assert page.hint_for(("server", "port")).endswith("重启后生效")
    assert page.hint_for(("display", "stroke")).startswith("给字加一圈黑边")
    for field in S.TUNING_FIELDS:
        hint = page.hint_for(field["path"])
        assert hint, field["path"]
        if field["uncalibrated"]:
            assert "未校准" in hint, field["path"]
        if field["restart"]:
            assert hint.endswith("重启后生效"), field["path"]


def test_no_credential_path_is_reachable_or_rendered():
    cfg = S.default_settings()
    cfg["provider"]["api_key"] = "sk-secret-do-not-render"
    page, _ = _page(cfg)
    for path in (("provider", "api_key"), ("provider", "base_url"), ("provider", "model"),
                 ("provider", "protocol"), ("window", "w"), ("prompt", "active")):
        try:
            page.set_field_value(path, "x")
        except KeyError:
            continue
        raise AssertionError("%r must not be settable from the tuning page" % (path,))
    for widget in page.findChildren(QtWidgets.QWidget):
        text = getattr(widget, "text", None)
        if callable(text):
            assert "sk-secret-do-not-render" not in (text() or "")
