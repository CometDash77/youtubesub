"""单发自续取数调度（spec #162 决策 6）。

**上一拍返回之后**才排下一拍：永不重入、永不叠加，网络变慢时自动变慢。
本模块不碰 Qt —— 定时器由调用方注入（Qt 侧传 `QTimer.singleShot`），所以这套
行为可以在不起窗口服务器、不转事件循环的前提下被断言。
"""
from .debug_probe import Snapshot

INTERVALS = (0.5, 1.0, 2.0)
DEFAULT_INTERVAL = 1.0

# Returned by an async `fetch`: the read is in flight elsewhere and will arrive
# via `report()`. Synchronous fetchers never see it.
DEFERRED = object()


class StatusPoller:
    def __init__(self, fetch, on_result, schedule, interval=DEFAULT_INTERVAL):
        self._fetch = fetch
        self._on_result = on_result
        self._schedule = schedule
        self.interval = float(interval)
        self.in_flight = False
        self._running = False
        self._again = False

    # ---- control ----

    def start(self):
        if self._running:
            return
        self._running = True
        self._cycle()

    def stop(self):
        self._running = False

    def set_interval(self, seconds):
        """Applies to the next cycle (the current one is already scheduled)."""
        self.interval = float(seconds)

    def refresh_now(self):
        """A manual read. While one is in flight it only queues one extra cycle
        - it never runs a second read concurrently."""
        if not self._running:
            return
        if self.in_flight:
            self._again = True
            return
        self._cycle()

    # ---- the single-shot, self-rearming cycle ----

    def _cycle(self):
        if not self._running or self.in_flight:
            return
        self.in_flight = True
        try:
            snapshot = self._fetch()
        except Exception as exc:                      # a failed read is a result
            snapshot = Snapshot(False, error=type(exc).__name__)
        if snapshot is DEFERRED:
            return                                    # `report()` will finish it
        self.report(snapshot)

    def report(self, snapshot):
        """A read finished. Async fetches call this when their result lands."""
        if not self.in_flight:                        # 重复/迟到的结果不许再排一拍
            return
        self.in_flight = False
        self._on_result(snapshot)
        if self._again:                               # 补一拍（用户按了立即刷新）
            self._again = False
            self._cycle()
            return
        if self._running:
            self._schedule(self.interval, self._cycle)
