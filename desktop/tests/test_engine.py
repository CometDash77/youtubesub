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
    workers racing results back in (#38). Batch members submitted via
    submit_batch are recorded individually, in order (#24)."""

    def __init__(self):
        self.jobs = []     # every job, in submission order
        self.batches = []  # one list per submit_batch call - the chunk boundaries

    def submit(self, job):
        self.jobs.append(job)
        return True

    def submit_batch(self, jobs):
        self.batches.append(list(jobs))
        self.jobs.extend(jobs)
        return True

    def in_backoff(self):
        return False  # never in backoff: a refill must never be deferred here

    def cancel_source(self, source_id):
        return 0  # nothing runs here, so nothing is pending to cancel


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

    def counting(jobs):
        calls.extend(j.identity for j in jobs)
        return holder["default"](jobs)     # the real Mock translator (job list)

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
    r = e._default_translate([job])[0]  # the seam takes a job list (#24)
    assert r["text"] == "【译】hello", \
        "the worker must translate with the provider its identity describes"
    # a job submitted without a snapshot falls back to live settings - here the
    # live settings say there is nothing to translate with
    s["provider"].update({"base_url": "", "model": ""})
    bare = TranslationJob("bare", URGENT, "s1", 0, "hello")
    assert e._default_translate([bare])[0]["error"] == "NOT_CONFIGURED", \
        "the fallback must read live settings, not the job's old snapshot"
    e._queue.shutdown()


def test_system_prompt_from_settings_reaches_the_provider(tmp_path, monkeypatch):
    """#23 / ADR-005 same-cfg invariant: the dialog's system prompt must be on
    the wire. It used to enter only the cache identity, so production sent the
    library default while the connection test (which sends the form value)
    would have tested something production did not use."""
    import suboverlay.provider as P
    captured = []

    def fake(cfg, text, prev="", nxt="", expected_lines=0, **kw):
        captured.append(dict(cfg))
        return {"aligned": False, "text": "T", "error": None}

    monkeypatch.setattr(P, "translate_group", fake)
    e = mk_engine(tmp_path, mock=False, base_url=CFG_URL, model=CFG_MODEL)
    # #39 schema: the prompt text lives in the active preset; the legacy
    # prompt.system key is migrated away and never read.
    e.settings["prompt"]["presets"] = [{"id": "prompt_cafe0000",
                                        "name": "Form", "text": "CUSTOM PROMPT LINE"}]
    e.settings["prompt"]["active"] = "prompt_cafe0000"
    e.ingest_json3("s1", {"video_id": "v1", "track_kind": "asr"}, JSON3)
    e.handle_event({"type": "sync", "source_id": "s1", "video_time_ms": 1500.0,
                    "playing": True, "playback_rate": 1.0,
                    "timestamp": time.time() * 1000})
    d = wait_trans(e)
    assert d["trans"] == "T"
    assert captured, "the real provider path must have been taken"
    assert captured[0]["system"] == "CUSTOM PROMPT LINE", \
        "the form prompt must reach the wire, not just the cache identity"
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
               translate_fn=lambda jobs: [{"error": "STUB"} for _ in jobs])
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
                   workers=1, translate_fn=lambda jobs: [{"aligned": False, "text": "",
                                                          "error": "STUB"} for _ in jobs])
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


# ---- spec #24: prefetch window (seconds), fill chunking, debounce, batching ----


def sentence_cues(count, gap_ms, chars=0, prefix="Line"):
    """One sentence-final cue per group: every text ends with a period, which
    fires the sentence-final criterion, so `count` cues produce `count` groups
    with deterministic starts (i * gap_ms). `chars` pads each text long enough
    to make the batch CHAR budget bind."""
    tail = ("W" * chars) if chars else ""
    return [{"start_ms": i * float(gap_ms), "end_ms": i * float(gap_ms) + gap_ms - 50.0,
             "text": "%s%s %d ends here." % (tail, prefix, i)}
            for i in range(count)]


def sync_at(e, sid, ms, playing=True):
    e.handle_event({"type": "sync", "source_id": sid, "video_time_ms": float(ms),
                    "playing": playing, "playback_rate": 1.0,
                    "timestamp": time.time() * 1000})


def recorded_fill(e, cues, t_ms):
    """Run ONE tick against a RecordingQueue and return (jobs, batches).

    The submission shape is observed at the queue boundary, so no worker can
    reorder or complete anything first - the exact submitted set is the
    assertion surface (spec #24 Testing Decisions: submit shape + display
    state, never internal callables)."""
    e.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                    "track_kind": "manual", "track_lang": "en", "cues": cues})
    sync_at(e, "s1", t_ms, playing=True)
    real_q = e._queue
    rec = RecordingQueue()
    e._queue = rec
    try:
        d = e.tick()
        assert d["state"] == "ok"
    finally:
        e._queue = real_q
        real_q.shutdown()
    return rec.jobs, rec.batches


def recording_engine(tmpdir, **kw):
    """Engine whose translate seam records every job LIST it is asked to run
    (the widened #24 seam) and then executes it with the real Mock translator."""
    calls, holder = [], {}

    def rec(jobs):
        calls.append(list(jobs))
        return holder["default"](jobs)

    e = mk_engine(tmpdir, translate_fn=rec, **kw)
    holder["default"] = e._default_translate
    return e, calls


def wait_for(pred, timeout=5.0, tick=None):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        if tick is not None:
            tick()
        time.sleep(0.02)
    return False


def test_prefetch_window_is_measured_in_seconds(tmp_path):
    """US1: the lead is 90 SECONDS of video time, whatever the subtitle
    density. Groups every 30s: groups 0..3 start within [t, t+90s] and are
    the whole submitted set - group 4 (120s) stays out, however few groups
    that leaves."""
    e = mk_engine(tmp_path)
    jobs, _ = recorded_fill(e, sentence_cues(6, 30000), t_ms=0)
    got = [j.group_idx for j in jobs]
    assert got == [0, 1, 2, 3], "window = playhead + 90s, got %r" % (got,)


def test_prefetch_window_group_cap_truncates_dense_subtitles(tmp_path):
    """US2: the hard group cap bounds a dense window before the seconds do -
    100 groups inside 20s of video: exactly 20 groups submitted (1 urgent +
    19 fill), never the whole dense run."""
    e = mk_engine(tmp_path)
    jobs, _ = recorded_fill(e, sentence_cues(100, 200), t_ms=0)
    got = [j.group_idx for j in jobs]
    assert len(got) == 20, "cap must truncate the submission to 20, got %d" % len(got)
    assert got == list(range(20)), got


def test_steady_state_cross_submits_exactly_one_group(tmp_path):
    """US3 + US11: the window advances with playback. After the initial burst
    fill completes, crossing into the next group submits ONLY the one group the
    advancing window just swept in - no re-submission of finished groups, and
    the steady-state translate call carries exactly one job (batch size 1)."""
    e, calls = recording_engine(tmp_path)
    # Groups every 2400ms: crossing the boundary is a plain progress step
    # (< the 2500ms seek threshold), and the 20-group cap binds before the
    # 90s horizon does - so the advancing window has exactly ONE new group to
    # sweep in per cross.
    e.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                    "track_kind": "manual", "track_lang": "en",
                    "cues": sentence_cues(30, 2400)})
    sync_at(e, "s1", 0, playing=True)
    e.tick()
    # burst fill: current URGENT + groups 1..19 (cap-bounded window)
    assert wait_for(lambda: all(i in e.sources["s1"].group_trans
                                for i in range(1, 20)),
                    tick=e.tick), "the first window must fill"
    burst_calls = len(calls)
    # cross into group 1: the window slides by one - exactly one new group (20)
    sync_at(e, "s1", 2400, playing=True)
    e.tick()
    assert wait_for(lambda: e.sources["s1"].group_trans.get(20),
                    tick=e.tick), "the advancing window must sweep in group 20"
    new_calls = [c for c in calls[burst_calls:]]
    flat = [j.group_idx for c in new_calls for j in c]
    assert flat == [20], "a steady cross submits exactly one group: %r" % (flat,)
    assert len(new_calls[-1]) == 1, "steady state must stay one-request-per-group"
    seen = [j.group_idx for c in calls for j in c]
    assert len(seen) == len(set(seen)), \
        "a finished group must never be submitted twice: %r" % (seen,)
    e._queue.shutdown()


def test_seek_debounces_the_window_refill_but_never_the_urgent_path(tmp_path):
    """US4 + US5 + decisions 2/3/4: a timeline jump silences the WINDOW
    refill for the debounce period (dragging the bar cannot re-fire the whole
    window), the sentence at the new spot still goes out immediately (URGENT
    is never debounced), the refill lands right after the quiet period, and an
    in-flight request is not interrupted - its result still lands."""
    gate = {"hold": True}
    calls, holder = [], {}

    def rec(jobs):
        calls.append(list(jobs))          # record on entry, before blocking
        while gate["hold"]:
            time.sleep(0.01)
        return holder["default"](jobs)

    e = mk_engine(tmp_path, workers=4, translate_fn=rec)
    holder["default"] = e._default_translate
    e.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                    "track_kind": "manual", "track_lang": "en",
                    "cues": sentence_cues(10, 30000)})
    sync_at(e, "s1", 0, playing=True)
    e.tick()  # burst fill: urgent(0) + batch(1,2,3) - workers now blocked
    assert wait_for(lambda: len(calls) >= 2), "the first window must be submitted"

    seek_wall = time.time()
    sync_at(e, "s1", 180000, playing=True)  # jump 180s, far beyond 2500ms
    e.tick()
    assert wait_for(lambda: any(j.group_idx == 6 for c in calls for j in c)), \
        "URGENT at the seek target must go out immediately (never debounced)"
    assert time.time() - seek_wall < 0.4, \
        "the urgent path must not wait out the debounce"

    # still inside the quiet period: no window refill may happen
    e.tick()
    time.sleep(0.15)
    e.tick()
    early = {j.group_idx for c in calls for j in c}
    assert not ({7, 8, 9} & early), "the window must stay silent during the debounce"

    # quiet period over: the refill lands (US5 - immediately on the next tick)
    assert wait_for(lambda: time.time() - seek_wall > 0.45, timeout=2.0)
    e.tick()
    assert wait_for(lambda: {7, 8, 9} <= {j.group_idx for c in calls for j in c}), \
        "the window must refill right after the quiet period"

    # in-flight is never interrupted (decision 4)
    gate["hold"] = False
    assert wait_for(lambda: bool(e.sources["s1"].group_trans.get(0)), tick=e.tick), \
        "an in-flight request must survive the seek and still land"
    e._queue.shutdown()


def test_paused_playback_starts_no_prefetch(tmp_path):
    """US6: paused, the on-screen sentence may still be requested, but no
    NEW prefetch leaves the queue - the window fill is gated on playback."""
    e, calls = recording_engine(tmp_path)
    e.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                    "track_kind": "manual", "track_lang": "en",
                    "cues": sentence_cues(6, 30000)})
    sync_at(e, "s1", 0, playing=False)
    deadline = time.time() + 0.4
    while time.time() < deadline:
        e.tick()
        time.sleep(0.02)
    submitted = [j.group_idx for c in calls for j in c]
    assert set(submitted) <= {0}, "paused playback must not prefetch: %r" % (submitted,)
    # playing again: the window fills
    sync_at(e, "s1", 0, playing=True)
    e.tick()
    assert wait_for(lambda: {1, 2, 3} <= {j.group_idx for c in calls for j in c},
                    tick=e.tick), "resuming playback must fill the window"
    e._queue.shutdown()


def test_context_switch_off_does_not_gate_prefetch(tmp_path):
    """US17: prompt.context_groups only shapes the prompt. With it OFF the
    window still fills and the ahead groups still get translated - the old
    coupling between the context switch and the lookahead is gone."""
    e, calls = recording_engine(tmp_path)
    e.settings["prompt"]["context_groups"] = 0
    e.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                    "track_kind": "manual", "track_lang": "en",
                    "cues": sentence_cues(6, 30000)})
    sync_at(e, "s1", 0, playing=True)
    e.tick()
    assert wait_for(lambda: e.sources["s1"].group_trans.get(1),
                    tick=e.tick), "prefetch must run with the context switch off"
    prefetched = [j for c in calls for j in c if j.group_idx != 0]
    assert prefetched, "the window must have submitted ahead groups"
    assert all(j.prev == "" and j.nxt == "" for j in prefetched), \
        "context off must still shape the prompt (no neighbour context)"
    e._queue.shutdown()


def test_fill_chunks_respect_both_caps(tmp_path):
    """US10 + decision 5: at the burst point the pending groups are chunked.
    Group cap: 19 pending groups -> exactly ceil(19/8) = 3 chunks, none over
    8 groups and none over 8000 chars. Char cap: four 3001-char groups
    (context off) -> the 8000-char budget splits them 2+2 although the group
    cap alone would have allowed all four together."""
    # (a) group cap binds
    e = mk_engine(tmp_path)
    jobs, batches = recorded_fill(e, sentence_cues(30, 200), t_ms=0)
    assert [j.group_idx for j in jobs] == list(range(20))  # 1 urgent + cap 20
    pending = jobs[1:]
    assert len(batches) == (len(pending) + 7) // 8 == 3, \
        "batch count must be ceil(groups / batch.max_groups)"
    for b in batches:
        assert 2 <= len(b) <= 8, "every batch must respect the group cap"
        chars = sum(len(j.group_text) + len(j.prev) + len(j.nxt) for j in b)
        assert chars <= 8000, "every batch must respect the char cap"

    # (b) char cap binds: FIVE groups - group 0 goes URGENT alone, the four
    # pending 3017-char groups chunk 2+2 under the 8000-char budget.
    e2 = mk_engine(tempfile.mkdtemp())
    e2.settings["prompt"]["context_groups"] = 0  # chars = the text itself
    _, batches2 = recorded_fill(e2, sentence_cues(5, 2000, chars=3000), t_ms=0)
    assert [len(b) for b in batches2] == [2, 2], \
        "3001*2 = 6002 <= 8000 but 3001*3 > 8000: the char cap must split 2+2"
    for b in batches2:
        assert sum(len(j.group_text) for j in b) <= 8000


def test_batch_failure_voids_the_batch_and_urgent_recovers(tmp_path):
    """US12 + US13 + US14 + decision 9: a failed batch writes NOTHING - no
    cache row, no placeholder in any cue - and the playhead reaching a member
    later re-translates it through the urgent single path, landing both the
    translation and the cache row under the byte-identical identity the batch
    job carried (decision 11)."""
    calls, holder = [], {}

    def fail_batches(jobs):
        calls.append(list(jobs))
        if len(jobs) > 1:
            return [{"aligned": False, "text": "", "error": "SHAPE_MISS",
                     "message": "contract miss"} for _ in jobs]
        return holder["default"](jobs)

    e = mk_engine(tmp_path, translate_fn=fail_batches)
    holder["default"] = e._default_translate
    e.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                    "track_kind": "manual", "track_lang": "en",
                    "cues": sentence_cues(6, 30000)})
    sync_at(e, "s1", 0, playing=True)
    e.tick()
    assert wait_for(lambda: any(len(c) > 1 for c in calls)), "the fill must batch"
    batch_jobs = next(c for c in calls if len(c) > 1)
    assert wait_for(lambda: e._queue.stats() == {"pending": 0, "inflight": 0}), \
        "the failed batch must finish (it writes nothing)"
    src = e.sources["s1"]
    # group 0 went out URGENT (single path, succeeded); the batch members must
    # have landed NOTHING - no translation, no placeholder.
    assert all(i not in src.group_trans for i in (1, 2, 3)), \
        "a failed batch must not land anything"
    assert all(not src.cues[i].trans for i in (1, 2, 3)), \
        "no placeholders may be left behind"
    for j in batch_jobs:
        assert e._cache.get(j.identity) is None, "a failed batch must not write the cache"
    # playhead reaches group 1: the urgent single path recovers it
    sync_at(e, "s1", 30050, playing=True)
    e.tick()
    assert wait_for(lambda: bool(src.group_trans.get(1)), tick=e.tick), \
        "the urgent path must re-translate what the batch dropped"
    member = next(j for j in batch_jobs if j.group_idx == 1)
    assert e._cache.get(member.identity) is not None, \
        "the urgent result lands under the SAME identity the batch job carried"
    e._queue.shutdown()


def test_batch_then_single_hits_the_same_cache(tmp_path):
    """US15 + US23 + decisions 10/11: a group translated through a batch is
    cached under its own single-path identity. A fresh engine over the same
    cache with the playhead inside that group serves it WITHOUT any translate
    call - the same group is never translated (or paid for) twice."""
    db = os.path.join(str(tmp_path), "t.db")
    # 4 groups: the first fill covers ALL of them, so every group the second
    # session's window can ask about is already in the shared cache.
    e1 = mk_engine(tmp_path, db=db)
    e1.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                     "track_kind": "manual", "track_lang": "en",
                     "cues": sentence_cues(4, 30000)})
    sync_at(e1, "s1", 0, playing=True)
    e1.tick()
    assert wait_for(lambda: all(i in e1.sources["s1"].group_trans for i in (1, 2, 3)),
                    tick=e1.tick), "the first window must fill (through a batch)"
    e1._queue.shutdown()

    # second engine, same cache, same settings: playhead INSIDE group 1
    e2, calls = recording_engine(tmp_path, db=db)
    e2.handle_event({"type": "cues", "source_id": "s1", "video_id": "v1",
                     "track_kind": "manual", "track_lang": "en",
                     "cues": sentence_cues(4, 30000)})
    sync_at(e2, "s1", 30050, playing=True)
    e2.tick()
    assert wait_for(lambda: bool(e2.sources["s1"].group_trans.get(1)), tick=e2.tick), \
        "the batch-cached translation must be served to the new session"
    assert calls == [], "a cache hit must not produce any translate call"
    e2._queue.shutdown()


def test_worker_pool_reads_max_concurrent_with_clamp(tmp_path):
    """US21 + decision 13: the configured concurrency limit actually takes
    effect - the Engine worker pool is provider.max_concurrent clamped to
    [1, 16], default 5 (restart-effective, read at construction)."""
    from suboverlay.engine import resolve_workers
    assert resolve_workers({}) == 5
    assert resolve_workers({"provider": {}}) == 5
    assert resolve_workers({"provider": {"max_concurrent": 1}}) == 1
    assert resolve_workers({"provider": {"max_concurrent": 16}}) == 16
    assert resolve_workers({"provider": {"max_concurrent": 0}}) == 1    # clamp low
    assert resolve_workers({"provider": {"max_concurrent": 99}}) == 16  # clamp high
    assert resolve_workers({"provider": {"max_concurrent": "x"}}) == 5
    assert resolve_workers({"provider": {"max_concurrent": None}}) == 5
    from suboverlay.queue_cache import TranslationCache
    s = default_settings()
    s["provider"]["mock"] = True
    s["provider"]["max_concurrent"] = 3
    e = Engine(s, cache=TranslationCache(os.path.join(str(tmp_path), "w.db")))
    assert e._workers == 3 and len(e._queue._threads) == 3, \
        "the pool must be built from the configured limit"
    e._queue.shutdown()


def test_switching_away_drops_the_old_sources_pending_prefetch(tmp_path):
    """US9: watching another video (or a track refresh) stops paying for the
    old one - its PENDING window fill is dropped the moment the new source
    takes over - while the request already in flight still lands: its cache
    identity is playhead-independent and worth keeping (decision 4)."""
    gate = {"hold": True}
    calls, holder = [], {}

    def rec(jobs):
        calls.append(list(jobs))
        while gate["hold"]:
            time.sleep(0.01)
        return holder["default"](jobs)

    e = mk_engine(tmp_path, workers=1, translate_fn=rec)
    holder["default"] = e._default_translate
    e.handle_event({"type": "cues", "source_id": "old", "video_id": "vA",
                    "track_kind": "manual", "track_lang": "en",
                    "cues": sentence_cues(6, 30000)})
    sync_at(e, "old", 0, playing=True)
    e.tick()  # workers=1: urgent(old, 0) runs and blocks; batch(old, 1..3) PENDS
    assert wait_for(lambda: len(calls) == 1), "the urgent job must be in flight"

    # another video takes over: the old source's pending fill is dropped
    e.handle_event({"type": "register", "source_id": "new", "video_id": "vB",
                    "track_kind": "manual"})
    assert e.active_source == "new"
    gate["hold"] = False
    assert wait_for(lambda: e._queue.stats() == {"pending": 0, "inflight": 0},
                    tick=e.tick), "the old pending fill must be cancelled, not run"
    assert e.sources["old"].group_trans.get(0), \
        "the in-flight request must still land (never interrupted)"
    assert len(calls) == 1, \
        "the old source's pending window fill must never be paid for: %r" % (
            [[j.group_idx for j in c] for c in calls],)
    e._queue.shutdown()
