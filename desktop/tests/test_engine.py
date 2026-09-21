"""Engine pipeline tests: cues -> groups -> queue -> mock translate -> display."""
import json, os, sys, tempfile, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from suboverlay.engine import Engine
from suboverlay.settings import default_settings


def mk_engine(tmpdir):
    from suboverlay.queue_cache import TranslationCache
    s = default_settings()
    s["provider"]["mock"] = True
    cache = TranslationCache(os.path.join(tmpdir, "t.db"))
    return Engine(s, cache=cache, workers=2)


JSON3 = {"events": [
    {"tStartMs": 1000, "dDurationMs": 3000, "segs": [{"utf8": "the cat ", "tOffsetMs": 500}, {"utf8": "sat", "tOffsetMs": 900}]},
    {"tStartMs": 2000, "dDurationMs": 3000, "segs": [{"utf8": "the cat sat down", "tOffsetMs": 1500}]},
    {"tStartMs": 5000, "dDurationMs": 2000, "segs": [{"utf8": "next thought", "tOffsetMs": 5100}]},
]}


def test_engine_full_pipeline_with_mock_translation():
    e = mk_engine(tempfile.mkdtemp())
    e.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr", "tab_title": "T"}, JSON3)
    src = e.sources["s1"]
    assert len(src.cues) == 3 and len(src.groups) >= 1
    # play at t=1500ms -> first group urgent
    e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1500.0,
                    "playing": True, "playback_rate": 1.0, "timestamp": time.time() * 1000})
    d = e.tick()
    assert d["state"] == "ok" and d["orig"].startswith("the cat")
    assert d["trans"] == ""  # not yet translated
    deadline = time.time() + 5
    while time.time() < deadline:
        d = e.tick()
        if d["trans"]:
            break
        time.sleep(0.05)
    assert d["trans"], "mock translation should arrive"
    assert "the cat" in d["trans"]
    qstats = e._queue.stats()
    assert isinstance(qstats, dict)
    e._queue.shutdown()


def test_engine_seek_cancels_pending_and_reschedules():
    e = mk_engine(tempfile.mkdtemp())
    e.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, JSON3)
    e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1000.0,
                    "playing": True, "playback_rate": 1.0, "timestamp": time.time() * 1000})
    e.tick()
    time.sleep(0.1)
    pend_before = e._queue.stats()
    # seek far ahead
    e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 5500.0,
                    "playing": True, "playback_rate": 1.0, "timestamp": time.time() * 1000})
    d = e.tick()
    assert d["orig"] == "next thought"  # resynced to new position
    e._queue.shutdown()


def test_engine_paused_and_rate_changes():
    e = mk_engine(tempfile.mkdtemp())
    e.ingest_json3("s1", {"video_id": "v1", "track_kind": "manual"}, JSON3)
    e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1200.0,
                    "playing": False, "playback_rate": 1.0, "timestamp": time.time() * 1000})
    d1 = e.tick()
    time.sleep(0.15)
    d2 = e.tick()
    assert d1["orig"] == d2["orig"]  # paused: frozen
    e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1200.0,
                    "playing": True, "playback_rate": 2.0, "timestamp": time.time() * 1000})
    time.sleep(0.2)
    d3 = e.tick()
    assert d3["playing"] and d3["rate"] == 2.0
    e._queue.shutdown()


def test_engine_surfaces_a_page_hook_failure():
    """Without cues the overlay can only say "waiting"; if the browser told us the
    page hook never installed (Trusted Types on youtube.com), that must reach the
    display state - "connected but blind" is not "no captions on this video"."""
    e = mk_engine(tempfile.mkdtemp())
    e.handle_event({"type": "register", "source_id": "s1", "video_id": "v1",
                    "tab_title": "T", "hook_error": "script element: TypeError: TrustedScript"})
    d = e.tick()
    assert d["state"] == "no_cues"
    assert d["hook_error"] == "script element: TypeError: TrustedScript"
    e._queue.shutdown()


def test_engine_surfaces_an_empty_caption_body():
    """The live failure mode: the hook ran and saw the timedtext request, but
    youtube.com answered a headless Chrome with 200 + text/html + 0 bytes. Without
    this on the display state, "connected, never a subtitle" is undiagnosable."""
    e = mk_engine(tempfile.mkdtemp())
    e.handle_event({"type": "register", "source_id": "s1", "video_id": "v1",
                    "tab_title": "T", "hook_error": "",
                    "capture_error": "caption response was empty (status 200)"})
    d = e.tick()
    assert d["state"] == "no_cues"
    assert d["capture_error"] == "caption response was empty (status 200)"
    e._queue.shutdown()


def test_cues_refresh_keeps_a_live_clock():
    """Regression (found by the real-browser E2E): re-sending cues for an existing
    source (subtitle track switch, SPA track reload) used to reset the playback
    clock to zero, blanking the overlay until the next player event - which never
    comes while the video is paused."""
    e = mk_engine(tempfile.mkdtemp())
    e.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, JSON3)
    e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 5500.0,
                    "playing": False, "playback_rate": 1.0, "timestamp": time.time() * 1000})
    assert e.tick()["orig"] == "next thought"
    # same video, another track arrives while paused
    e.ingest_json3("s1", {"video_id": "v1", "track_kind": "manual"}, JSON3)
    assert e.tick()["orig"] == "next thought", "a cues refresh must not reset the clock"
    # a brand new source still starts clean (fresh clock, no stale position)
    e.ingest_json3("s2", {"video_id": "v2", "track_kind": "asr"}, JSON3)
    assert e.tick()["orig"] == "", "a new source must not inherit the old clock"
    e._queue.shutdown()


def test_engine_translation_persists_in_cache_across_restart():
    tmp = tempfile.mkdtemp()
    from suboverlay.queue_cache import TranslationCache
    db = os.path.join(tmp, "t.db")
    s = default_settings()
    s["provider"]["mock"] = True
    e1 = Engine(s, cache=TranslationCache(db), workers=2)
    e1.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, JSON3)
    e1.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1500.0,
                     "playing": True, "playback_rate": 1.0, "timestamp": time.time() * 1000})
    deadline = time.time() + 5
    got = False
    while time.time() < deadline:
        if e1.tick().get("trans"):
            got = True
            break
        time.sleep(0.05)
    assert got
    e1._queue.shutdown()

    # new engine, same db: translation must come from cache quickly
    e2 = Engine(s, cache=TranslationCache(db), workers=1)
    e2.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, JSON3)
    e2.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1500.0,
                     "playing": True, "playback_rate": 1.0, "timestamp": time.time() * 1000})
    t0 = time.time()
    got = False
    while time.time() - t0 < 1.0:
        if e2.tick().get("trans"):
            got = True
            break
        time.sleep(0.02)
    assert got, "cache hit should be immediate"
    e2._queue.shutdown()