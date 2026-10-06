"""地图 #152 / 实施票 #158 -- 调试窗口外壳与菜单入口。

App 需要真实 settings 文件，照 `test_app_lifecycle.py` 的既有手法用 monkeypatch
把 `S.load` 指向临时的默认配置（并给一个空闲端口，免得真占 9877）。
"""
import os
import re
import socket
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtCore, QtGui, QtWidgets

from app import App
from suboverlay import debug_tokens as TOKENS
from suboverlay import settings as S
from suboverlay.debug_window import SHADOW_MARGIN, DebugWindow

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


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


def test_menu_offers_the_debug_entries_and_reuses_one_window(tmp_path, monkeypatch):
    instance = _app(tmp_path, monkeypatch)
    try:
        actions = _menu(instance)
        assert "调试……" in actions, sorted(actions)
        # 2026-10-03：菜单不再暴露「重读设置」—— 它只把内存里的 display.mode /
        # order 同步给浮窗，而那两条路径（调参页确定、浮窗自身的 cycle/swap）都已
        # 自动重读，留着只会与「调试……」重复（见票「浮窗菜单去重」）。
        assert "重读设置" not in actions, sorted(actions)
        # #172：菜单不许再留英文条目。这里钉的是浮窗右键 / 托盘共用的那一份
        # QMenu 上的**全部**可见文案（含 #164 范围内的「设置……」「调试……」）。
        non_chinese = [t for t in actions if t and not re.search(r"[\u4e00-\u9fff]", t)]
        assert non_chinese == [], "菜单条目还有英文: %s" % non_chinese
        actions["调试……"].trigger()
        window = instance.debug_window
        assert window is not None
        assert window.isVisible()
        assert window.current_page_name() == "tuning"
        actions["调试……"].trigger()
        assert instance.debug_window is window, "关闭/再次打开必须复用同一实例"
        assert window.isVisible()
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
    （托盘与浮窗共用同一份 QMenu，见 app.py:444 / :448）。"""
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


def test_the_shell_is_a_modeless_tool_window_with_two_pages():
    window = DebugWindow(S.default_settings(), port=1)
    try:
        assert window.isModal() is False
        assert window.parent() is None
        assert window.windowFlags() & QtCore.Qt.Tool
        assert window.current_page_name() == "tuning"
        assert window.stack.currentWidget() is window.tuning_page
        window.show_page("diag")
        assert window.current_page_name() == "diag"
        assert window.stack.currentWidget() is window.diag_page
        window.show_page("tuning")
        assert window.current_page_name() == "tuning"
        assert window.stack.currentWidget() is window.tuning_page
    finally:
        window.close()


def test_the_close_affordance_hides_the_frameless_window():
    window = DebugWindow(S.default_settings(), port=1)
    window.show()
    assert window.isVisible()
    window.close_button.click()
    assert not window.isVisible()
    window.close()


def test_the_window_paints_the_documented_opaque_chrome():
    """外层 = **不透明**奶油底 + 24 圆角 + 1px 内描边 + 48px 柔阴影，内层卡片保留
    （用户 2026-10-03 裁定：外层的透明毛玻璃效果没有必要，视觉结构交给内层卡片）。"""
    import re

    window = DebugWindow(S.default_settings(), port=1)
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
    window = DebugWindow(S.default_settings(), port=1)
    window.show_page("diag")
    window.show()
    window.close()
    assert not window.isVisible()
    window.show_page("tuning")
    window.show()
    assert window.isVisible()
    assert window.current_page_name() == "tuning"
    window.close()


def test_the_tuning_page_saves_through_the_real_settings_object(tmp_path, monkeypatch):
    """装配正确性：窗口里的调参页写的必须是同一份 settings（不是副本）。"""
    settings = S.default_settings()
    saved = []
    monkeypatch.setattr(S, "save", lambda cfg, path=None: saved.append(dict(cfg)))
    window = DebugWindow(settings, port=1)
    try:
        window.tuning_page.set_field_value(("prefetch", "lead_s"), 30.0)
        window.tuning_page.ok()
        assert settings["prefetch"]["lead_s"] == 30.0
        assert len(saved) == 1
    finally:
        window.close()
