"""Tests: playback clock interpolation, transit compensation, cue lookup."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from suboverlay.clock import SyncState, apply_sync, estimate_ms, find_cue_at
from suboverlay.protocol import Cue


def test_paused_clock_is_frozen():
    s = SyncState(video_time_ms=10000.0, playing=False, anchor_mono=100.0)
    assert estimate_ms(s, now_mono=150.0) == 10000.0


def test_playing_clock_interpolates_with_rate():
    cases = ((1.0, 1.0, 11000.0), (2.0, 1.0, 12000.0), (0.5, 2.0, 11000.0), (1.5, 4.0, 16000.0))
    for rate, dt, want in cases:
        s = SyncState(video_time_ms=10000.0, playing=True, playback_rate=rate, anchor_mono=100.0)
        assert estimate_ms(s, now_mono=100.0 + dt) == want


def test_apply_sync_compensates_transit_only_while_playing():
    s = SyncState()
    apply_sync(s, 5000.0, True, 1.0, 900.0, 1000.0)
    assert s.video_time_ms == 5100.0
    apply_sync(s, 5000.0, False, 1.0, 900.0, 1000.0)
    assert s.video_time_ms == 5000.0
    apply_sync(s, 5000.0, True, 1.0, -1000000000.0, 1000.0)
    assert s.video_time_ms == 7000.0
    apply_sync(s, 5000.0, True, 0.0, 1000.0, 1000.0)
    assert s.playback_rate == 1.0


def test_find_cue_inside_and_before_first():
    cs = [Cue(1000, 3000, "a"), Cue(4000, 6000, "b")]
    assert find_cue_at(cs, 1500).text == "a"
    assert find_cue_at(cs, 500) is None


def test_find_cue_gap_hold_bounded_by_ttl():
    cs = [Cue(1000, 2000, "a"), Cue(9000, 10000, "b")]
    assert find_cue_at(cs, 3000).text == "a"
    assert find_cue_at(cs, 3000, gap_hold_ms=500) is None
    assert find_cue_at(cs, 11000, gap_hold_ms=1000000000.0) is None


def test_find_cue_overlap_walks_back():
    cs = [Cue(1000, 5000, "wide"), Cue(2000, 2500, "narrow")]
    assert find_cue_at(cs, 2200).text == "narrow"
    assert find_cue_at(cs, 3000).text == "wide"


def test_rate_change_resyncs_without_jump():
    s = SyncState()
    apply_sync(s, 20000.0, True, 1.0, 1000.0, 1100.0)
    t0 = estimate_ms(s, now_mono=s.anchor_mono + 1.0)
    apply_sync(s, t0, True, 2.0, 1100.0, 1100.0)
    assert abs(estimate_ms(s, now_mono=s.anchor_mono) - t0) < 1e-6
