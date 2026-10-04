"""地图 #152 / 实施票 #158 -- 单发自续取数调度（spec #162 决策 6 + 测试缝 3）。

不起真服务、不碰 Qt 事件循环：调度函数被注入，测试手动扣扳机。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from suboverlay import debug_probe as PR
from suboverlay.debug_poller import StatusPoller


def _harness(fetch=None):
    """Returns (poller, state) with a manual timer queue and a result log."""
    state = {"timers": [], "delays": [], "results": [], "calls": []}

    def schedule(delay, callback):
        state["delays"].append(delay)
        state["timers"].append(callback)

    def default_fetch():
        state["calls"].append(1)
        return PR.Snapshot(True, data={"state": "ok"})

    poller = StatusPoller(fetch or default_fetch, state["results"].append, schedule)
    return poller, state


def test_start_fetches_immediately_then_rearms_once_per_cycle():
    poller, state = _harness()
    poller.start()
    assert len(state["calls"]) == 1
    assert len(state["results"]) == 1 and state["results"][0].ok is True
    assert len(state["timers"]) == 1 and state["delays"] == [1.0]

    state["timers"][0]()
    assert len(state["calls"]) == 2
    assert len(state["timers"]) == 2, "每一拍结束才排下一拍，不许叠加"


def test_stop_keeps_a_leftover_timer_from_fetching_again():
    poller, state = _harness()
    poller.start()
    poller.stop()
    state["timers"][0]()
    assert len(state["calls"]) == 1
    assert len(state["timers"]) == 1


def test_set_interval_applies_to_the_next_cycle():
    poller, state = _harness()
    poller.start()
    poller.set_interval(2.0)
    state["timers"][0]()
    assert state["delays"] == [1.0, 2.0]
    poller.set_interval(0.5)
    state["timers"][1]()
    assert state["delays"] == [1.0, 2.0, 0.5]


def test_refresh_now_during_a_flight_queues_one_more_cycle_without_stacking():
    calls, active, peak = [], [0], [0]
    holder = {}

    def fetch():
        active[0] += 1
        peak[0] = max(peak[0], active[0])
        try:
            calls.append(1)
            if len(calls) == 1:
                holder["poller"].refresh_now()     # 飞行中又点了「立即刷新」
            return PR.Snapshot(True, data={})
        finally:
            active[0] -= 1

    poller, state = _harness(fetch)
    holder["poller"] = poller
    poller.start()
    assert peak[0] == 1, "并发度必须恒为 1"
    assert len(calls) == 2, "补一拍，但不叠加"
    assert len(state["timers"]) == 1


def test_a_failing_fetch_becomes_a_failure_result_and_the_cycle_continues():
    def boom():
        raise ConnectionRefusedError()

    poller, state = _harness(boom)
    poller.start()
    result = state["results"][0]
    assert result.ok is False and result.data is None and "ConnectionRefused" in result.error
    assert len(state["timers"]) == 1, "失败也要继续自续"
    state["timers"][0]()
    assert len(state["results"]) == 2


def test_refresh_now_before_start_does_nothing():
    poller, state = _harness()
    poller.refresh_now()
    assert state["calls"] == [] and state["timers"] == []


def test_start_is_idempotent():
    poller, state = _harness()
    poller.start()
    poller.start()
    assert len(state["calls"]) == 1
    assert len(state["timers"]) == 1


def test_in_flight_is_false_between_cycles():
    poller, state = _harness()
    poller.start()
    assert poller.in_flight is False


def test_a_deferred_fetch_waits_for_report_instead_of_faking_a_result():
    """异步取数：`fetch` 返回 DEFERRED 时不许当成结果，也不许提前排下一拍。"""
    from suboverlay.debug_poller import DEFERRED

    poller, state = _harness(fetch=lambda: DEFERRED)
    poller.start()
    assert state["results"] == [] and state["timers"] == []
    assert poller.in_flight is True, "在途标记必须留到 report 才落"

    poller.report(PR.Snapshot(True, data={"state": "ok"}))
    assert len(state["results"]) == 1 and len(state["timers"]) == 1
    assert poller.in_flight is False


def test_refresh_now_while_deferred_queues_exactly_one_extra_cycle():
    from suboverlay.debug_poller import DEFERRED

    kicks = []

    def fetch():
        kicks.append(1)
        return DEFERRED

    poller, state = _harness(fetch=fetch)
    poller.start()
    poller.refresh_now()
    poller.refresh_now()
    assert kicks == [1], "在途时不许再起一拍（两次刷新只记一次账）"

    poller.report(PR.Snapshot(False, error="TimeoutError"))
    assert len(state["results"]) == 1, "report 先按结果渲染"
    assert kicks == [1, 1], "补的那一拍立刻起读"
    assert state["timers"] == [], "补拍还在途，先不排定时器"


def test_a_deferred_fetch_after_stop_does_not_rearm():
    from suboverlay.debug_poller import DEFERRED

    poller, state = _harness(fetch=lambda: DEFERRED)
    poller.start()
    poller.stop()
    poller.report(PR.Snapshot(True, data={}))
    assert state["timers"] == [], "关窗后到的结果不许再排下一拍"


def test_a_second_report_for_the_same_cycle_is_ignored():
    """重复/迟到的一次结果不许再渲染一遍、也不许叠出第二条定时链。"""
    from suboverlay.debug_poller import DEFERRED

    poller, state = _harness(fetch=lambda: DEFERRED)
    poller.start()
    poller.report(PR.Snapshot(True, data={}))
    assert len(state["results"]) == 1 and len(state["timers"]) == 1

    poller.report(PR.Snapshot(True, data={}))
    assert len(state["results"]) == 1, "同一拍只渲染一次"
    assert len(state["timers"]) == 1, "也不许多排一拍"
