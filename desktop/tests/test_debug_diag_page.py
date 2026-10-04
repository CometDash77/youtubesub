"""地图 #152 / 实施票 #158 -- 排障页（spec #162）。

真服务黑盒：起真 `WSServer` + 注入 `status_provider`，页面只消费 `Snapshot`
（页面自己不取数）。时钟注入成可推的假时钟，用来钉「连续失败超过约 10 秒清空
数值区」这条时间语义。只断言外部可观察行为：状态条文字与等级、分区行、复制
文本、事件顺序；不断言内部成员，也不读 QSS 颜色。
"""
import os
import queue
import socket
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtWidgets

from suboverlay.debug_probe import Snapshot, fetch_status
from suboverlay.debug_diag_page import DiagPage
from suboverlay.server import WSServer

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])

PORT = 9877

PAYLOAD = {
    "ok": True, "version": 1,
    "stats": {"frames": 12, "bad_frames": 1, "error": ""},
    "state": "ok", "orig": "hello", "trans": "你好",
    "trans_state": "ready", "trans_available": True,
    "playing": True, "rate": 1.0, "title": "Demo",
    "sources": 1, "active_source": "src-1",
    "mode": "bilingual", "order": "trans_first",
    "history": [["hello", "你好"]], "click_through": False,
    "hook_error": "", "capture_error": "", "video_description": "",
}


def _free_port():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _real_server(port, provider):
    server = WSServer(port, queue.Queue(), status_provider=provider)
    server.start()
    return server


class Clock:
    def __init__(self, t=1000.0):
        self.t = float(t)

    def __call__(self):
        return self.t

    def set(self, t):
        self.t = float(t)

    def advance(self, dt):
        self.t += float(dt)


class FakePoller:
    def __init__(self):
        self.interval = 1.0
        self.starts = 0
        self.stops = 0
        self.refreshes = 0

    def start(self):
        self.starts += 1

    def stop(self):
        self.stops += 1

    def set_interval(self, seconds):
        self.interval = float(seconds)

    def refresh_now(self):
        self.refreshes += 1


def _page(clock=None, poller=None):
    return DiagPage(PORT, poller=poller if poller is not None else FakePoller(),
                    clock=clock or Clock())


def _rows(page, zone):
    return dict(page.zone_rows(zone))


# ---- 渲染：通 ----

def test_success_renders_the_four_zones_and_the_green_bar():
    page = _page()
    page.apply(Snapshot(True, data=PAYLOAD))
    assert page.status_bar_level() == "ok"
    assert page.status_bar_text() == "已连接 127.0.0.1:9877"
    assert page.zones_stale() is False
    link = _rows(page, "link")
    assert link["服务"] == "已连接 127.0.0.1:9877"
    assert link["累计帧数"] == "12"
    assert link["坏帧数"] == "1"
    assert "服务端错误" not in link
    assert link["来源数"] == "1"
    assert link["活跃来源"] == "src-1"
    play = _rows(page, "playback")
    assert play["字幕状态"] == "ok"
    assert play["标题"] == "Demo"
    assert play["在播"] == "是"
    assert play["倍速"] == "1"
    assert play["显示模式"] == "bilingual"
    assert play["显示顺序"] == "trans_first"
    assert play["原文"] == "hello"
    assert play["译文"] == "你好"
    assert play["点击穿透"] == "否"
    assert "页面钩子" not in play and "字幕抓取" not in play
    queue_rows = _rows(page, "queue")
    assert queue_rows["可翻译"] == "是"
    assert queue_rows["翻译态"] == "ready"
    assert "连通测试" not in " ".join(queue_rows)
    assert page.zone_badge("link") == ("正常", "ok")
    assert page.zone_badge("playback") == ("正常", "ok")
    assert page.zone_badge("queue") == ("ready", "ok")


def test_service_side_problems_are_shown_and_mark_the_bar_warn():
    payload = dict(PAYLOAD)
    payload["stats"] = {"frames": 3, "bad_frames": 0, "error": "startup boom"}
    payload["hook_error"] = "page hook NOT installed"
    payload["capture_error"] = "caption response was empty (status 200)"
    payload["trans_state"] = "failed:timeout"
    page = _page()
    page.apply(Snapshot(True, data=payload))
    assert page.status_bar_level() == "warn"
    link = _rows(page, "link")
    assert link["服务端错误"] == "startup boom"
    play = _rows(page, "playback")
    assert play["页面钩子"] == "page hook NOT installed"
    assert play["字幕抓取"] == "caption response was empty (status 200)"
    assert _rows(page, "queue")["翻译态"] == "failed:timeout"
    assert page.zone_badge("link") == ("有错误", "warn")
    assert page.zone_badge("playback") == ("注意", "warn")
    assert page.zone_badge("queue") == ("failed:timeout", "error")


def test_bad_keys_never_show_up_as_rows():
    payload = dict(PAYLOAD)
    payload.update({"queue_depth": 3, "in_flight": 2, "in_backoff": True,
                    "cache_hit_rate": 0.5, "cache_entries": 9,
                    "cache_db_bytes": 1024, "connections": 2,
                    "last_frame_age_ms": 12})
    page = _page()
    page.apply(Snapshot(True, data=payload))
    text = " ".join("%s=%s" % row for row in
                    page.zone_rows("link") + page.zone_rows("playback")
                    + page.zone_rows("queue"))
    for token in sorted(payload):
        if token in ("ok", "version", "stats", "state", "orig", "trans",
                     "trans_state", "trans_available", "playing", "rate", "title",
                     "sources", "active_source", "mode", "order", "click_through",
                     "hook_error", "capture_error"):
            continue
        assert token not in text, token
    for label in ("排队", "在途", "退避", "缓存", "连接数", "收帧龄", "按来源"):
        assert label not in text, label


# ---- 呈现：不通 ----

def test_failure_reports_the_port_the_age_and_greys_the_old_values():
    clock = Clock(1000.0)
    page = _page(clock=clock)
    page.apply(Snapshot(True, data=PAYLOAD, at=999.0))
    clock.set(1030.0)
    page.apply(Snapshot(False, error="ConnectionRefusedError", at=1030.0))
    assert page.status_bar_level() == "error"
    text = page.status_bar_text()
    assert "连不上" in text
    assert "9877" in text
    assert "上次成功" in text
    assert "30 秒前" in text
    assert page.zones_stale() is True
    assert _rows(page, "playback")["字幕状态"] == "ok", "灰化期间仍摆上次成功的值"
    assert page.zone_badge("playback") == ("不通", "error")


def test_failures_past_ten_seconds_clear_the_value_zones():
    clock = Clock(1000.0)
    page = _page(clock=clock)
    page.apply(Snapshot(True, data=PAYLOAD, at=1000.0))
    clock.set(1012.0)
    page.apply(Snapshot(False, error="timeout", at=1012.0))
    assert page.status_bar_level() == "error"
    assert page.zones_stale() is True, "第一拍失败：灰化上一拍的值"
    assert _rows(page, "playback")["译文"] == "你好"
    clock.set(1025.0)
    page.apply(Snapshot(False, error="timeout", at=1025.0))
    assert page.zone_rows("link") == []
    assert page.zone_rows("playback") == []
    assert page.zone_rows("queue") == []
    assert page.zones_stale() is False
    assert page.zone_rows("events") != [], "事件列表不是数值区，不清空"
    assert "上次成功" in page.status_bar_text()


def test_a_never_successful_page_shows_the_same_failure_presentation():
    clock = Clock(1000.0)
    page = _page(clock=clock)
    page.apply(Snapshot(False, error="ConnectionRefusedError", at=1000.0))
    assert page.status_bar_level() == "error"
    assert "连不上" in page.status_bar_text()
    assert page.zone_rows("playback") == []
    copy = page.copy_all_text()
    assert "连不上" in copy and "9877" in copy


def test_recovery_returns_to_ok_and_drops_the_stale_flag():
    clock = Clock(1000.0)
    page = _page(clock=clock)
    page.apply(Snapshot(True, data=PAYLOAD, at=1000.0))
    clock.set(1020.0)
    page.apply(Snapshot(False, error="timeout", at=1020.0))
    clock.set(1021.0)
    page.apply(Snapshot(True, data=PAYLOAD, at=1021.0))
    assert page.status_bar_level() == "ok"
    assert page.status_bar_text() == "已连接 127.0.0.1:9877"
    assert page.zones_stale() is False
    assert _rows(page, "playback")["译文"] == "你好"


# ---- 事件列表 ----

def test_events_are_newest_first_under_the_capability_banner():
    clock = Clock(1000.0)
    page = _page(clock=clock)
    page.apply(Snapshot(True, data=PAYLOAD, at=1000.0))
    clock.set(1005.0)
    page.apply(Snapshot(False, error="timeout", at=1005.0))
    clock.set(1009.0)
    grown = dict(PAYLOAD)
    grown["stats"] = dict(PAYLOAD["stats"], frames=13)
    page.apply(Snapshot(True, data=grown, at=1009.0))
    rows = page.zone_rows("events")
    assert "此前事件未记录" in rows[0][1]
    assert "取数恢复" in rows[1][1] and "(+9s)" in rows[1][0]
    assert "取数失败" in rows[2][1] and "(+5s)" in rows[2][0]


# ---- 复制 ----

def test_copy_all_is_plain_text_one_row_per_line():
    page = _page()
    page.apply(Snapshot(True, data=PAYLOAD))
    text = page.copy_all_text()
    lines = text.splitlines()
    assert lines[0].startswith("调试页")
    assert "复制于" in lines[0]
    assert all(line.strip() for line in lines)
    assert "累计帧数: 12" in lines
    assert "译文: 你好" in lines
    assert "连通测试" not in text, "折叠时不该出现在复制文本里"


def test_connection_test_is_collapsed_until_asked_for():
    payload = dict(PAYLOAD)
    payload["connection_test"] = {
        "verdict": "pass", "layers": [
            {"id": "L1", "title": "配置", "passed": True, "code": "", "message": "ok",
             "elapsed_ms": 1},
            {"id": "L4", "title": "模型", "passed": False, "code": "HTTP_401",
             "message": "unauthorized", "elapsed_ms": 12}],
        "attempts": 2, "warnings": ["MOCK_MASKS_REAL_CONFIG"],
        "warning_messages": {"MOCK_MASKS_REAL_CONFIG": "Mock 掩盖了真实配置"},
        "skipped": ["L3"], "duration_ms": 30}
    page = _page()
    page.apply(Snapshot(True, data=payload))
    assert page.connection_test_expanded() is False
    assert "连通测试" not in " ".join(_rows(page, "queue"))
    page.set_connection_test_expanded(True)
    rows = _rows(page, "queue")
    assert rows["连通测试结论"] == "PASS"
    assert rows["层 L4"] == "FAIL [HTTP_401] unauthorized (12 毫秒)"
    assert rows["跳过"] == "L3"
    assert rows["警告"] == "Mock 掩盖了真实配置"
    assert "连通测试" in page.copy_all_text()
    page.set_connection_test_expanded(False)
    assert "连通测试" not in page.copy_all_text()


def test_copy_carries_the_events_and_the_failure_age():
    clock = Clock(1000.0)
    page = _page(clock=clock)
    page.apply(Snapshot(True, data=PAYLOAD, at=1000.0))
    clock.set(1011.0)
    page.apply(Snapshot(False, error="timeout", at=1011.0))
    text = page.copy_all_text()
    assert "连不上" in text
    assert "上次成功" in text and "11 秒前" in text
    assert "取数失败" in text


# ---- 按钮与频率 ----

def test_frequency_gears_and_manual_refresh_go_through_the_poller():
    poller = FakePoller()
    page = _page(poller=poller)
    page.set_frequency(0.5)
    assert poller.interval == 0.5
    page.set_frequency(6)
    assert poller.interval == 2.0
    page.set_frequency(0.7)
    assert poller.interval == 0.5
    assert page.frequency() == 0.5
    page.refresh_button.click()
    assert poller.refreshes == 1
    assert page.copy_button.text() == "复制全部"


def test_copy_button_puts_the_text_on_the_clipboard():
    page = _page()
    page.apply(Snapshot(True, data=PAYLOAD))
    QtWidgets.QApplication.clipboard().setText("sentinel")
    page.copy_button.click()
    assert "译文: 你好" in QtWidgets.QApplication.clipboard().text()


# ---- 真服务黑盒 ----

def test_against_a_real_server_and_its_shutdown():
    port = _free_port()
    provider = {"state": "ok", "orig": "hi", "trans": "你好", "trans_state": "ready",
                "trans_available": True, "playing": True, "rate": 1.0, "title": "Demo",
                "sources": 1, "active_source": "s1", "mode": "trans", "order": "orig_first",
                "click_through": False}
    server = _real_server(port, lambda: dict(provider))
    clock = Clock(1000.0)
    page = DiagPage(port, poller=FakePoller(), clock=clock)
    try:
        snapshot = fetch_status(port)
        assert snapshot.ok, snapshot.error
        page.apply(snapshot)
        assert page.status_bar_level() == "ok"
        assert page.status_bar_text() == "已连接 127.0.0.1:%d" % port
        link = _rows(page, "link")
        assert link["累计帧数"] == "0" and link["坏帧数"] == "0"
        assert _rows(page, "playback")["显示模式"] == "trans"
    finally:
        server.stop()
    page.apply(fetch_status(port, timeout=1.0))
    assert page.status_bar_level() == "error"
    assert _rows(page, "playback")["译文"] == "你好", "第一拍失败仍摆上一拍的值"
    clock.set(clock() + 20.0)
    page.apply(fetch_status(port, timeout=1.0))
    assert page.status_bar_level() == "error"
    assert page.zone_rows("playback") == []
    server = _real_server(port, lambda: dict(provider))
    try:
        page.apply(fetch_status(port, timeout=1.0))
        assert page.status_bar_level() == "ok"
        assert _rows(page, "playback")["译文"] == "你好"
    finally:
        server.stop()


def test_the_default_page_does_not_block_on_a_stalling_read():
    """取数在池线程上跑（`_ProbeTask`）：对端挂起时要等满 2 秒超时，
    这 2 秒绝不许压在主线程上（真机上关掉服务后每拍都会冻 GUI）。"""
    import time

    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)                     # 握手能成，但永不回话
    port = server.getsockname()[1]
    page = DiagPage(port)
    try:
        started = time.monotonic()
        page.start()
        assert time.monotonic() - started < 0.5, "start() 不该等满取数超时"

        deadline = started + 4.0
        while time.monotonic() < deadline and page.status_bar_level() != "error":
            QtWidgets.QApplication.processEvents()
            time.sleep(0.02)
        assert page.status_bar_level() == "error", "超时结果必须照样回到页面"
    finally:
        page.stop()
        server.close()
