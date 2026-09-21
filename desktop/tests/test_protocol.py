"""Tests: json3 parsing, cue coercion, end repair."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from suboverlay.protocol import Cue, coerce_cue, coerce_cues, parse_json3, repair_cue_ends


def test_parse_json3_manual():
    data = {"events": [
        {"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "hello "}, {"utf8": "world"}]},
        {"tStartMs": 3000, "dDurationMs": 1500, "segs": [{"utf8": "second line", "tOffsetMs": 100}]},
    ]}
    cues = parse_json3(data)
    assert len(cues) == 2
    assert cues[0].text == "hello world" and cues[0].start_ms == 1000 and cues[0].end_ms == 3000
    assert cues[0].last_off_ms == 1000
    assert cues[1].last_off_ms == 3100


def test_parse_json3_skips_junk_events():
    data = {"events": [
        {"tStartMs": 0, "dDurationMs": 1000, "segs": []},
        {"tStartMs": 500, "segs": [{"utf8": "no dur"}]},
        {"tStartMs": 900, "dDurationMs": 0, "segs": [{"utf8": "zero"}]},
    ]}
    assert parse_json3(data) == []
    assert parse_json3({}) == [] and parse_json3({"events": None}) == []


def test_parse_json3_asr_last_off_ignores_blank_tail():
    data = {"events": [{"tStartMs": 5000, "dDurationMs": 3000, "segs": [
        {"utf8": "the cat ", "tOffsetMs": 200}, {"utf8": "sat", "tOffsetMs": 800},
        {"utf8": " ", "tOffsetMs": 2900}]}]}
    c = parse_json3(data)[0]
    assert c.text == "the cat sat" and c.last_off_ms == 5800


def test_coerce_cue_rejects_junk_never_raises():
    assert coerce_cue(None) is None and coerce_cue("x") is None
    assert coerce_cue({"text": "   "}) is None
    assert coerce_cue({"text": "a", "start_ms": 5, "end_ms": 5}) is None
    assert coerce_cue({"text": "a", "start_ms": float("nan"), "end_ms": 9}).start_ms == 0.0
    bad = {"text": "ok", "start_ms": -100, "end_ms": 50, "last_off_ms": -999}
    assert coerce_cue(bad).last_off_ms == -100


def test_repair_cue_ends_sorts_and_trims():
    cs = [Cue(9000, 12000, "b"), Cue(1000, 5000, "a"), Cue(3000, 4000, "mid")]
    out = repair_cue_ends(cs)
    assert [c.text for c in out] == ["a", "mid", "b"]
    assert out[0].end_ms == 3000
    assert out[2].end_ms == 12000
