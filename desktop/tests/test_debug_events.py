"""地图 #152 / 实施票 #158 -- 事件留痕记录器（spec #162 决策 2/3 + D3）。

只记**翻转**，不记每拍数值；200 条或 30 分钟先到者为限；内存环形、不落盘。
全部用显式时间戳驱动，不碰真实时钟。
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from suboverlay import debug_events as EV
from suboverlay import debug_probe as PR

T0 = 1_700_000_000.0


_frames = [0]


def snap(**over):
    """A healthy read. `frames` grows on every call unless a test pins it, so
    only the tests that care about stalling ever see a stall."""
    _frames[0] += 1
    data = {"state": "ok", "trans_state": "idle", "hook_error": "", "capture_error": "",
            "stats": {"frames": _frames[0], "bad_frames": 0, "error": None}}
    data.update(over)
    return PR.Snapshot(True, data=data)


def failure():
    return PR.Snapshot(False, error="ConnectionRefusedError")


def kinds(events):
    return [e["kind"] for e in events]


def test_first_successful_read_records_nothing():
    rec = EV.EventRecorder(T0)
    assert rec.observe(snap(), T0) == []
    assert rec.events() == []


def test_records_state_and_trans_state_flips_without_repeats():
    rec = EV.EventRecorder(T0)
    rec.observe(snap(), T0)
    assert kinds(rec.observe(snap(state="no_cues"), T0 + 1)) == ["state"]
    assert rec.observe(snap(state="no_cues"), T0 + 2) == []
    assert kinds(rec.observe(snap(state="no_cues", trans_state="translating"), T0 + 3)) == \
        ["trans_state"]


def test_records_error_appearance_and_recovery():
    rec = EV.EventRecorder(T0)
    rec.observe(snap(), T0)
    assert kinds(rec.observe(snap(hook_error="boom"), T0 + 1)) == ["hook_error"]
    assert rec.observe(snap(hook_error="boom"), T0 + 2) == []
    assert kinds(rec.observe(snap(hook_error=""), T0 + 3)) == ["hook_error"]
    assert kinds(rec.observe(snap(capture_error="caption empty"), T0 + 4)) == ["capture_error"]
    assert kinds(rec.observe(snap(capture_error=""), T0 + 5)) == ["capture_error"]


def test_records_fetch_failure_and_recovery():
    rec = EV.EventRecorder(T0)
    assert kinds(rec.observe(failure(), T0)) == ["fetch"]
    assert rec.observe(failure(), T0 + 1) == []
    assert kinds(rec.observe(snap(), T0 + 2)) == ["fetch"]
    assert rec.observe(snap(), T0 + 3) == []


def test_frames_stall_needs_no_growth_and_ok_state():
    rec = EV.EventRecorder(T0)
    rec.observe(snap(stats={"frames": 10, "bad_frames": 0, "error": None}), T0)
    assert kinds(rec.observe(snap(stats={"frames": 10, "bad_frames": 0, "error": None}),
                             T0 + 1)) == ["frames_stall"]
    assert rec.observe(snap(stats={"frames": 10, "bad_frames": 0, "error": None}), T0 + 2) == []
    assert rec.observe(snap(stats={"frames": 12, "bad_frames": 0, "error": None}), T0 + 3) == []
    assert kinds(rec.observe(snap(stats={"frames": 12, "bad_frames": 0, "error": None}),
                             T0 + 4)) == ["frames_stall"]
    assert kinds(rec.observe(snap(state="no_cues",
                                  stats={"frames": 12, "bad_frames": 0, "error": None}),
                             T0 + 5)) == ["state"]


def test_events_are_newest_first_with_wall_clock_and_relative_seconds():
    rec = EV.EventRecorder(T0)
    rec.observe(snap(), T0)
    rec.observe(snap(state="no_cues"), T0 + 5)
    rec.observe(snap(state="ok"), T0 + 42)
    events = rec.events()
    assert kinds(events) == ["state", "state"]
    assert events[0]["rel"] == 42 and events[1]["rel"] == 5
    assert re.match(r"^\d{2}:\d{2}:\d{2}$", events[0]["time"]), events[0]["time"]
    assert events[0]["text"] and events[1]["text"]
    assert "no_cues" in events[0]["text"] and "ok" in events[0]["text"]


def test_capacity_keeps_the_newest_200():
    rec = EV.EventRecorder(T0, capacity=3)
    rec.observe(snap(), T0)
    for i in range(5):
        rec.observe(snap(state="s%d" % i), T0 + 1 + i)
    events = rec.events()
    assert len(events) == 3
    assert [e["rel"] for e in events] == [5, 4, 3]


def test_thirty_minute_window_drops_older_events():
    rec = EV.EventRecorder(T0)
    rec.observe(snap(), T0)
    rec.observe(snap(state="no_cues"), T0 + 1)
    assert kinds(rec.events()) == ["state"]
    assert kinds(rec.observe(snap(state="ok"), T0 + 2000)) == ["state"]
    assert [e["rel"] for e in rec.events()] == [2000]


def test_opened_label_is_the_documented_wording():
    rec = EV.EventRecorder(T0)
    label = rec.opened_label()
    assert label.startswith("本页打开于 ") and label.endswith("，此前事件未记录")
    assert re.search(r"\d{2}:\d{2}:\d{2}", label)


def test_every_event_carries_kind_time_rel_text():
    rec = EV.EventRecorder(T0)
    rec.observe(snap(), T0)
    rec.observe(snap(hook_error="boom"), T0 + 7)
    event = rec.events()[0]
    assert set(event) == {"at", "time", "rel", "kind", "text"}
    assert event["kind"] == "hook_error" and event["at"] == T0 + 7 and event["rel"] == 7
