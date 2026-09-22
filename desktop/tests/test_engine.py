"""Engine pipeline tests: cues -> groups -> queue -> mock translate -> display."""
import json, os, sys, tempfile, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from suboverlay.engine import Engine
from suboverlay.settings import default_settings


CFG_URL = "https://api.example.test/v1"
CFG_MODEL = "test-model"


def mk_engine(tmpdir, mock=True, base_url="", model="", db=None, workers=2,
              translate_fn=None):
    """An engine over a SQLite cache in tmpdir.

    Mock on *and* a real endpoint configured (base_url + model) is the overlap
    issue #31 is about: _provider_usable() accepts either, and the Mock branch is
    the one taken. The settings dict belongs to that engine, so a test can edit
    it in place the way the Settings dialog does."""
    from suboverlay.queue_cache import TranslationCache
    s = default_settings()
    s["provider"].update({"mock": mock, "base_url": base_url, "model": model})
    if base_url:
        s["provider"]["api_key"] = "sk-test"
    cache = TranslationCache(db or os.path.join(str(tmpdir), "t.db"))
    return Engine(s, cache=cache, workers=workers, translate_fn=translate_fn)


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

# A single cue and nothing after it: with prefetch decoupled (#38) an exact
# translate-call count can only come from having no lookahead groups to submit.
ONE_GROUP = {"events": [
    {"tStartMs": 1000, "dDurationMs": 3000, "segs": [{"utf8": "hello there friend"}]},
]}


def zh_cues(lines):
    """One cue per line, every line >5 chars: the zh quality gate keeps each
    line its own group, so neighbour positions are deterministic (#38 fixtures)."""
    return [{"start_ms": i * 1100.0, "end_ms": i * 1100.0 + 1000.0, "text": t}
            for i, t in enumerate(lines)]


ZH3 = ["这是一行比较长的字幕", "另一行同样很长的字", "第三行也相当的长啊"]
ZH5 = ZH3 + ["第四行继续写长一点呢", "第五行还是那么长啊嘿"]


class RecordingQueue:
    """Stand-in for TranslationQueue that records every submitted job and runs
    nothing - so a scheduling test can assert the exact submitted set without
    workers racing results back in (#38)."""

    def __init__(self):
        self.jobs = []

    def submit(self, job):
        self.jobs.append(job)
        return True


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

    e1 = mk_engine(tmp_path, mock=True, base_url=CFG_URL, model=CFG_MODEL, db=db)
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
    call count can tell a cache hit from a fresh translation.

    The fixture is one cue with nothing after it. Prefetch is unconditional
    since #38 (decoupled from context_groups), so an exact count must come from
    having no lookahead groups to submit - NOT from flipping the prompt switch,
    which the old version of this test leaned on (the coupling #38 removed)."""
    db = os.path.join(str(tmp_path), "t.db")
    calls, holder = [], {}

    def counting(job):
        calls.append(job.identity)
        return holder["default"](job)      # the real Mock translator

    def run():
        # no base_url, no model: pure Mock. One group and no following group, so
        # the unconditional prefetch has nothing ahead to submit -> one job.
        e = mk_engine(tmp_path, mock=True, db=db, translate_fn=counting)
        holder["default"] = e._default_translate
        e.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, ONE_GROUP)
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
    e = mk_engine(tmp_path, mock=True, base_url=CFG_URL, model=CFG_MODEL)
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
    from suboverlay.queue_cache import TranslationJob, ProviderContext, URGENT
    e = mk_engine(tmp_path, mock=True, base_url=CFG_URL, model=CFG_MODEL)
    s = e.settings
    job = TranslationJob("id", URGENT, "s1", 0, "hello",
                         context=ProviderContext(dict(s["provider"]), "ns"))
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
    from suboverlay.queue_cache import TranslationCache, TranslationJob, ProviderContext, URGENT
    s = default_settings()
    s["provider"].update({"base_url": CFG_URL, "api_key": "sk-test",
                          "model": CFG_MODEL, "mock": True})
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
    stale = TranslationJob("stale", URGENT, "s1", gi, "x",
                           context=ProviderContext(dict(s["provider"]), "OLD-NS"))
    e._on_done(stale, {"aligned": False, "text": "【译】old provider", "error": None})
    assert not src.group_trans.get(gi), "the old namespace's result must be dropped"
    fresh = TranslationJob("fresh", URGENT, "s1", gi, "x",
                           context=ProviderContext(dict(s["provider"]), e._provider_ns))
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


def test_status_always_carries_a_translation_authority():
    """The documented /status contract (docs/PROTOCOL.md): trans_available is
    _provider_usable even before the first tick produced a display state - a
    configured provider must not read as "no translation" on a fresh app."""
    from suboverlay.queue_cache import TranslationCache
    s = default_settings()
    e = Engine(s, cache=TranslationCache(os.path.join(tempfile.mkdtemp(), "t.db")), workers=1)
    assert e.last_display is None
    assert e.status()["display"]["trans_available"] is False
    s["provider"]["mock"] = True
    assert e.status()["display"]["trans_available"] is True
    # the no_cues display state carries it too, so /status never goes stale while
    # a source is registered but its cues have not arrived yet
    e.handle_event({"type": "register", "source_id": "s1", "video_id": "v1", "tab_title": "T"})
    d = e.tick()
    assert d["state"] == "no_cues"
    assert d["trans_available"] is True and e.status()["display"]["trans_available"] is True
    e._queue.shutdown()


def test_track_language_from_register_frame_reaches_segmentation():
    """#25: segmentation reads the STORED track language. The register frame
    carries zh; the cues frame omits the key entirely - the quality gate must
    still fire (one cue per group), proving the register path is covered and
    the stored value survives a frame without the field."""
    e = mk_engine(tempfile.mkdtemp())
    e.handle_event({"type": "register", "source_id": "s1", "video_id": "v1",
                    "track_kind": "manual", "track_lang": "zh"})
    long_lines = ["这是一行比较长的字幕", "另一行同样很长的字", "第三行也相当的长啊"]
    e.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                    "cues": [{"start_ms": i * 1100.0, "end_ms": i * 1100.0 + 1000.0,
                              "text": t} for i, t in enumerate(long_lines)]})
    src = e.sources["s1"]
    assert [(g.start_idx, g.end_idx) for g in src.groups] == [(0, 0), (1, 1), (2, 2)]
    e._queue.shutdown()


def test_track_language_from_the_cues_frame_selects_the_branch():
    """#25: the cues frame alone can carry the language (no register first)."""
    e = mk_engine(tempfile.mkdtemp())
    long_lines = ["这是一行比较长的字幕", "另一行同样很长的字", "第三行也相当的长啊"]
    e.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                    "track_kind": "manual", "track_lang": "zh",
                    "cues": [{"start_ms": i * 1100.0, "end_ms": i * 1100.0 + 1000.0,
                              "text": t} for i, t in enumerate(long_lines)]})
    src = e.sources["s1"]
    assert [(g.start_idx, g.end_idx) for g in src.groups] == [(0, 0), (1, 1), (2, 2)]
    e._queue.shutdown()


def test_missing_track_language_defaults_to_space_criteria():
    """#25: no language anywhere never crashes and selects the space-language
    branch - the same long zh lines merge instead of hitting the gate."""
    e = mk_engine(tempfile.mkdtemp())
    long_lines = ["这是一行比较长的字幕", "另一行同样很长的字", "第三行也相当的长啊"]
    e.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                    "cues": [{"start_ms": i * 1100.0, "end_ms": i * 1100.0 + 1000.0,
                              "text": t} for i, t in enumerate(long_lines)]})
    src = e.sources["s1"]
    assert [(g.start_idx, g.end_idx) for g in src.groups] == [(0, 2)]
    e._queue.shutdown()


def test_non_speech_cue_gets_no_translation_and_group_ranges_stay_contiguous():
    """#28: [Music] joins no group - forced breaks around it, a gap in the
    cue-to-group map, and the row-count invariant (returned lines == cues in
    the group) holds across that gap. The overlay shows the music's original
    text with no translation."""
    e = mk_engine(tempfile.mkdtemp())
    e.ingest_json3("s1", {"video_id": "v1", "track_kind": "manual",
                          "track_lang": "en"},
                   {"events": [
                       {"tStartMs": 0, "dDurationMs": 1000,
                        "segs": [{"utf8": "spoken one line"}]},
                       {"tStartMs": 1100, "dDurationMs": 1000,
                        "segs": [{"utf8": "spoken two line"}]},
                       {"tStartMs": 2200, "dDurationMs": 800,
                        "segs": [{"utf8": "[Music]"}]},
                       {"tStartMs": 3300, "dDurationMs": 1000,
                        "segs": [{"utf8": "spoken three line"}]}]})
    src = e.sources["s1"]
    assert len(src.cues) == 4
    assert [(g.start_idx, g.end_idx) for g in src.groups] == [(0, 1), (3, 3)]
    assert src.cue_to_group == {0: 0, 1: 0, 3: 1}
    # group0 goes out with expected lines == cues in the group; both speech
    # rows land, the music row never gets one
    e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 500.0,
                    "playing": True, "playback_rate": 1.0,
                    "timestamp": time.time() * 1000})
    d = wait_trans(e)
    assert d["trans"], "the speech group must still be translated"
    assert src.cues[0].trans and src.cues[1].trans, "row count == group cues"
    assert src.cues[2].trans == "", "the non-speech cue must get no translation"
    # at the music's own time: original text, no translation, no group submitted
    e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 2500.0,
                    "playing": True, "playback_rate": 1.0,
                    "timestamp": time.time() * 1000})
    d = e.tick()
    assert d["state"] == "ok"
    assert d["orig"] == "[Music]"
    assert d["trans"] == ""
    # prefetch walks the dense group list across the gap: the group after the
    # music is requested too (gi + off never lands on the missing cue index)
    deadline = time.time() + 5
    while time.time() < deadline and 1 not in src.group_trans:
        e.tick()
        time.sleep(0.02)
    assert 1 in src.group_trans, "prefetch must cross the non-speech gap"
    e._queue.shutdown()


def test_track_kind_does_not_change_the_criteria():
    """US13/US14: manual and ASR tracks share one set of criteria - track kind
    never reaches the segmentation code path, so identical cues group
    identically whatever the kind says. (What differs is only the promise:
    boundary parity with the reference is committed for manual tracks, not
    for ASR - a documentation-level distinction, per ADR-006.)"""
    e = mk_engine(tempfile.mkdtemp())
    groups_by_kind = {}
    for kind in ("manual", "asr"):
        e.ingest_json3("k-" + kind, {"video_id": "v1", "track_kind": kind,
                                     "track_lang": "en"}, JSON3)
        groups_by_kind[kind] = [(g.start_idx, g.end_idx, g.text)
                                for g in e.sources["k-" + kind].groups]
    assert groups_by_kind["manual"] == groups_by_kind["asr"]
    assert groups_by_kind["manual"], "the shared criteria still group something"
    e._queue.shutdown()


def test_identity_forks_on_context_and_is_byte_identical_when_unchanged(tmp_path):
    """#38 / ADR-009 contract - identity contains the neighbour context:
    - context_groups on vs off (same group, same config) -> different identity;
    - a neighbour's original text changed (everything else same) -> different
      identity, on both sides of the window;
    - the same group submitted twice with client_key and neighbours unchanged
      -> byte-identical identity. That last one is the regression net against
      "kiss does it out of the cache key": copying that would make every row
      above silently share cache entries (issue #31's twin)."""
    from suboverlay.queue_cache import URGENT
    e = mk_engine(tmp_path)
    e.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                    "track_kind": "manual", "track_lang": "zh", "cues": zh_cues(ZH3)})
    src = e.sources["s1"]
    assert [(g.start_idx, g.end_idx) for g in src.groups] == [(0, 0), (1, 1), (2, 2)]
    real_q = e._queue
    rec = e._queue = RecordingQueue()
    try:
        # (1) the prompt switch alone forks the identity
        e.settings["prompt"]["context_groups"] = 1
        e._submit_group(src, 1, URGENT)
        id_on = rec.jobs[-1].identity
        e.settings["prompt"]["context_groups"] = 0
        e._submit_group(src, 1, URGENT)
        id_off = rec.jobs[-1].identity
        assert id_on != id_off, "context on vs off must produce different identities"

        # (2) neighbour original text changed (rest identical) -> identity forks
        e.settings["prompt"]["context_groups"] = 1
        src.groups[0].text += "改"          # prev neighbour
        e._submit_group(src, 1, URGENT)
        id_prev = rec.jobs[-1].identity
        assert id_prev != id_on, "prev neighbour text must fork the identity"
        src.groups[2].text += "改"          # next neighbour
        e._submit_group(src, 1, URGENT)
        id_next = rec.jobs[-1].identity
        assert id_next != id_prev, "next neighbour text must fork the identity"

        # (3) unchanged inputs -> byte-identical identity across submissions
        e._submit_group(src, 1, URGENT)
        again = rec.jobs[-1].identity
        assert again.encode("utf-8") == id_next.encode("utf-8"), \
            "same group, same neighbours: identity must be byte-identical"
    finally:
        e._queue = real_q
        real_q.shutdown()


def test_prefetch_submission_set_does_not_follow_the_context_switch(tmp_path):
    """#38 / ADR-009 - prefetch is scheduling, not prompting. After the play
    advance event, BOTH settings submit the current group URGENT plus the
    PREFETCH_GROUPS lookahead NORMAL; the submitted set never varies with the
    prompt switch - only the identities (which carry context) may differ."""
    from suboverlay.queue_cache import URGENT, NORMAL

    def submitted(context_groups):
        e = mk_engine(tmp_path, db=os.path.join(str(tmp_path),
                                                "pf%d.db" % context_groups))
        e.settings["prompt"]["context_groups"] = context_groups
        e.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                        "track_kind": "manual", "track_lang": "zh",
                        "cues": zh_cues(ZH5)})
        assert len(e.sources["s1"].groups) == 5, "one group per zh line"
        real_q = e._queue
        rec = e._queue = RecordingQueue()
        try:
            e.handle_event({"type": "sync", "source_id": "s1",
                            "video_time_ms": 100.0, "playing": True,
                            "playback_rate": 1.0, "timestamp": time.time() * 1000})
            d = e.tick()
            assert d["state"] == "ok" and d["orig"] == ZH5[0]
        finally:
            e._queue = real_q
            real_q.shutdown()
        return ([(j.group_idx, j.priority) for j in rec.jobs],
                [j.identity for j in rec.jobs])

    on, ids_on = submitted(1)
    off, ids_off = submitted(0)
    want = [(0, URGENT)] + [(i, NORMAL) for i in range(1, 5)]
    assert on == want, "context on: current URGENT + 4 lookahead NORMAL"
    assert off == want, "context off must not gate the prefetch"
    assert ids_on != ids_off, "identities still differ - the switch only shapes the prompt"
