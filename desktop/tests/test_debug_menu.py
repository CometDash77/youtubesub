"""地图 #152 / 实施票 #158 → #164 / #170：设置与调试窗口（三页）与菜单入口。

App 需要真实 settings 文件，照 `test_app_lifecycle.py` 的既有手法用 monkeypatch
把 `S.load` 指向临时的默认配置（并给一个空闲端口，免得真占 9877）。
"""
import json
import os
import pytest
import re
import socket
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtCore, QtGui, QtWidgets

import suboverlay.debug_window as dw_mod
from app import App
from suboverlay import debug_tokens as TOKENS
from suboverlay import settings as S
from suboverlay.debug_window import (CONFIRM_DISCARD, CONFIRM_SAVE, CONFIRM_STAY,
                                     SHADOW_MARGIN, DebugWindow)

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


@pytest.fixture(autouse=True)
def _never_block_on_the_modal_close_prompt(monkeypatch):
    """关窗提示是真模态的：整份用例默认把它换掉（选「不保存，直接关闭」），
    否则任何用例收尾时的 `close()` 一碰到脏状态就会在 offscreen 里挂死。
    要测提示本身（三分支）的用例在自己的用例体里再覆盖一次即可。"""
    monkeypatch.setattr(dw_mod, "_ask_unsaved_changes", _answer(CONFIRM_DISCARD))


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _app(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    settings = S.default_settings()
    settings["server"]["port"] = _free_port()
    monkeypatch.setattr(S, "load", lambda: settings)
    return App()


def _menu(app):
    return {action.text(): action for action in app.overlay._ctx_menu.actions()}


def _window(settings=None):
    """一个窗口 + 写盘替身（整窗保存只该写一次，替身用来数次数）。"""
    writes = []
    settings = settings if settings is not None else S.default_settings()
    window = DebugWindow(settings, port=1,
                         save=lambda cfg, path=None: writes.append(cfg))
    return window, settings, writes


def _answer(choice, seen=None):
    def fake(parent, settings_dirty=False, tuning_dirty=False):
        if seen is not None:
            seen.append((settings_dirty, tuning_dirty))
        return choice
    return fake


def test_menu_offers_both_entries_and_they_land_on_different_pages(tmp_path, monkeypatch):
    instance = _app(tmp_path, monkeypatch)
    try:
        actions = _menu(instance)
        assert "设置……" in actions and "调试……" in actions, sorted(actions)
        # 2026-10-03：菜单不再暴露「重读设置」—— 它只把内存里的 display.mode /
        # order 同步给浮窗，而那两条路径（调参页确定、浮窗自身的 cycle/swap）都已
        # 自动重读，留着只会与「调试……」重复（见票「浮窗菜单去重」）。
        assert "重读设置" not in actions, sorted(actions)
        # #172：菜单不许再留英文条目。这里钉的是浮窗右键 / 托盘共用的那一份
        # QMenu 上的**全部**可见文案。
        non_chinese = [t for t in actions if t and not re.search(r"[\u4e00-\u9fff]", t)]
        assert non_chinese == [], "菜单条目还有英文: %s" % non_chinese

        actions["调试……"].trigger()
        window = instance.debug_window
        assert window is not None and window.isVisible()
        assert window.current_page_name() == "tuning"
        assert window.isModal() is False

        # 第二个入口打开的是**同一个**窗口，只是落到设置页（#164 目标）。
        actions["设置……"].trigger()
        assert instance.debug_window is window, "两个入口必须复用同一实例"
        assert window.current_page_name() == "settings"
        assert window.stack.currentWidget() is window.settings_page
    finally:
        if instance.debug_window is not None:
            instance.debug_window.close()
        instance.overlay.close()
        instance.engine._queue.shutdown()


def test_every_menu_label_says_what_it_changes(tmp_path, monkeypatch):
    """#172：菜单文案要能自解释（换日常词 + 一句「点一下会怎样」），并且
    「鼠标穿透」在开 / 关两种状态下的说法都要对。

    这张用例守住三件事：菜单里没有纯英文条目；开关状态的文案互不相同且都带
    解锁键位；`Quit` 的文案改成中文之后仍然只有一颗、仍然真的结束事件循环
    （托盘与浮窗共用同一份 QMenu）。"""
    instance = _app(tmp_path, monkeypatch)
    try:
        labels = [action.text() for action in instance.overlay._ctx_menu.actions()
                  if action.text()]
        assert labels, "菜单不能是空的"
        assert all(re.search(r"[\u4e00-\u9fff]", t) for t in labels), labels
        # 每条都要说清楚点下去会怎样，不是光换个名词（「设置……」这类入口除外，
        # 它开的是窗口，本来就是名词）。
        for t in labels:
            if t.endswith("……"):
                continue
            assert any(word in t for word in ("调", "换", "显示", "顺序", "穿", "隐藏", "退出")), t

        off = instance._ct_action.text()
        assert "鼠标穿透" in off and "Ctrl+Alt+U" in off
        instance._set_click_through(True)
        on = instance._ct_action.text()
        assert "已开启" in on and "Ctrl+Alt+U" in on
        assert on != off, "开 / 关两种状态必须能一眼区分"
        instance._set_click_through(False)
        assert instance._ct_action.text() == off, "关掉之后要回到原来的说法"

        quits = [a for a in instance.overlay._ctx_menu.actions() if a.text() == "退出程序"]
        assert len(quits) == 1, [a.text() for a in instance.overlay._ctx_menu.actions()]
    finally:
        if instance.debug_window is not None:
            instance.debug_window.close()
        instance.overlay.close()
        instance.engine._queue.shutdown()


def test_the_shell_is_a_modeless_tool_window_with_three_pages():
    window, _, _ = _window()
    try:
        assert window.isModal() is False
        assert window.parent() is None
        assert window.windowFlags() & QtCore.Qt.Tool
        assert window.windowTitle() == "设置与调试"
        assert window.current_page_name() == "tuning"
        assert window.stack.currentWidget() is window.tuning_page
        for name, page in (("settings", window.settings_page),
                           ("diag", window.diag_page),
                           ("tuning", window.tuning_page)):
            window.show_page(name)
            assert window.current_page_name() == name
            assert window.stack.currentWidget() is page
        assert [(dw_mod.PAGE_TITLES[name]) for name in dw_mod.PAGES] == \
            ["设置", "调参", "排障"]
        assert dw_mod.PAGES == ("settings", "tuning", "diag")
        try:
            window.show_page("nope")
        except KeyError:
            pass
        else:
            raise AssertionError("未知页名必须 KeyError")
    finally:
        window.close()


def test_switching_pages_keeps_the_uncommitted_edits():
    """#169 断言 ②：三页是同一个 QStackedWidget 的常驻子控件，切页只改 index ——
    未提交的编辑天然留着，不为「保留」写代码（页签也不标脏点）。"""
    window, _, writes = _window()
    try:
        window.show()
        window.show_page("tuning")
        window.tuning_page.set_field_value(("display", "history_lines"), 5)
        window.settings_page.model.setText("gpt-kept")
        assert window.dirty_counts() == (1, 1)

        window.show_page("settings")
        assert window.settings_page.model.text() == "gpt-kept"
        window.show_page("diag")
        window.show_page("tuning")
        assert window.tuning_page.field_value(("display", "history_lines")) == 5
        assert window.is_dirty() is True, "切页不该把编辑弄丢（也不该弄脏）"
        assert writes == []
    finally:
        window.close()


def test_the_close_affordance_hides_the_frameless_window():
    window, _, _ = _window()
    window.show()
    assert window.isVisible()
    window.close_button.click()
    assert not window.isVisible()
    window.close()


def test_the_window_paints_the_documented_opaque_chrome():
    """外层 = **不透明**奶油底 + 24 圆角 + 1px 内描边 + 48px 柔阴影，内层卡片保留
    （用户 2026-10-03 裁定：外层的透明毛玻璃效果没有必要，视觉结构交给内层卡片）。"""
    window, _, _ = _window()
    try:
        sheet = window.styleSheet()
        block = re.search(r"QFrame#debugWindow\s*\{([^}]*)\}", sheet)
        assert block, sheet
        block = block.group(1)
        rgba = re.search(r"rgba\(\s*\d+,\s*\d+,\s*\d+,\s*(\d+)\s*\)", block)
        assert rgba, block
        assert int(rgba.group(1)) == 255, "窗口底必须不透明：透明/磨砂配方已废"
        assert "border-radius: %dpx" % TOKENS.RADIUS in block
        assert re.search(r"border:\s*1px solid rgba\(\s*\d+,\s*\d+,\s*\d+,\s*\d+\s*\)",
                         block), "1px 内描边"
        assert window.panel.graphicsEffect() is not None, "柔阴影两版都留"
        assert window.layout().contentsMargins().left() == SHADOW_MARGIN, \
            "阴影需要边距，去掉就看不见了"

        card = re.search(r"QFrame#debugCard\s*\{([^}]*)\}", sheet)
        assert card and TOKENS.CARD in card.group(1), "内层卡片保留（它是唯一的分组面）"
        assert "border-radius: 12px" in card.group(1)

        # 渲染级断言：QSS 写在纸上不算数——库的 CardWidget 自己 paintEvent 画背景，
        # 会把 token 色顶掉（旧 bug，卡片与窗底同色等于没有卡片）。
        window.show_page("diag")
        window.resize(560, 420)
        window.show()
        _QAPP.processEvents()
        pix = window.grab().toImage().convertToFormat(QtGui.QImage.Format.Format_RGBA8888)
        assert pix.pixelColor(SHADOW_MARGIN + 4, window.height() // 2).alpha() == 255, \
            "窗口底必须真不透明：留白带那一点就是窗口底画的面"
        raw = bytes(pix.constBits())
        want = QtGui.QColor(TOKENS.CARD)
        want = (want.red(), want.green(), want.blue())
        hits = sum(1 for i in range(0, len(raw), 4) if tuple(raw[i:i + 3]) == want)
        assert hits > 1000, "内层卡片必须真的画成 token 色（命中 %d 像素）" % hits
    finally:
        window.close()


def test_the_window_is_reusable_after_closing():
    window, _, _ = _window()
    window.show_page("diag")
    window.show()
    window.close()
    assert not window.isVisible()
    window.show_page("tuning")
    window.show()
    assert window.isVisible()
    assert window.current_page_name() == "tuning"
    window.close()


def test_save_commits_both_pages_with_exactly_one_write():
    """#169 断言 ③：一次「保存」= 一次写盘，并让两页的改动都落下去。"""
    window, settings, writes = _window()
    try:
        assert window.save_button.isEnabled() is False
        assert window.status_label.text() == "没有未保存的改动"

        window.tuning_page.set_field_value(("prefetch", "lead_s"), 30.0)
        assert window.save_button.isEnabled() is True
        assert window.status_label.text() == "有 1 项改动没保存"
        window.settings_page.model.setText("gpt-test")
        assert window.status_label.text() == "有 2 项改动没保存"

        assert window.save() is True
        assert len(writes) == 1, "整窗提交只许写一次盘"
        assert settings["prefetch"]["lead_s"] == 30.0
        assert settings["provider"]["model"] == "gpt-test"
        assert window.is_dirty() is False
        assert window.save_button.isEnabled() is False
        assert window.status_label.text() == "没有未保存的改动"
    finally:
        window.close()


def test_save_without_edits_does_not_touch_the_file():
    window, _, writes = _window()
    try:
        assert window.save() is False
        assert writes == []
    finally:
        window.close()


def test_cancel_rolls_both_pages_back():
    window, settings, writes = _window()
    try:
        window.tuning_page.set_field_value(("display", "history_lines"), 9)
        window.settings_page.api_key.setText("sk-typo")
        assert window.is_dirty() is True
        window.cancel()
        assert window.is_dirty() is False
        assert window.tuning_page.field_value(("display", "history_lines")) == 2
        assert window.settings_page.api_key.text() == ""
        assert settings["display"]["history_lines"] == 2 and writes == []
    finally:
        window.close()


def test_the_tuning_page_saves_through_the_real_settings_object():
    """装配正确性：窗口里的调参页改的必须是同一份 settings（不是副本）。"""
    window, settings, writes = _window()
    try:
        window.tuning_page.set_field_value(("prefetch", "lead_s"), 30.0)
        window.save()
        assert settings["prefetch"]["lead_s"] == 30.0
        assert len(writes) == 1
        assert writes[0] is settings
    finally:
        window.close()


def test_footer_state_tracks_every_edit_in_both_pages():
    window, _, _ = _window()
    try:
        window.settings_page.base_url.setText("https://api.example.test/v1")
        assert window.status_label.text() == "有 1 项改动没保存"
        window.diag_page.set_frequency(2.0)
        assert window.status_label.text() == "有 1 项改动没保存", \
            "排障页不参与脏状态（它只是看，不落盘）"
        assert window.dirty_counts() == (1, 0)
    finally:
        window.close()


def test_ctrl_s_saves_without_closing_the_window():
    window, settings, writes = _window()
    try:
        window.show()
        window.tuning_page.set_field_value(("display", "history_lines"), 4)
        assert window._save_shortcut.key() == QtGui.QKeySequence(QtGui.QKeySequence.Save)
        window._save_shortcut.activated.emit()
        assert len(writes) == 1 and settings["display"]["history_lines"] == 4
        assert window.isVisible(), "Ctrl+S 只保存，不关窗（Esc 才是关窗）"
    finally:
        window.close()


def test_reopening_the_window_resnapshots_the_baseline():
    """#169 断言 ⑥：窗口关掉之后外部把盘上的值改了，再打开时基线要重新取，
    不能拿构造时那一份旧快照当基准。"""
    window, settings, _ = _window()
    try:
        window.show()
        window.close()
        settings["display"]["history_lines"] = 9      # 外部改动（模拟手改文件后重载）
        window.show()
        assert window.current_page_name() == "tuning"
        assert window.tuning_page.field_value(("display", "history_lines")) == 9
        assert window.is_dirty() is False, "重新打开 = 重新取基线"
    finally:
        window.close()


def test_closing_with_unsaved_changes_asks_first(monkeypatch):
    monkeypatch.setattr(dw_mod, "_ask_unsaved_changes", _answer(CONFIRM_STAY))
    window, settings, writes = _window()
    stops = []
    monkeypatch.setattr(window.diag_page, "stop", lambda: stops.append(True))
    try:
        window.show()
        window.settings_page.api_key.setText("sk-half-typed")
        window.close()
        assert window.isVisible(), "选「回去继续改」窗口必须留着"
        assert window.is_dirty() is True
        assert writes == [] and settings["provider"]["api_key"] == ""
        assert stops == [], "「回去继续改」什么都不停（排障页也不许停，否则成僵尸页）"
    finally:
        monkeypatch.setattr(dw_mod, "_ask_unsaved_changes", _answer(CONFIRM_DISCARD))
        window.close()


def test_closing_with_discard_throws_the_edits_away(monkeypatch):
    seen = []
    monkeypatch.setattr(dw_mod, "_ask_unsaved_changes",
                        _answer(CONFIRM_DISCARD, seen))
    window, settings, writes = _window()
    try:
        window.show()
        window.settings_page.api_key.setText("sk-half-typed")
        window.tuning_page.set_field_value(("prefetch", "lead_s"), 30.0)
        window.close()
        assert not window.isVisible()
        assert writes == [] and settings["provider"]["api_key"] == ""
        assert settings["prefetch"]["lead_s"] == 90.0
        assert window.is_dirty() is False, "放弃之后基线要重置"
        assert seen == [(True, True)], "两页都脏时弹窗要点名两页"
    finally:
        window.close()


def test_closing_with_save_writes_once_then_closes(monkeypatch):
    monkeypatch.setattr(dw_mod, "_ask_unsaved_changes", _answer(CONFIRM_SAVE))
    window, settings, writes = _window()
    try:
        window.show()
        window.tuning_page.set_field_value(("prefetch", "lead_s"), 30.0)
        window.settings_page.mock.setChecked(True)
        window.close()
        assert not window.isVisible()
        assert len(writes) == 1
        assert settings["prefetch"]["lead_s"] == 30.0
        assert settings["provider"]["mock"] is True
        assert window.is_dirty() is False
    finally:
        window.close()
