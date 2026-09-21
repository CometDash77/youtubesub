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


def mk_configured_engine(tmpdir, mock, db=None, workers=2):
    """An engine with Mock on *and* a real endpoint configured - the overlap issue
    #31 is about: _provider_usable() accepts either, and the Mock branch is the one
    taken. The settings dict belongs to that engine, so a test can edit it in place
    the way the Settings dialog does."""
    from suboverlay.queue_cache import TranslationCache
    s = default_settings()
    s["provider"].update({"base_url": "https://api.example.test/v1", "api_key": "sk-test",
                          "model": "test-model", "mock": mock})
    cache = TranslationCache(db or os.path.join(str(tmpdir), "t.db"))
    return Engine(s, cache=cache, workers=workers)


def wait_trans(e, want=None, timeout=5.0):
    """Tick until the display satisfies want (default: any translation arrives)."""
    want = want or (lambda d: bool(d.get("trans")))
    deadline = time.time() + timeout
    d = e.tick()
    while time.time() < deadline and not want(d):
        time.sleep(0.02)
        d = e.tick()
    return d


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

def test_mock_echo_is_never_served_as_a_real_translation(tmp_path, monkeypatch):
    """Issue #31 (bug): with Mock on *and* base_url/model configured, the Mock
    echo was cached under the very identity the real provider would use, so
    unchecking Mock served 【译】+原文 as the real translation - forever, and
    without ever asking the real provider. The two products must not share a
    cache identity."""
    import suboverlay.provider as P
    calls = []

    def fake_translate(cfg, text, prev="", nxt="", expected_lines=0, **kw):
        calls.append(text)
        return {"aligned": False, "text": "REAL:" + text, "error": None}

    from suboverlay.queue_cache import TranslationCache
    monkeypatch.setattr(P, "translate_group", fake_translate)
    db = os.path.join(str(tmp_path), "t.db")

    e1 = mk_configured_engine(tmp_path, mock=True, db=db)
    s = e1.settings
    e1.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, JSON3)
    e1.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1500.0,
                     "playing": True, "playback_rate": 1.0,
                     "timestamp": time.time() * 1000})
    d = wait_trans(e1)
    assert d["trans"].startswith("【译】"), "Mock is the verification stand-in"
    assert calls == [], "Mock must not touch the provider"
    e1._queue.shutdown()

    # the user unchecks Mock in Settings and comes back to the same sentence
    s["provider"]["mock"] = False
    e2 = Engine(s, cache=TranslationCache(db), workers=2)
    e2.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, JSON3)
    e2.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1500.0,
                     "playing": True, "playback_rate": 1.0,
                     "timestamp": time.time() * 1000})
    d = wait_trans(e2)
    assert not d["trans"].startswith("【译】"), \
        "the cached Mock echo was served as a real translation"
    assert d["trans"].startswith("REAL:"), d["trans"]
    assert calls, "unchecking Mock must issue a real request"
    real, n_calls = d["trans"], len(calls)
    e2._queue.shutdown()

    # the real translation keeps its own cache behaviour: same sentence, no wire
    e3 = Engine(s, cache=TranslationCache(db), workers=2)
    e3.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, JSON3)
    e3.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1500.0,
                     "playing": True, "playback_rate": 1.0,
                     "timestamp": time.time() * 1000})
    assert wait_trans(e3)["trans"] == real, "a real translation must still hit the cache"
    assert len(calls) == n_calls, "a cache hit must not reach the provider again"
    e3._queue.shutdown()


def test_pure_mock_translation_is_still_cached(tmp_path):
    """Issue #31 acceptance: pure Mock (no base_url / model) keeps its old cache
    behaviour - a second engine replaying the same sentence reuses the cached
    echo. Counted at the translator: the Mock translator is fast, so only the
    call count can tell a cache hit from a fresh translation."""
    from suboverlay.queue_cache import TranslationCache
    db = os.path.join(str(tmp_path), "t.db")
    s = default_settings()
    s["provider"]["mock"] = True           # no base_url, no model: pure Mock
    s["prompt"]["context_groups"] = 0      # one job per run, so the count is exact
    calls, holder = [], {}

    def counting(job):
        calls.append(job.identity)
        return holder["default"](job)      # the real Mock translator

    def run():
        e = Engine(s, cache=TranslationCache(db), workers=2, translate_fn=counting)
        holder["default"] = e._default_translate
        e.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, JSON3)
        e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1500.0,
                        "playing": True, "playback_rate": 1.0,
                        "timestamp": time.time() * 1000})
        d = wait_trans(e)
        e._queue.shutdown()
        return d

    assert run()["trans"].startswith("【译】"), "Mock is still the stand-in"
    assert len(calls) == 1, "the first run must actually translate"
    assert run()["trans"].startswith("【译】"), "same sentence, second engine + same db"
    assert len(calls) == 1, "pure Mock must still be served from the cache"


def test_turning_mock_off_retranslates_the_current_sentence(tmp_path, monkeypatch):
    """Issue #31: the same session, no restart. Translations already held in
    memory were produced by the old provider, so they must be dropped when the
    provider namespace changes - otherwise the Mock echo stays on screen and the
    current sentence is never re-requested."""
    import suboverlay.provider as P
    calls = []

    def fake_translate(cfg, text, prev="", nxt="", expected_lines=0, **kw):
        calls.append(text)
        return {"aligned": False, "text": "REAL:" + text, "error": None}

    monkeypatch.setattr(P, "translate_group", fake_translate)
    e = mk_configured_engine(tmp_path, mock=True)
    s = e.settings
    e.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, JSON3)
    e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1500.0,
                    "playing": True, "playback_rate": 1.0,
                    "timestamp": time.time() * 1000})
    assert wait_trans(e)["trans"].startswith("【译】")

    s["provider"]["mock"] = False  # Settings dialog mutates the live dict
    d = wait_trans(e, lambda d: d["trans"].startswith("REAL:"))
    assert d["trans"].startswith("REAL:"), "the same sentence must be re-requested"
    assert calls, "a real request must have been made"
    e._queue.shutdown()


def test_a_queued_job_uses_the_provider_its_identity_was_computed_from(tmp_path):
    """Issue #31 (concurrency): the identity is computed at submit time, but the
    worker used to translate with the *live* settings. A Mock toggle while a job
    sat in the queue therefore cached a Mock echo under the real identity (or a
    real translation under the Mock one). The job carries its provider snapshot."""
    from suboverlay.queue_cache import TranslationJob, URGENT
    e = mk_configured_engine(tmp_path, mock=True)
    s = e.settings
    job = TranslationJob("id", URGENT, "s1", 0, "hello", provider=dict(s["provider"]))
    s["provider"]["mock"] = False  # toggled while the job waits in the queue
    r = e._default_translate(job)
    assert r["text"] == "【译】hello", \
        "the worker must translate with the provider its identity describes"
    # a job submitted without a snapshot falls back to live settings - here the
    # live settings say there is nothing to translate with
    s["provider"].update({"base_url": "", "model": ""})
    bare = TranslationJob("bare", URGENT, "s1", 0, "hello")
    assert e._default_translate(bare)["error"] == "NOT_CONFIGURED"
    e._queue.shutdown()


def test_a_result_from_the_previous_provider_namespace_is_dropped(tmp_path):
    """Issue #31 (concurrency): a job already in flight when Mock is toggled must
    not paint the old provider's text over the new namespace - and a result from
    the current namespace must still land."""
    from suboverlay.queue_cache import TranslationCache, TranslationJob, URGENT
    s = default_settings()
    s["provider"].update({"base_url": "https://api.example.test/v1", "api_key": "sk-test",
                          "model": "test-model", "mock": True})
    # a stub translator that never returns a usable result: this test drives
    # _on_done itself, so nothing may land from the queue on its own
    e = Engine(s, cache=TranslationCache(os.path.join(str(tmp_path), "t.db")), workers=2,
               translate_fn=lambda job: {"error": "STUB"})
    e.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, JSON3)
    e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1500.0,
                    "playing": True, "playback_rate": 1.0, "timestamp": time.time() * 1000})
    e.tick()  # stamps the Mock namespace and submits this group
    src = e.sources["s1"]
    gi = src.last_group_idx
    assert gi is not None and e._provider_ns, "a tick must have established the namespace"
    stale = TranslationJob("stale", URGENT, "s1", gi, "x", namespace="OLD-NS")
    e._on_done(stale, {"aligned": False, "text": "【译】old provider", "error": None})
    assert not src.group_trans.get(gi), "the old namespace's result must be dropped"
    fresh = TranslationJob("fresh", URGENT, "s1", gi, "x", namespace=e._provider_ns)
    e._on_done(fresh, {"aligned": False, "text": "REAL", "error": None})
    assert src.group_trans.get(gi) == "REAL", "the current namespace must still land"
    e._queue.shutdown()


def test_unconfigured_provider_never_fabricates_a_translation():
    """Issue #1 (bug): with no base_url / model and Mock mode off, "no translation"
    must mean an empty translation row - not the original text wearing a fake label.
    Mock is a verification stand-in (DESIGN.md sec.2), so it stays opt-in: an
    unconfigured provider must leave the translation row empty rather than echo
    the original."""
    from suboverlay.queue_cache import TranslationCache
    s = default_settings()
    assert s["provider"]["base_url"] == "" and s["provider"]["model"] == ""
    assert not s["provider"].get("mock"), "mock must be off unless the user turns it on"
    e = Engine(s, cache=TranslationCache(os.path.join(tempfile.mkdtemp(), "t.db")), workers=2)
    e.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr", "tab_title": "T"}, JSON3)
    e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1500.0,
                    "playing": True, "playback_rate": 1.0, "timestamp": time.time() * 1000})
    deadline = time.time() + 0.8
    d = e.tick()
    while time.time() < deadline:
        d = e.tick()
        time.sleep(0.05)
    assert d["state"] == "ok"
    assert d["orig"].startswith("the cat"), "the original must still be shown"
    assert d["trans"] == "", "an unconfigured provider must not produce a translation"
    e._queue.shutdown()


def test_engine_reports_whether_a_translation_is_possible_at_all():
    """Issue #1 (display half): the overlay must not read provider config to decide
    whether a translation is coming, so the display state carries the engine's one
    authority - _provider_usable(). An empty translation is not evidence by itself:
    with a usable provider it means "still in flight"."""
    from suboverlay.queue_cache import TranslationCache

    def display_with(provider_update):
        s = default_settings()
        s["provider"].update(provider_update)
        # stub translator: this test is about the flag, never about the wire
        e = Engine(s, cache=TranslationCache(os.path.join(tempfile.mkdtemp(), "t.db")),
                   workers=1, translate_fn=lambda job: {"aligned": False, "text": "",
                                                        "error": "STUB"})
        e.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, JSON3)
        e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1500.0,
                        "playing": True, "playback_rate": 1.0, "timestamp": time.time() * 1000})
        d = e.tick()
        e._queue.shutdown()
        return d

    assert display_with({})["trans_available"] is False
    assert display_with({"mock": True})["trans_available"] is True
    assert display_with({"base_url": "https://api.example.test/v1",
                         "model": "test-model"})["trans_available"] is True
