"""#180：窗口尺寸按屏幕收敛 + 三页滚动兜底。

改造前 `DebugWindow.resize(1120, 760)` 完全没生效：设置页的最小高度把窗口顶成
1120×1015，无边框窗口又没有尺寸抓手，矮屏上底部的「保存 / 取消」直接出屏。
这里钉住契约：窗口永远不超过「可用区域 - 边距」，页脚在滚动区之外，页内容装不下
时由外层滚动区兜底，滚到底能看见每页的最后一项。
"""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from PySide6 import QtCore, QtWidgets

import suboverlay.debug_window as dw_mod
from suboverlay import settings as S
from suboverlay.debug_window import (
    SCREEN_MARGIN,
    MIN_H,
    MIN_W,
    DebugWindow,
    fit_to_screen,
)

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])

# 验收点名的矮屏：1366×768 这类机器的可用高度就在这个量级。
SMALL_W, SMALL_H = 800, 800


@pytest.fixture(autouse=True)
def _never_block_on_the_modal_close_prompt(monkeypatch):
    monkeypatch.setattr(
        dw_mod,
        "_ask_unsaved_changes",
        lambda parent, settings_dirty=False, tuning_dirty=False: dw_mod.CONFIRM_DISCARD,
    )


def _window():
    return DebugWindow(S.default_settings(), port=1, save=lambda cfg, path=None: None)


def _process():
    _QAPP.processEvents()
    _QAPP.processEvents()


def _bottom_is_reachable(window, page, viewport):
    """页底部能不能看见：装得下就直接可见，装不下就得靠某个滚动区滚到底。"""
    if page.height() <= viewport.height():
        return True
    areas = [window.scroll] + page.findChildren(QtWidgets.QScrollArea)
    reached = viewport.mapTo(window, viewport.rect().bottomLeft()).y() + 1
    for area in areas:
        bar = area.verticalScrollBar()
        if bar.maximum() <= bar.minimum():
            continue
        bar.setValue(bar.maximum())
        _process()
        if page.mapTo(window, page.rect().bottomLeft()).y() <= reached:
            return True
    return False


def _shrink_to(window, avail_w=SMALL_W, avail_h=SMALL_H):
    window.fit_to_available(avail_w, avail_h)
    _process()


def test_fit_to_screen_never_exceeds_the_available_area():
    # 矮屏：按可用区域收敛，留出 SCREEN_MARGIN 的边距
    assert fit_to_screen(1120, 1015, 800, 800) == (800 - SCREEN_MARGIN, 800 - SCREEN_MARGIN)
    # 大屏：原样保留想要的尺寸，不放大
    assert fit_to_screen(1120, 1015, 1920, 1080) == (1120, 1015)
    # 屏小到装不下下限时退回下限，不缩成 0
    assert fit_to_screen(1120, 1015, 400, 400) == (MIN_W, MIN_H)
    for avail_w, avail_h in ((1920, 1080), (1366, 768), (1280, 720), (800, 800)):
        w, h = fit_to_screen(1120, 1015, avail_w, avail_h)
        assert w >= MIN_W and h >= MIN_H
        assert h <= max(MIN_H, avail_h - SCREEN_MARGIN)


def test_the_window_no_longer_forces_itself_taller_than_the_screen():
    """根因回归：以前布局把最小高度顶到 1015，再怎么写 resize 都救不回来。"""
    window = _window()
    try:
        window.show_page("settings")
        window.show()
        _process()
        # 设置页本身比矮屏高，所以超高内容确实存在，必须由滚动区接管
        assert window.stack.minimumSizeHint().height() > MIN_H
        assert window.minimumSizeHint().height() < SMALL_H - SCREEN_MARGIN
        assert window.findChild(QtWidgets.QScrollArea, "debugScroll") is window.scroll
        assert window.scroll.widget() is window.stack
        assert window.scroll.verticalScrollBarPolicy() != QtCore.Qt.ScrollBarAlwaysOff
    finally:
        window.close()


def test_the_footer_stays_on_screen_and_clickable_on_a_small_screen():
    window = _window()
    try:
        window.show_page("settings")
        window.show()
        _process()
        _shrink_to(window)
        assert window.height() <= SMALL_H - SCREEN_MARGIN
        assert window.width() <= SMALL_W - SCREEN_MARGIN
        # 页脚在滚动区之外：滚页内容不会把「保存 / 取消」滚走
        assert not window.scroll.isAncestorOf(window.save_button)
        assert not window.scroll.isAncestorOf(window.cancel_button)
        for button in (window.cancel_button, window.save_button):
            assert not button.visibleRegion().isEmpty(), button.text()
            bottom = button.mapTo(window, button.rect().bottomLeft()).y()
            assert 0 <= bottom <= window.height(), button.text()
        # 无边框窗口得给用户一个自己缩的手把
        assert not window.size_grip.visibleRegion().isEmpty()
    finally:
        window.close()


def test_every_page_can_be_scrolled_to_its_last_row():
    window = _window()
    try:
        window.show()
        _shrink_to(window)
        viewport = window.scroll.viewport()
        for name in ("settings", "tuning", "diag"):
            window.show_page(name)
            _process()
            assert _bottom_is_reachable(window, window.stack.currentWidget(), viewport), name
        # 设置页在矮屏上一定得靠外层滚动区才到底，滚到底后最后一项「测试连接」在窗口内
        window.show_page("settings")
        _process()
        bar = window.scroll.verticalScrollBar()
        assert bar.maximum() > bar.minimum()
        bar.setValue(bar.maximum())
        _process()
        button = window.settings_page.test_btn
        bottom = button.mapTo(window, button.rect().bottomLeft()).y()
        assert 0 <= bottom <= window.height()
    finally:
        window.close()
