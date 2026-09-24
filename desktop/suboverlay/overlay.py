"""Always-on-top subtitle overlay (PySide6).

Ported from LiveSubs OverlayWindow UX (Apache-2.0, (c) 2026 Diva143V):
frameless + translucent + stays-on-top, rounded bg box with ARGB alpha
(no double-multiply bug), stroke via QPainterPath, bilingual rows with
order swap, history deque, hover toolbar, drag + 8-edge resize,
click-through with unlock (improvement over LiveSubs one-way bit).
"""
from PySide6 import QtCore, QtGui, QtWidgets
import ctypes

GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
RESIZE_MARGIN = 10
DELTA_MODE_HEIGHT = 40
ROW_LABELS = {"orig": "【原】", "trans": "【译】"}
DIVIDER_RGBA = (255, 255, 255, 80)

class OverlayWindow(QtWidgets.QWidget):
    modes = ("bilingual", "trans", "orig")

    def __init__(self, settings):
        super().__init__(None, QtCore.Qt.FramelessWindowHint | QtCore.Qt.WindowStaysOnTopHint
                         | QtCore.Qt.Tool)
        self.settings = settings
        disp = settings["display"]
        self.mode = disp.get("mode", "bilingual")
        self.order = disp.get("order", "trans_first")
        self.history = []   # list of (orig, trans), newest last
        self.orig_text = ""
        self.trans_text = ""
        self.status_text = ""
        # Engine's word on whether this run can translate at all; see _display_rows().
        self.trans_available = False
        self._press_pos = None
        self._resizing = False
        self._resize_edge = None
        self._click_through = False
        self.setMouseTracking(True)
        self.setAttribute(QtCore.Qt.WA_TranslucentBackground)
        self.setMinimumSize(0, 0)  # no window size limit at all (user request)
        w = settings.get("window", {})
        if w.get("x") is not None:
            self.move(int(w["x"]), int(w["y"]))
        self.resize(int(w.get("w") or 650), int(w.get("h") or 135))
        self._dpi_done = False

    # ---- topmost re-arm (fullscreen apps can steal topmost) ----
    def showEvent(self, ev):
        super().showEvent(ev)
        if not self._dpi_done and sys_has_windows():
            try:
                ctypes.windll.shcore.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
            except Exception:
                pass
            self._dpi_done = True
        self.raise_()
        self.activateWindow()

    def pulse_topmost(self):
        if not self._click_through:
            self.setWindowFlag(QtCore.Qt.WindowStaysOnTopHint, True)
            self.show()

    _ctx_menu = None

    def contextMenuEvent(self, ev):
        if self._ctx_menu is not None:
            self._ctx_menu.exec(ev.globalPos())

    # ---- text API ----
    def set_display(self, d):
        # One default for an absent field everywhere: nothing has said a
        # translation is possible, so don't assume one is.
        self.trans_available = bool(d.get("trans_available", False))
        if d.get("state") == "no_cues":
            if d.get("hook_error"):
                self.status_text = ("page hook NOT installed - the script is connected "
                                    "but cannot see captions")
            elif d.get("capture_error"):
                self.status_text = ("caption body was empty - connected, but YouTube "
                                    "returned no caption data")
            else:
                self.status_text = "waiting for subtitles..." + ("  [" + d.get("title", "") + "]" if d.get("title") else "")
            self.update()
            return
        self.status_text = "" if d.get("playing") else "[Paused]"
        o, t = d.get("orig", ""), d.get("trans", "")
        if o and (o != self.orig_text or t != self.trans_text):
            if self.history and self.history[-1] != (self.orig_text, self.trans_text):
                pass
            if self.orig_text and self.trans_text:
                self.history.append((self.orig_text, self.trans_text))
                maxh = int(self.settings["display"].get("history_lines", 2))
                while len(self.history) > maxh:
                    self.history.pop(0)
        self.orig_text = o
        self.trans_text = t
        self.update()

    # ---- painting (stroke via QPainterPath, LiveSubs technique) ----
    def paintEvent(self, ev):
        disp = self.settings["display"]
        p = QtGui.QPainter(self)
        p.setRenderHint(QtGui.QPainter.Antialiasing)
        p.setRenderHint(QtGui.QPainter.TextAntialiasing)
        bg = disp.get("bg_color", [0, 0, 0])
        alpha = int(disp.get("bg_opacity", 150))
        box = self.rect().adjusted(4, 4, -4, -4)
        p.setPen(QtGui.QPen(QtCore.Qt.NoPen))
        p.setBrush(QtGui.QColor(bg[0], bg[1], bg[2], alpha))
        p.drawRoundedRect(box, 10, 10)

        margin = 14
        area = self.rect().adjusted(margin, margin, -margin, -margin)
        # Rows and the bilingual divider share the content bounds. In
        # particular, a wrapped first row must not push its divider below the
        # visible subtitle area.
        p.save()
        p.setClipRect(area, QtCore.Qt.IntersectClip)
        y = area.top()
        rows = self._display_rows()
        for i, (role, text) in enumerate(rows):
            size = float(disp.get("font_size", 15))
            if role == "trans":
                size = size * 1.25
            font = QtGui.QFont("Microsoft YaHei UI", int(size))
            font.setBold(disp.get("font_bold") in ("both",) or
                         (role == "trans" and disp.get("font_bold") == "trans_only") or
                         (role == "orig" and disp.get("font_bold") == "sub_only"))
            color = QtGui.QColor(255, 255, 255) if role == "orig" else QtGui.QColor(255, 224, 130)
            y = self._draw_wrapped(p, font, text, area, y, color,
                                    float(disp.get("stroke", 2.0)))
            if i == 0 and len(rows) == 2:
                # Issue #1 Q2a: two rows (bilingual) always get the divider
                # between them, even while one of them is still empty.
                y = self._draw_divider(p, area, y)
        p.restore()
        if self.status_text:
            font = QtGui.QFont("Consolas", 9)
            p.setFont(font)
            p.setPen(QtGui.QPen(QtGui.QColor(160, 160, 160)))
            p.drawText(QtCore.QRect(area.left(), self.height() - 22, area.width(), 18),
                       QtCore.Qt.AlignLeft, self.status_text)
        p.end()

    def _display_rows(self):
        """The rows to paint, in order, each already carrying its constant
        【原】/【译】 label.

        This is the single place that decides what a mode shows when there is no
        translation to show (issue #1): a missing translation must not blank the
        overlay, so trans mode falls back to the original instead of drawing
        nothing. `trans_available` is the engine's word on whether this run can
        translate at all - the display layer never infers it from provider config,
        and an empty translation row is not evidence that none is coming. Two
        rows mean a divider goes between them; with every row empty (between
        cues) nothing is drawn at all.
        """
        orig, trans = self.orig_text or "", self.trans_text or ""
        if self.mode == "orig":
            rows = [("orig", orig)]
        elif self.mode == "trans" and not trans and not self.trans_available:
            rows = [("orig", orig)]
        elif self.mode == "trans":
            rows = [("trans", trans)]
        else:
            rows = [("trans", trans), ("orig", orig)]
            if self.order == "orig_first":
                rows.reverse()
        if not any(text for _, text in rows):
            return []  # between cues: no floating labels, no divider
        return [(role, self._labelled(role, text)) for role, text in rows]

    def _labelled(self, role, text):
        """Row text with its constant label. Text that already carries it (the
        mock translator writes 【译】 into its own output) is left alone, so the
        label never doubles up on itself."""
        label = ROW_LABELS.get(role, "")
        return text if text.startswith(label) else label + text

    def _draw_divider(self, p, area, y):
        """The bilingual separator (issue #1 Q2a): drawn between the two rows
        whenever the mode has two, even while one of them is still empty."""
        mid = y + 2
        p.setPen(QtGui.QPen(QtGui.QColor(*DIVIDER_RGBA), 1))
        p.drawLine(area.left(), mid, area.right(), mid)
        return mid + 4

    def _draw_wrapped(self, p, font, text, area, y, color, stroke_w):
        fm = QtGui.QFontMetrics(font)
        line_h = fm.height() + 3
        # Wrap on spaces where possible, then split overlong words by character
        # width. Chinese subtitles commonly contain no spaces at all.
        words = text.split(" ")
        lines, cur = [], ""

        def split_word(word):
            parts, part = [], ""
            for char in word:
                candidate = part + char
                if part and fm.horizontalAdvance(candidate) > area.width():
                    parts.append(part)
                    part = char
                else:
                    part = candidate
            if part:
                parts.append(part)
            return parts

        for w in words:
            cand = (cur + " " + w).strip()
            if fm.horizontalAdvance(cand) <= area.width():
                cur = cand
            else:
                if cur:
                    lines.append(cur)
                    cur = ""
                parts = split_word(w)
                if parts:
                    lines.extend(parts[:-1])
                    cur = parts[-1]
        if cur:
            lines.append(cur)
        pen = QtGui.QPen(QtGui.QColor(0, 0, 0), stroke_w, QtCore.Qt.SolidLine,
                         QtCore.Qt.RoundCap, QtCore.Qt.RoundJoin)
        p.save()
        p.setClipRect(area, QtCore.Qt.IntersectClip)
        for ln in lines:
            if y + line_h > area.bottom() + 8:
                break
            if stroke_w > 0:
                path = QtGui.QPainterPath()
                path.addText(area.left(), y + fm.ascent(), font, ln)
                p.strokePath(path, pen)
                p.fillPath(path, QtGui.QBrush(color))
            else:
                p.setFont(font)
                p.setPen(QtGui.QPen(color))
                p.drawText(QtCore.QRect(area.left(), y, area.width(), line_h),
                           QtCore.Qt.AlignLeft | QtCore.Qt.AlignVCenter, ln)
            y += line_h
        p.restore()
        return y + 4

    # ---- drag + resize (LiveSubs geometry, manual math) ----
    def _edge_at(self, pos):
        r = self.rect()
        m = RESIZE_MARGIN
        left = pos.x() <= m
        right = pos.x() >= r.width() - m
        top = pos.y() <= m
        bottom = pos.y() >= r.height() - m
        if top and left:
            return "tl"
        if top and right:
            return "tr"
        if bottom and left:
            return "bl"
        if bottom and right:
            return "br"
        if top:
            return "t"
        if bottom:
            return "b"
        if left:
            return "l"
        if right:
            return "r"
        return None

    def mouseMoveEvent(self, ev):
        pos = ev.position().toPoint()
        if self._press_pos is None:
            edge = self._edge_at(pos)
            cursors = {"t": QtCore.Qt.SizeVerCursor, "b": QtCore.Qt.SizeVerCursor,
                       "l": QtCore.Qt.SizeHorCursor, "r": QtCore.Qt.SizeHorCursor,
                       "tl": QtCore.Qt.SizeFDiagCursor, "br": QtCore.Qt.SizeFDiagCursor,
                       "tr": QtCore.Qt.SizeBDiagCursor, "bl": QtCore.Qt.SizeBDiagCursor}
            self.setCursor(cursors.get(edge, QtCore.Qt.ArrowCursor))
            return
        g = ev.globalPosition().toPoint()
        if self._resizing:
            # edge latched at press: dragging inward past the margin must keep resizing
            self._apply_resize(self._resize_edge, g)
        else:
            self.move(g - self._press_pos)

    def mousePressEvent(self, ev):
        if ev.button() == QtCore.Qt.LeftButton:
            pos = ev.position().toPoint()
            self._press_pos = ev.globalPosition().toPoint() - self.frameGeometry().topLeft()
            self._resize_edge = self._edge_at(pos)  # latch edge at press
            self._resizing = bool(self._resize_edge)
            self._press_global = ev.globalPosition().toPoint()
            self._press_geom = self.geometry()

    def mouseReleaseEvent(self, ev):
        self._press_pos = None
        self._resizing = False
        self._resize_edge = None
        self._persist_geometry()

    def _apply_resize(self, edge, g):
        min_w, min_h = 1, 1  # guard zero-size only; no user-facing limit
        geo = QtCore.QRect(self._press_geom)
        dx = g.x() - self._press_global.x()
        dy = g.y() - self._press_global.y()
        if "l" in edge:
            new_w = geo.width() - dx
            if new_w >= min_w:
                geo.setLeft(geo.left() + dx)
        if "r" in edge:
            geo.setWidth(max(min_w, geo.width() + dx))
        if "t" in edge:
            new_h = geo.height() - dy
            if new_h >= min_h:
                geo.setTop(geo.top() + dy)
        if "b" in edge:
            geo.setHeight(max(min_h, geo.height() + dy))
        self.setGeometry(geo)

    def _persist_geometry(self):
        w = self.settings.setdefault("window", {})
        w["x"], w["y"] = self.x(), self.y()
        w["w"], w["h"] = self.width(), self.height()
        try:
            from . import settings as S
            S.save(self.settings)
        except Exception:
            pass

    # ---- click-through (with unlock, unlike LiveSubs) ----
    def set_click_through(self, on):
        self._click_through = bool(on)
        if not sys_has_windows():
            return
        hwnd = int(self.winId())
        user32 = ctypes.windll.user32
        style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        if on:
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_TRANSPARENT)
        else:
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style & ~WS_EX_TRANSPARENT)

    def cycle_mode(self):
        i = self.modes.index(self.mode)
        self.mode = self.modes[(i + 1) % len(self.modes)]
        self.settings["display"]["mode"] = self.mode
        self.update()

    def swap_order(self):
        self.order = "orig_first" if self.order == "trans_first" else "trans_first"
        self.settings["display"]["order"] = self.order
        self.update()

    def nudge_font(self, d):
        v = max(6, min(40, int(self.settings["display"]["font_size"]) + d))
        self.settings["display"]["font_size"] = v
        self.update()

    def nudge_opacity(self, d):
        v = max(1, min(251, int(self.settings["display"]["bg_opacity"]) + d))
        self.settings["display"]["bg_opacity"] = v
        self.update()


def sys_has_windows():
    import sys as _s
    return _s.platform == "win32"
