"""Desktop playback clock: interpolate video time between browser syncs.

Design from dkitle ui.rs estimated_time_ms + transit-delay compensation
(design only, reimplemented; dkitle defects fixed: gap-hold has a TTL,
replayed syncs keep their original sender timestamp, overlap lookup
walks back like yt-dual-subs activeCueIdxAt).
"""
from __future__ import annotations
import bisect
import time
from dataclasses import dataclass, field

GAP_HOLD_MS = 3500.0
MAX_TRANSIT_MS = 2000.0
OVERLAP_WALKBACK = 8


@dataclass
class SyncState:
    video_time_ms: float = 0.0
    playing: bool = False
    playback_rate: float = 1.0
    anchor_mono: float = field(default_factory=time.monotonic)


def apply_sync(state, video_time_ms, playing, playback_rate, sender_ts_ms, now_epoch_ms):
    """Fold one browser sync into the clock. Transit compensation only while playing.
    sender_ts_ms MUST be the original send time (never refresh on replay)."""
    rate = playback_rate if isinstance(playback_rate, (int, float)) and playback_rate > 0 else 1.0
    transit = 0.0
    if playing:
        transit = now_epoch_ms - sender_ts_ms
        transit = max(0.0, min(transit, MAX_TRANSIT_MS))
    state.video_time_ms = float(video_time_ms) + transit
    state.playing = bool(playing)
    state.playback_rate = float(rate)
    state.anchor_mono = time.monotonic()
    return state


def estimate_ms(state, now_mono=None):
    """Current video time: frozen while paused, else base + elapsed*rate."""
    if not state.playing:
        return state.video_time_ms
    now = time.monotonic() if now_mono is None else now_mono
    return state.video_time_ms + max(0.0, now - state.anchor_mono) * 1000.0 * state.playback_rate


def find_cue_at(cues_sorted, t_ms, gap_hold_ms=GAP_HOLD_MS):
    """Cue visible at t_ms. Binary search greatest start <= t, walk back <=8
    for overlap coverage; hold previous cue in gaps for at most gap_hold_ms."""
    if not cues_sorted:
        return None
    starts = [c.start_ms for c in cues_sorted]
    idx = bisect.bisect_right(starts, t_ms) - 1
    if idx < 0:
        return None
    lo = max(0, idx - OVERLAP_WALKBACK)
    for j in range(idx, lo - 1, -1):
        c = cues_sorted[j]
        if c.start_ms <= t_ms < c.end_ms:
            return c
    if idx + 1 >= len(cues_sorted):
        return None  # after the last cue: never hold (dkitle gap-hold-forever fix)
    prev = cues_sorted[idx]
    if t_ms - prev.end_ms <= gap_hold_ms:
        return prev
    return None
