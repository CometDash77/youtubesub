"""事件留痕：把「一次快照 + 一个时间戳」变成「这次产生了哪些翻转事件」
（spec #162 决策 2/3 + D3）。

只记**翻转**（出现与消失、状态变化、停滞的开始），不记每拍数值；同一条连续
出现只记第一条（变化检测在这里，不在渲染层）。容量 200 条或 30 分钟，先到者
为限，内存环形，不落盘，关窗即弃。

「事件留痕」不是日志（不落盘）、不是快照（不导出）——见 CONTEXT.md。
"""
import time

KINDS = ("hook_error", "capture_error", "state", "trans_state", "fetch", "frames_stall")

CAPACITY = 200
WINDOW_S = 1800.0


def _hhmmss(timestamp):
    return time.strftime("%H:%M:%S", time.localtime(timestamp))


class EventRecorder:
    """Feed it every read (success or failure) in order; it answers with the
    flips that read produced. It never raises and never waits."""

    def __init__(self, opened_at, capacity=CAPACITY, window_s=WINDOW_S):
        self.opened_at = float(opened_at)
        self.capacity = int(capacity)
        self.window_s = float(window_s)
        self._events = []
        self._seen = False
        self._state = None
        self._trans_state = None
        self._hook_error = ""
        self._capture_error = ""
        self._fetch_ok = None
        self._frames = None
        self._stalled = False

    # ---- feeding ----

    def observe(self, snapshot, now):
        """Record what this read changed; returns the new events (oldest first)."""
        now = float(now)
        ok = bool(snapshot is not None and getattr(snapshot, "ok", False))
        new = []
        if self._fetch_ok is None:
            # 第一拍就失败必须留痕（「从未成功取到数」是用户要看见的状态）；
            # 第一拍成功则只是建立基线，不是翻转。
            if not ok:
                new.append(self._record(now, "fetch", "取数失败（尚未成功取到过数据）"))
            self._fetch_ok = ok
        elif ok != self._fetch_ok:
            new.append(self._record(now, "fetch", "取数恢复" if ok else "取数失败"))
            self._fetch_ok = ok
        if ok:
            new.extend(self._observe_payload(snapshot.data or {}, now))
        self._prune(now)
        return new

    def _observe_payload(self, data, now):
        stats = data.get("stats") if isinstance(data.get("stats"), dict) else {}
        state, trans_state = data.get("state"), data.get("trans_state")
        hook, capture = data.get("hook_error") or "", data.get("capture_error") or ""
        new = []
        if not self._seen:                      # 第一拍成功建立基线，不产生事件
            self._seen = True
        else:
            if state != self._state:
                new.append(self._record(now, "state", "字幕状态 %s → %s"
                                        % (self._state, state)))
            if trans_state != self._trans_state:
                new.append(self._record(now, "trans_state", "翻译态 %s → %s"
                                        % (self._trans_state, trans_state)))
            for kind, value, was, on_text, off_text in (
                    ("hook_error", hook, self._hook_error, "页面钩子未装上：%s", "页面钩子已恢复"),
                    ("capture_error", capture, self._capture_error,
                     "字幕正文抓取失败：%s", "字幕正文抓取已恢复")):
                if bool(value) != bool(was):
                    new.append(self._record(now, kind, on_text % value if value else off_text))
        self._state, self._trans_state = state, trans_state
        self._hook_error, self._capture_error = hook, capture
        frames = stats.get("frames")
        if isinstance(frames, int) and not isinstance(frames, bool):
            if self._frames is not None:
                stalled = frames == self._frames and state == "ok"
                if stalled and not self._stalled:
                    new.append(self._record(now, "frames_stall",
                                            "帧计数停滞（停在 %d 帧）" % frames))
                self._stalled = stalled
            self._frames = frames
        return new

    def _record(self, now, kind, text):
        event = {"at": now, "time": _hhmmss(now), "rel": int(now - self.opened_at),
                 "kind": kind, "text": text}
        self._events.append(event)
        return event

    def _prune(self, now):
        cutoff = now - self.window_s
        if self._events and self._events[0]["at"] < cutoff:
            self._events = [e for e in self._events if e["at"] >= cutoff]
        if len(self._events) > self.capacity:
            del self._events[:len(self._events) - self.capacity]

    # ---- reading ----

    def events(self):
        """Newest first (the list is rendered that way)."""
        return list(reversed(self._events))

    def opened_label(self):
        """The capability boundary, verbatim: this page was opened at HH:MM:SS
        and saw nothing before that (spec #162, D3)."""
        return "本页打开于 %s，此前事件未记录" % _hhmmss(self.opened_at)
