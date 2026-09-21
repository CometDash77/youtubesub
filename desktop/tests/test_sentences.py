"""Tests: sentence-group reconstruction incl. ASR rolling windows."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from suboverlay.sentences import compute_sentence_groups, word_count, ends_sentence
from suboverlay.protocol import Cue


def mk(start, end, text, last_off=None):
    return Cue(start, end, text, last_off if last_off is not None else start)


def test_manual_track_one_cue_groups():
    cs = [mk(0, 2000, "Hello world."), mk(2000, 4000, "Second line.")]
    gs = compute_sentence_groups(cs)
    assert [(g.start_idx, g.end_idx) for g in gs] == [(0, 0), (1, 1)]


def test_asr_rolling_window_merges_via_last_off():
    cs = [mk(0, 3000, "the cat", 800), mk(1000, 4000, "the cat sat", 1800),
          mk(2000, 5000, "the cat sat down", 2600),
          mk(6000, 8000, "next thought here", 6200)]
    gs = compute_sentence_groups(cs)
    assert len(gs) == 2 and gs[0].end_idx == 2 and gs[1].start_idx == 3


def test_sentence_punctuation_flushes():
    cs = [mk(0, 1000, "first part", 900), mk(1100, 2100, "ends now.", 2000),
          mk(2300, 3300, "after", 3200)]
    gs = compute_sentence_groups(cs)
    assert [g.end_idx for g in gs] == [1, 2]


def test_long_group_splits_and_covers_all():
    words = ["w%d" % i for i in range(40)]
    cs = [mk(i * 300, i * 300 + 250, w, i * 300 + 100) for i, w in enumerate(words)]
    gs = compute_sentence_groups(cs)
    assert len(gs) >= 2 and sum(g.end_idx - g.start_idx + 1 for g in gs) == 40


def test_word_count_counts_cjk():
    assert word_count("hello world") == 2
    assert word_count(chr(0x4F60) + chr(0x597D)) == 2
    assert ends_sentence("Hello.") and not ends_sentence("Hello")
    assert compute_sentence_groups([]) == []
