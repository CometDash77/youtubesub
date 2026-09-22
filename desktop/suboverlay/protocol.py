"""Wire data model + validation for PROTOCOL.md v1.

Adapted from: yt-dual-subs inject.js parseJson3 (MIT, (c) 2026 Gythiro).
Design reference: dkitle subtitle.rs schema (design only, no code copied).
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field

PROTOCOL_VERSION = 1
WS_PATH = "/ws"
HEALTH_PATH = "/health"
STATUS_PATH = "/status"
DEFAULT_PORT = 9877

VALID_TYPES = {"register", "cues", "sync", "deactivate", "play_pause"}


@dataclass
class Cue:
    start_ms: float
    end_ms: float
    text: str
    # Wire-only since ADR-006: kept for protocol compatibility (userscript,
    # fixtures and docs all still carry it), never used for segmentation.
    last_off_ms: float = 0.0
    trans: str = ""

    def __post_init__(self):
        if not self.last_off_ms:
            self.last_off_ms = self.start_ms


@dataclass
class SourceState:
    source_id: str
    provider: str = "youtube"
    video_id: str = ""
    tab_title: str = ""
    track_kind: str = ""
    track_lang: str = ""
    cues: list = field(default_factory=list)
    active: bool = True

def _num(v, default=0.0):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    if f != f or f in (float("inf"), float("-inf")):
        return default
    return f


def coerce_cue(raw):
    """Validate one inbound cue dict; None for junk (never raises)."""
    if not isinstance(raw, dict):
        return None
    text = raw.get("text", "")
    if not isinstance(text, str):
        return None
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return None
    start = _num(raw.get("start_ms"))
    end = _num(raw.get("end_ms"))
    if end <= start:
        return None
    last_off = _num(raw.get("last_off_ms"), start)
    if last_off < start:
        last_off = start
    return Cue(start_ms=start, end_ms=end, text=text, last_off_ms=last_off)


def coerce_cues(raw):
    """Coerce a cues array; junk dropped, order preserved (no sort here)."""
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        c = coerce_cue(item)
        if c is not None:
            out.append(c)
    return out

def parse_json3(data):
    """Parse YouTube timedtext json3 payload into Cue list (event order kept).

    Adapted from yt-dual-subs inject.js parseJson3 (MIT): read only
    segs utf8 + tOffsetMs, collapse whitespace, strip ASR >> marks,
    skip style/blank events, last_off tracks last NON-BLANK seg.
    """
    cues = []
    events = data.get("events") if isinstance(data, dict) else None
    if not isinstance(events, list):
        return cues
    for ev in events:
        if not isinstance(ev, dict) or not isinstance(ev.get("segs"), list):
            continue
        parts = []
        off = 0.0
        has_off = False
        for s in ev["segs"]:
            if not isinstance(s, dict) or not isinstance(s.get("utf8"), str):
                continue
            u = s["utf8"]
            parts.append(u)
            if u.strip() and isinstance(s.get("tOffsetMs"), (int, float)):
                off = float(s["tOffsetMs"])
                has_off = True
        # Seg separator aligned to the reference (#26): join with a space so a
        # seg without a trailing space cannot glue the next word onto it (word
        # and char counts would drift). The whitespace collapse below folds the
        # doubled spaces that a trailing space plus separator produces.
        text = re.sub(r"\s+", " ", " ".join(parts)).strip()
        text = re.sub(r"(^|\s)>{2,}\s*", r"\1", text).strip()
        if not text:
            continue
        start = ev.get("tStartMs")
        start = float(start) if isinstance(start, (int, float)) else 0.0
        dur = ev.get("dDurationMs")
        dur = float(dur) if isinstance(dur, (int, float)) else 0.0
        if dur <= 0:
            continue
        cues.append(Cue(start, start + dur, text, (start + off) if has_off else start))
    return cues


def repair_cue_ends(cues, floor_ms=1000.0):
    """Sort by start; trim overlap to next.start; tail keeps own end."""
    cues = sorted(cues, key=lambda c: c.start_ms)
    for i, c in enumerate(cues):
        nxt = cues[i + 1] if i + 1 < len(cues) else None
        if nxt is not None and nxt.start_ms > c.start_ms and c.end_ms > nxt.start_ms:
            c.end_ms = nxt.start_ms
        if c.end_ms <= c.start_ms:
            if nxt is not None and nxt.start_ms > c.start_ms:
                c.end_ms = nxt.start_ms
            else:
                c.end_ms = c.start_ms + floor_ms
    return cues
