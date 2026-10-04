"""排障页：一条常驻状态条 + 一屏四块分区（spec #162）。

本页只渲染与交互，不取数：取数、留痕与调度分别在 `debug_probe` /
`debug_poller` / `debug_events`，这里只消费 `Snapshot` 与事件列表；`poller` 与
`clock` 都可注入，所以整套呈现能在 offscreen 下被断言。

失败呈现（决策 8/9）：状态条转赭红「连不上」+「上次成功 HH:MM:SS（N 秒前）」，
数值区保留上一拍的值但灰化；**连续**失败超过约 10 秒清空数值区，只留状态条。
「从未成功取到数」与「连不上」共用同一套呈现，不出现空白页。

硬边界（决策 16/17）：只显示状态接口里**已有**的键；读不出来的信号（排队数、
在途数、是否退避中、缓存命中率/条目数/DB 大小、连接数、收帧龄、按来源拆帧
数）一律不显示——正确做法是不显示，而不是临时加后端读数或改 `/status` 契约。
第三块的名字就叫「翻译队列」。
"""
import time

from PySide6 import QtCore, QtWidgets

from qfluentwidgets import (BodyLabel, ComboBox, PrimaryPushButton,
                            PushButton)

from . import debug_tokens as TOKENS
from .debug_events import EventRecorder
from .debug_poller import DEFERRED, StatusPoller
from .debug_probe import Snapshot, fetch_status

HOST = "127.0.0.1"
FREQUENCIES = (0.5, 1.0, 2.0)
STALE_AFTER_S = 10.0
ZONES = (("link", "① 连接与帧"), ("playback", "② 播放与字幕"),
         ("queue", "③ 翻译队列"), ("events", "④ 事件列表"))
LEVEL_OBJECT = {"ok": "debugBadgeOk", "warn": "debugBadgeWarn",
                "error": "debugBadgeError"}
ERROR_LABELS = {"服务端错误", "状态提供者错误", "页面钩子", "字幕抓取"}


def _clock_ms(seconds):
    return max(0, int(round(float(seconds) * 1000)))


def _qt_schedule(seconds, callback):
    QtCore.QTimer.singleShot(_clock_ms(seconds), callback)


class _ProbeSignals(QtCore.QObject):
    """Result carrier: emitted on the pool thread, delivered to the GUI thread."""

    finished = QtCore.Signal(object)


class _ProbeTask(QtCore.QRunnable):
    """One `/status` read, run on a pool thread.

    The read blocks until the 2 s timeout whenever the peer stalls — and on this
    machine even a *refused* loopback connect takes the full 2 s (实测：关掉服务后
    connect 要 ~2.0 秒才报 ConnectionRefusedError)。跑在 GUI 线程上会让整个 App
    每拍冻一次，所以取数一律离开 GUI 线程，只把结果送回来渲染。
    """

    def __init__(self, port, signals):
        super().__init__()
        self._port = int(port)
        self._signals = signals

    def run(self):
        try:
            snapshot = fetch_status(self._port)
        except Exception as exc:                    # 取数模块本身永不抛，双保险
            snapshot = Snapshot(False, error=type(exc).__name__)
        try:
            self._signals.finished.emit(snapshot)   # 关窗瞬间结果才落地：信号对象可能已随页销毁
        except RuntimeError:
            pass


def _text(value, fallback="—"):
    text = "" if value is None else str(value)
    return text if text else fallback


def _int(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value)


def _number(value):
    try:
        return "%g" % float(value)
    except (TypeError, ValueError):
        return _text(value)


def _yes_no(value):
    return "是" if value else "否"


class DiagPage(QtWidgets.QWidget):
    def __init__(self, port, poller=None, recorder=None, clock=None, parent=None):
        super().__init__(parent)
        self.setObjectName("debugDiagPage")
        self._port = int(port)
        self._clock = clock or time.time
        self._recorder = recorder or EventRecorder(self._clock())
        self._signals = _ProbeSignals()
        self._pool = QtCore.QThreadPool.globalInstance()
        self._signals.finished.connect(self._probe_finished)
        self._poller = poller or StatusPoller(
            fetch=self._fetch_async, on_result=self.apply,
            schedule=_qt_schedule, interval=1.0)
        self._failing = False
        self._last_data = None
        self._last_ok_at = None
        self._streak_started_at = None
        self._stale = False
        self._bar_text = ""
        self._ct_expanded = False
        self._rows = {name: [] for name, _ in ZONES}
        self._grids = {}
        self._badges = {}
        self._zone_level = {}
        self._events_view = None
        self._build()
        self._render()

    # ---- what the window and the tests use ----

    def apply(self, snapshot):
        """A read came back (or a failed read). Never raises."""
        now = float(self._clock())
        self._recorder.observe(snapshot, now)
        if bool(getattr(snapshot, "ok", False)):
            data = getattr(snapshot, "data", None)
            self._last_data = dict(data) if isinstance(data, dict) else {}
            self._last_ok_at = now
            self._failing = False
            self._streak_started_at = None
        else:
            if self._streak_started_at is None:
                self._streak_started_at = now
            self._failing = True
        self._render()

    def status_bar_text(self):
        return self._bar_text

    def status_bar_level(self):
        return self._level

    def zones_stale(self):
        """True while the value zones still show the last good read (灰化)."""
        return self._stale

    def zone_rows(self, zone):
        return list(self._rows[zone])

    def zone_badge(self, zone):
        """(text, level) of the one colour badge in that zone's title
        (spec #162 决策 20：状态类只给一处色块徽标)."""
        return self._zone_level[zone]

    def copy_all_text(self):
        lines = ["调试页 · 复制于 %s" % self._stamp(self._clock()),
                 "状态: " + self._bar_text]
        if self._stale:
            lines.append("注: 以下为上一拍的值（已过期）")
        for name, title in ZONES:
            lines.append("[%s]" % title)
            for label, value in self._rows[name]:
                lines.append(("%s: %s" % (label, value)) if label else value)
        return "\n".join(lines)

    def copy_to_clipboard(self):
        text = self.copy_all_text()
        QtWidgets.QApplication.clipboard().setText(text)
        return text

    def set_frequency(self, seconds):
        try:
            seconds = float(seconds)
        except (TypeError, ValueError):
            return None
        gear = min(FREQUENCIES, key=lambda option: (abs(option - seconds), option))
        self._poller.set_interval(gear)
        index = list(FREQUENCIES).index(gear)
        if self.frequency_box.currentIndex() != index:
            self.frequency_box.blockSignals(True)
            self.frequency_box.setCurrentIndex(index)
            self.frequency_box.blockSignals(False)
        return gear

    def frequency(self):
        return float(self._poller.interval)

    def refresh_now(self):
        self._poller.refresh_now()

    def connection_test_expanded(self):
        return self._ct_expanded

    def set_connection_test_expanded(self, expanded):
        self._ct_expanded = bool(expanded)
        self.ct_button.setText("收起连通性测试" if self._ct_expanded
                               else "展开连通性测试")
        self._render()

    def start(self):
        self._poller.start()

    def stop(self):
        self._poller.stop()

    # ---- 取数离开 GUI 线程（见 _ProbeTask） ----

    def _fetch_async(self):
        """Poller seam: hand the read to a pool thread. `DEFERRED` tells the
        poller 「这一拍还没回来，结果由 `_probe_finished` 送」."""
        self._pool.start(_ProbeTask(self._port, self._signals))
        return DEFERRED

    def _probe_finished(self, snapshot):
        """GUI thread: a pool-thread read landed; render it (and re-arm)."""
        self._poller.report(snapshot)

    # ---- Qt events ----

    def showEvent(self, event):
        super().showEvent(event)
        self.start()

    def hideEvent(self, event):
        super().hideEvent(event)
        self.stop()

    # ---- construction ----

    def _build(self):
        outer = QtWidgets.QVBoxLayout(self)
        outer.setContentsMargins(18, 18, 18, 18)
        outer.setSpacing(10)
        bar = QtWidgets.QHBoxLayout()
        self.status_label = QtWidgets.QLabel("")
        bar.addWidget(self.status_label)
        self.stale_label = QtWidgets.QLabel("以下为上一拍的值（已过期）")
        self.stale_label.setObjectName("debugStale")
        bar.addWidget(self.stale_label)
        bar.addStretch(1)
        outer.addLayout(bar)

        scroll = QtWidgets.QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
        content = QtWidgets.QWidget()
        column = QtWidgets.QVBoxLayout(content)
        column.setContentsMargins(0, 0, 0, 0)
        column.setSpacing(10)
        for name, title in ZONES:
            column.addWidget(self._zone_card(name, title))
        column.addStretch(1)
        scroll.setWidget(content)
        outer.addWidget(scroll, 1)

        footer = QtWidgets.QHBoxLayout()
        self.ct_button = PushButton("展开连通性测试")
        self.ct_button.clicked.connect(
            lambda: self.set_connection_test_expanded(not self._ct_expanded))
        footer.addWidget(self.ct_button)
        footer.addStretch(1)
        footer.addWidget(QtWidgets.QLabel("刷新频率"))
        self.frequency_box = ComboBox()
        for gear in FREQUENCIES:
            self.frequency_box.addItem("%g 秒" % gear, userData=gear)
        self.frequency_box.setCurrentIndex(list(FREQUENCIES).index(
            float(self._poller.interval)))
        self.frequency_box.currentIndexChanged.connect(self._frequency_changed)
        footer.addWidget(self.frequency_box)
        self.copy_button = PushButton("复制全部")
        self.copy_button.clicked.connect(self.copy_to_clipboard)
        footer.addWidget(self.copy_button)
        self.refresh_button = TOKENS.apply_primary_button(PrimaryPushButton("立即刷新"))
        self.refresh_button.clicked.connect(self.refresh_now)
        footer.addWidget(self.refresh_button)
        outer.addLayout(footer)

    def _zone_card(self, name, title):
        card = TOKENS.card_frame(self)
        column = QtWidgets.QVBoxLayout(card)
        heading = QtWidgets.QHBoxLayout()
        label = BodyLabel(title)
        label.setObjectName("debugSection")
        heading.addWidget(label)
        if name != "events":                      # 第四块没有状态徽标
            badge = QtWidgets.QLabel("")
            self._badges[name] = badge
            heading.addWidget(badge)
        heading.addStretch(1)
        column.addLayout(heading)
        if name == "events":
            self._events_view = QtWidgets.QPlainTextEdit()
            self._events_view.setReadOnly(True)
            self._events_view.setMinimumHeight(120)
            self._events_view.setLineWrapMode(QtWidgets.QPlainTextEdit.NoWrap)
            column.addWidget(self._events_view)
        else:
            grid = QtWidgets.QGridLayout()
            grid.setVerticalSpacing(4)
            grid.setColumnMinimumWidth(0, 110)
            grid.setColumnStretch(1, 1)
            self._grids[name] = grid
            column.addLayout(grid)
        return card

    def _frequency_changed(self, index):
        gear = self.frequency_box.itemData(index)
        if gear is not None:
            self.set_frequency(gear)

    # ---- rendering ----

    def _render(self):
        now = float(self._clock())
        if self._failing:
            streak = now - (self._streak_started_at or now)
            gone = self._last_data is None or streak > STALE_AFTER_S
            data = None if gone else dict(self._last_data)
        else:
            data = dict(self._last_data) if self._last_data is not None else None
        self._stale = bool(self._failing and data is not None)
        self._level, self._bar_text = self._bar(data, now)
        self.status_label.setText(self._bar_text)
        if self.status_label.objectName() != LEVEL_OBJECT[self._level]:
            self.status_label.setObjectName(LEVEL_OBJECT[self._level])
            self.status_label.style().unpolish(self.status_label)
            self.status_label.style().polish(self.status_label)
        self.stale_label.setVisible(self._stale)
        self._zone_level = self._zone_badges(data)
        for zone, (text, level) in self._zone_level.items():
            badge = self._badges[zone]
            badge.setText(text)
            if badge.objectName() != LEVEL_OBJECT[level]:
                badge.setObjectName(LEVEL_OBJECT[level])
                badge.style().unpolish(badge)
                badge.style().polish(badge)
        self._rows = self._build_rows(data)
        for name, _ in ZONES:
            self._render_zone(name)
        self.ct_button.setEnabled(not self._failing or data is not None)

    def _zone_badges(self, data):
        """One badge per value zone, in the zone title: ① 通不通 / ② 字幕这条链路
        正不正常 / ③ 翻译态本身（原型 A 的三个 pill：正常 / 注意 / ready）。

        没有数据时不说假话：取数失败 → 不通（哪怕数值区还灰着上一拍的值）；
        还没取过 → 等待。"""
        if data is None or self._failing:
            text, level = ("不通", "error") if self._failing else ("等待", "warn")
            return {zone: (text, level) for zone in ("link", "playback", "queue")}
        stats = data.get("stats") if isinstance(data.get("stats"), dict) else {}
        link = "warn" if (stats.get("error") or data.get("status_error")) else "ok"
        playback = "ok"
        if (data.get("hook_error") or data.get("capture_error")
                or data.get("state") != "ok"):
            playback = "warn"
        trans_state = str(data.get("trans_state") or "").strip() or "—"
        if trans_state.startswith("failed"):
            queue = "error"
        elif trans_state == "—" or trans_state == "unconfigured":
            queue = "warn"
        else:
            queue = "ok"
        return {"link": ("正常" if link == "ok" else "有错误", link),
                "playback": ("正常" if playback == "ok" else "注意", playback),
                "queue": (trans_state, queue)}

    def _bar(self, data, now):
        head = "连不上 %s:%d" % (HOST, self._port)
        if self._failing:
            if self._last_ok_at is None:
                return "error", head + " · 本窗口还没有成功取到过数据"
            age = int(max(0.0, now - self._last_ok_at))
            return "error", head + " · 上次成功 %s（%d 秒前）" % (
                self._stamp(self._last_ok_at), age)
        if data is None:
            return "warn", "等待第一拍……"
        level = self._level_of(data)
        text = "已连接 %s:%d" % (HOST, self._port)
        if level == "warn":
            text += " · 有需要处理的问题"
        return level, text

    @staticmethod
    def _level_of(data):
        stats = data.get("stats") if isinstance(data.get("stats"), dict) else {}
        if stats.get("error") or data.get("status_error"):
            return "warn"
        if data.get("hook_error") or data.get("capture_error"):
            return "warn"
        if str(data.get("trans_state") or "").startswith("failed"):
            return "warn"
        return "ok"

    def _build_rows(self, data):
        if data is None:
            return {"link": [], "playback": [], "queue": [],
                    "events": self._event_rows()}
        return {"link": self._link_rows(data), "playback": self._playback_rows(data),
                "queue": self._queue_rows(data), "events": self._event_rows()}

    def _link_rows(self, data):
        stats = data.get("stats") if isinstance(data.get("stats"), dict) else {}
        rows = [("服务", "已连接 %s:%d" % (HOST, self._port)),
                ("累计帧数", str(_int(stats.get("frames")))),
                ("坏帧数", str(_int(stats.get("bad_frames"))))]
        if stats.get("error"):
            rows.append(("服务端错误", _text(stats.get("error"))))
        if data.get("status_error"):
            rows.append(("状态提供者错误", _text(data.get("status_error"))))
        rows.append(("来源数", str(_int(data.get("sources")))))
        rows.append(("活跃来源", _text(data.get("active_source"))))
        return rows

    def _playback_rows(self, data):
        rows = [("字幕状态", _text(data.get("state"))),
                ("标题", _text(data.get("title"))),
                ("在播", _yes_no(data.get("playing"))),
                ("倍速", _number(data.get("rate"))),
                ("显示模式", _text(data.get("mode"))),
                ("显示顺序", _text(data.get("order"))),
                ("原文", _text(data.get("orig"))),
                ("译文", _text(data.get("trans"))),
                ("点击穿透", _yes_no(data.get("click_through")))]
        if data.get("hook_error"):
            rows.append(("页面钩子", _text(data.get("hook_error"))))
        if data.get("capture_error"):
            rows.append(("字幕抓取", _text(data.get("capture_error"))))
        return rows

    def _queue_rows(self, data):
        rows = [("可翻译", _yes_no(data.get("trans_available"))),
                ("翻译态", _text(data.get("trans_state")))]
        if self._ct_expanded:
            rows.extend(self._connection_test_rows(data.get("connection_test")))
        return rows

    @staticmethod
    def _connection_test_rows(report):
        if not isinstance(report, dict):
            return [("连通测试结论", "（还没有跑过）")]
        rows = [("连通测试结论", str(report.get("verdict", "")).upper() or "—")]
        for layer in report.get("layers") or []:
            if not isinstance(layer, dict):
                continue
            passed = layer.get("passed")
            mark = "PASS" if passed is True else ("FAIL" if passed is False else "--")
            head = " ".join(part for part in (
                mark, ("[%s]" % layer["code"]) if layer.get("code") else "",
                _text(layer.get("message"))) if part)
            rows.append(("层 " + _text(layer.get("id")),
                         "%s (%s 毫秒)" % (head, layer.get("elapsed_ms", 0))))
        if report.get("attempts"):
            rows.append(("尝试次数", str(_int(report.get("attempts")))))
        if report.get("skipped"):
            rows.append(("跳过", ", ".join(str(s) for s in report["skipped"])))
        messages = report.get("warning_messages") or {}
        if report.get("warnings"):
            rows.append(("警告", "; ".join(
                str(messages.get(code, code)) for code in report["warnings"])))
        if report.get("duration_ms"):
            rows.append(("用时", "%s 毫秒" % _int(report.get("duration_ms"))))
        return rows

    def _event_rows(self):
        rows = [("", self._recorder.opened_label())]
        for event in self._recorder.events():
            rows.append(("%s (+%ds)" % (event.get("time", ""), _int(event.get("rel"))),
                         _text(event.get("text"))))
        return rows

    def _render_zone(self, name):
        rows = self._rows[name]
        if name == "events":
            if self._events_view is not None:
                self._events_view.setPlainText("\n".join(
                    ("%s  %s" % (label, value)) if label else value
                    for label, value in rows))
            return
        grid = self._grids[name]
        while grid.count():
            item = grid.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        for index, (label_text, value_text) in enumerate(rows):
            label = BodyLabel(label_text)
            label.setObjectName("debugStale" if self._stale else "debugHint")
            value = BodyLabel(value_text)
            if self._stale:
                value.setObjectName("debugStale")
            elif label_text in ERROR_LABELS:
                value.setObjectName("debugError")
            else:
                value.setObjectName("debugValue")
            value.setTextInteractionFlags(QtCore.Qt.TextSelectableByMouse)
            grid.addWidget(label, index, 0)
            grid.addWidget(value, index, 1)

    @staticmethod
    def _stamp(timestamp):
        return time.strftime("%H:%M:%S", time.localtime(float(timestamp)))
