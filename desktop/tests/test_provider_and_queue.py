"""Tests: provider validation, cache identity, settings redaction, queue."""
import json, sys, os, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from suboverlay import provider as P
from suboverlay.queue_cache import cache_identity, TranslationCache, TranslationJob, TranslationQueue, URGENT, NORMAL
from suboverlay import settings as S


def test_coerce_endpoint_auto_and_rewrite():
    ep, pr = P.coerce_endpoint("https://api.deepseek.com", "auto")
    assert ep == "https://api.deepseek.com/responses" and pr == "responses"
    ep, pr = P.coerce_endpoint("https://o.ai/v1/chat/completions", "auto")
    assert ep.endswith("/v1/chat/completions") and pr == "chat-completions"
    ep, pr = P.coerce_endpoint("https://x.com/a/responses", "chat-completions")
    assert ep == "https://x.com/a/chat/completions"
    ep, pr = P.coerce_endpoint("https://x.com/v1", "responses")
    assert ep == "https://x.com/v1/responses"


def test_coerce_endpoint_rejects_bad():
    for bad in ("", "ftp://x", "notaurl", None):
        try:
            P.coerce_endpoint(bad, "auto")
            assert False, bad
        except P.ProviderError:
            pass
    try:
        P.coerce_endpoint("https://x.com", "weird")
        assert False
    except P.ProviderError:
        pass


def test_unpack_numbered_all_or_nothing():
    assert P.unpack_numbered("1|hello" + chr(10) + "2|world", 2) == ["hello", "world"]
    assert P.unpack_numbered("```json" + chr(10) + "1|a" + chr(10) + "2|b" + chr(10) + "```", 2) == ["a", "b"]
    assert P.unpack_numbered("1|a" + chr(10) + "3|b", 2) is None
    assert P.unpack_numbered("1|a" + chr(10) + "1|b", 2) is None
    assert P.unpack_numbered("1|a", 2) is None
    assert P.unpack_numbered("1|a" + chr(10) + "2|", 2) is None
    assert P.unpack_numbered("", 1) is None
    assert P.unpack_numbered("just text", 1) is None


def test_map_status_error_retryable():
    assert P.map_status_error(429, "x").retryable
    assert P.map_status_error(500, "x").retryable
    assert not P.map_status_error(401, "x").retryable
    assert not P.map_status_error(400, "x").retryable


def test_extract_complete_text_both_protocols():
    chat = {"choices": [{"message": {"content": "hi"}}]}
    resp = {"output_text": "yo"}
    resp2 = {"output": [{"content": [{"type": "output_text", "text": "a"}, {"type": "x"}]}]}
    assert P.extract_complete_text("chat-completions", chat) == "hi"
    assert P.extract_complete_text("responses", resp) == "yo"
    assert P.extract_complete_text("responses", resp2) == "a"
    try:
        P.extract_complete_text("chat-completions", {"nope": 1})
        assert False
    except P.ProviderError:
        pass


def test_cache_identity_excludes_api_key_and_is_stable():
    a = cache_identity({"base_url": "u", "model": "m", "api_key": "SECRET-A"}, "k", "i", "p")
    b = cache_identity({"base_url": "u", "model": "m", "api_key": "SECRET-B"}, "k", "i", "p")
    assert a == b and "SECRET" not in a
    c = cache_identity({"base_url": "u", "model": "m2", "api_key": "SECRET-A"}, "k", "i", "p")
    assert a != c
    d = cache_identity({"base_url": "u", "model": "m", "protocol": "auto"}, "k", "i", "p")
    e = cache_identity({"model": "m", "protocol": "auto", "base_url": "u"}, "k", "i", "p")
    assert d == e  # key-order insensitive


def test_cache_identity_separates_mock_from_real():
    """Issue #31 (bug): the Mock translator echoes the original behind a 【译】
    label - a different product from a real translation. Sharing one cache
    identity made unchecking Mock serve the echo as the real translation, so
    "this run was Mock" has to be a dimension of the identity."""
    real = cache_identity({"base_url": "u", "model": "m", "mock": False}, "k", "i", "p")
    mocked = cache_identity({"base_url": "u", "model": "m", "mock": True}, "k", "i", "p")
    assert real != mocked, "a Mock product must not be addressable as the real one"
    # an absent mock key means "off": a plain config is a real config
    assert cache_identity({"base_url": "u", "model": "m"}, "k", "i", "p") == real
    # and the API key still never enters the identity on either side
    assert cache_identity({"base_url": "u", "model": "m", "mock": True,
                           "api_key": "SECRET-A"}, "k", "i", "p") == mocked
    assert cache_identity({"base_url": "u", "model": "m", "mock": True,
                           "api_key": "SECRET-B"}, "k", "i", "p") == mocked


def test_translation_cache_roundtrip_and_ttl(tmp_path=None):
    import tempfile
    db = os.path.join(tempfile.mkdtemp(), "t.db")
    c = TranslationCache(db)
    assert c.get("x") is None
    c.put("x", {"aligned": True, "values": ["a"]})
    assert c.get("x") == {"aligned": True, "values": ["a"]}
    c.put("x", {"aligned": False, "text": "b"})
    assert c.get("x")["text"] == "b"


def test_settings_redaction_and_corruption():
    import tempfile
    d = tempfile.mkdtemp()
    p = os.path.join(d, "setting.json")
    cfg = S.default_settings()
    cfg["provider"]["api_key"] = "sk-secret"
    cfg["provider"]["base_url"] = "https://api.deepseek.com/v1"
    cfg["provider"]["model"] = "deepseek-chat"
    r = S.redact(cfg)
    assert r["configured"] and r["host"] == "api.deepseek.com"
    assert "sk-secret" not in JSON_SAFE(r)
    S.save(cfg, p)
    with open(p, "w", encoding="utf-8") as f:
        f.write("{corrupt")
    cfg2 = S.load(p)
    assert os.path.exists(p + ".bak")
    assert cfg2 == S.default_settings()


def JSON_SAFE(obj):
    import json
    return json.dumps(obj)


def test_queue_priority_dedup_and_cancel():
    import tempfile
    db = os.path.join(tempfile.mkdtemp(), "t.db")
    cache = TranslationCache(db)
    done = []
    gate = {"hold": True}

    def fake_translate(jobs):
        # spec #24: the seam takes a job LIST; length 1 = pre-batch behaviour.
        while gate["hold"]:
            time.sleep(0.01)
        return [{"aligned": False, "text": "T:" + j.group_text, "error": None}
                for j in jobs]

    q = TranslationQueue({}, cache, workers=1, on_done=lambda j, r: done.append((j, r)),
                         translate_fn=fake_translate, max_pending=10)
    jobs = []
    for i in range(4):
        pr = URGENT if i == 0 else NORMAL
        j = TranslationJob("id%d" % i, pr, "s1", i, "text%d" % i)
        jobs.append(j)
        q.submit(j)
    q.submit(TranslationJob("id0", URGENT, "s1", 0, "text0"))  # dedup no-op
    time.sleep(0.15)
    assert q.stats()["inflight"] <= 1
    # cancel pending normals of s1, then release
    n = q.cancel_source("s1")
    assert n == 3
    gate["hold"] = False
    time.sleep(0.4)
    q.shutdown()
    assert len(done) == 1 and done[0][1]["text"] == "T:text0"


def test_queue_sheds_normal_under_backoff():
    import tempfile
    db = os.path.join(tempfile.mkdtemp(), "t.db")
    cache = TranslationCache(db)
    done = []
    def fake_translate(jobs):
        return [{"aligned": False, "text": "T", "error": None} for _ in jobs]
    q = TranslationQueue({}, cache, workers=1, on_done=lambda j, r: done.append(j),
                         translate_fn=fake_translate, max_pending=10)
    q.note_rate_limited(cooldown_s=0.3)
    q.submit(TranslationJob("n1", NORMAL, "s1", 1, "x"))
    time.sleep(0.1)
    assert len(done) == 0  # shed while in backoff
    time.sleep(0.3)
    q.submit(TranslationJob("n2", NORMAL, "s1", 2, "y"))
    time.sleep(0.2)
    q.shutdown()
    assert len(done) == 1


# ---- spec #24: batch output contract + batch-aware queue take path ----


def test_slice_numbered_batch_requires_exact_full_coverage():
    """Decision 7/8: the batch contract is globally continuous numbering
    1..T with EXACT full coverage - the same all-or-nothing semantics as the
    single aligned protocol. Anything else (a dropped line the model
    re-numbered around, a gap, a duplicate, an empty body, an out-of-range
    number) voids the whole batch. Never patch the missing lines in."""
    nl = chr(10)
    counts = [2, 1, 3]
    full = nl.join(["1|甲", "2|乙", "3|丙", "4|丁", "5|戊", "6|己"])
    want = [["甲", "乙"], ["丙"], ["丁", "戊", "己"]]
    assert P.slice_numbered_batch(full, counts) == want
    fenced = "```json" + nl + full + nl + "```"
    assert P.slice_numbered_batch(fenced, counts) == want, \
        "fence stripping still applies"
    # dropped line + re-numbered contiguously: text cannot reveal the loss
    renumbered = nl.join(["1|甲", "2|乙", "3|丙", "4|丁", "5|戊"])
    assert P.slice_numbered_batch(renumbered, counts) is None
    # gap in the numbering
    gapped = nl.join(["1|甲", "2|乙", "3|丙", "4|丁", "6|己"])
    assert P.slice_numbered_batch(gapped, counts) is None
    # duplicate number
    dup = nl.join(["1|甲", "2|乙", "3|丙", "4|丁", "4|戊", "6|己"])
    assert P.slice_numbered_batch(dup, counts) is None
    # empty translation body
    empty = nl.join(["1|甲", "2|乙", "3|丙", "4|", "5|戊", "6|己"])
    assert P.slice_numbered_batch(empty, counts) is None
    # one line MORE than T (contiguous, looks perfectly valid)
    over = nl.join(["1|甲", "2|乙", "3|丙", "4|丁", "5|戊", "6|己"])
    assert P.slice_numbered_batch(over, [2, 1, 2]) is None  # T=5, got 6 lines
    # number beyond T
    extra = nl.join(["1|甲", "2|乙", "3|丙", "4|丁", "5|戊", "7|庚"])
    assert P.slice_numbered_batch(extra, counts) is None
    # nonsense counts never validate
    assert P.slice_numbered_batch(full, []) is None
    assert P.slice_numbered_batch(full, [0, 3, 3]) is None


def _mk_jobs(specs):
    """specs = [(identity, priority, group_idx, text)] -> TranslationJob list."""
    return [TranslationJob(ident, pr, "s1", gi, text)
            for ident, pr, gi, text in specs]


def test_queue_batch_take_drops_cached_and_inflight_then_falls_back():
    """Decision 12: at take time a batch drops members that are already
    cached or already in flight; what remains runs - >= 2 as ONE call,
    exactly 1 falling back to the single path. A cached member is never
    translated again."""
    import tempfile
    cache = TranslationCache(os.path.join(tempfile.mkdtemp(), "t.db"))
    cache.put("idA", {"aligned": False, "text": "CA", "error": None})
    gate, calls = {"hold": True}, []

    def fake(jobs):
        calls.append([j.identity for j in jobs])
        while gate["hold"]:
            time.sleep(0.01)
        return [{"aligned": False, "text": "T:" + j.group_text, "error": None}
                for j in jobs]

    q = TranslationQueue({}, cache, workers=1, translate_fn=fake, max_pending=50)
    try:
        q.submit(TranslationJob("idB", URGENT, "s1", 1, "b"))
        deadline = time.time() + 2.0
        while time.time() < deadline and q.stats()["inflight"] < 1:
            time.sleep(0.01)
        assert q.stats()["inflight"] == 1, "B must be in flight (blocked)"
        # A is cached, B is in flight: neither may reach the translator
        accepted = q.submit_batch(_mk_jobs([("idA", NORMAL, 0, "a"),
                                             ("idB", NORMAL, 1, "b"),
                                             ("idC", NORMAL, 2, "c")]))
        assert accepted
        gate["hold"] = False
        deadline = time.time() + 2.0
        while time.time() < deadline and len(calls) < 2:
            time.sleep(0.01)
        assert calls == [["idB"], ["idC"]], calls
        assert "idA" not in calls[0] + calls[1], \
            "a cached member must be dropped, not re-translated"
        assert len(calls[1]) == 1, "one surviving member -> single path"
    finally:
        q.shutdown()


def test_queue_batch_runs_as_one_call_and_dedups_pending_members():
    """Steady contract: >= 2 surviving members = exactly ONE translate call
    carrying the whole batch; members already in flight are deduplicated -
    never translated twice."""
    import tempfile
    cache = TranslationCache(os.path.join(tempfile.mkdtemp(), "t.db"))
    gate, calls = {"hold": True}, []

    def fake(jobs):
        calls.append([j.identity for j in jobs])
        while gate["hold"]:
            time.sleep(0.01)
        return [{"aligned": False, "text": "T", "error": None} for _ in jobs]

    q = TranslationQueue({}, cache, workers=1, translate_fn=fake, max_pending=50)
    try:
        assert q.submit_batch(_mk_jobs([("idX", NORMAL, 0, "x"),
                                         ("idY", NORMAL, 1, "y")]))
        deadline = time.time() + 2.0
        while time.time() < deadline and q.stats()["inflight"] < 2:
            time.sleep(0.01)
        assert q.stats()["inflight"] == 2, "the whole batch must go out together"
        # X and Y are in flight now: resubmitting them must be a no-op.
        assert not q.submit_batch(_mk_jobs([("idX", NORMAL, 0, "x"),
                                             ("idY", NORMAL, 1, "y")]))
        gate["hold"] = False
        deadline = time.time() + 2.0
        while time.time() < deadline and len(calls) < 1:
            time.sleep(0.01)
        q.shutdown()
        assert calls == [["idX", "idY"]], \
            "exactly one call for the whole batch, nothing else"
    finally:
        q.shutdown()


def test_batches_shed_under_deep_backoff_but_urgent_is_never_shed():
    """US20 + decision 14: batches are NORMAL priority, so deep backoff
    (rate limiting) sheds them - while URGENT, the sentence on screen, always
    goes through. Rate limiting cuts prefetch, never the visible line."""
    import tempfile
    cache = TranslationCache(os.path.join(tempfile.mkdtemp(), "t.db"))
    calls, done = [], []

    def fake(jobs):
        calls.append([j.identity for j in jobs])
        return [{"aligned": False, "text": "T", "error": None} for _ in jobs]

    q = TranslationQueue({}, cache, workers=1, on_done=lambda j, r: done.append(j),
                         translate_fn=fake, max_pending=50)
    try:
        q.note_rate_limited(cooldown_s=0.4)
        assert q.submit_batch(_mk_jobs([("idN1", NORMAL, 1, "n1"),
                                         ("idN2", NORMAL, 2, "n2")]))
        q.submit(TranslationJob("idU", URGENT, "s1", 0, "u"))
        time.sleep(0.2)  # still inside the backoff window
        assert calls == [["idU"]], \
            "URGENT must pass through deep backoff; batch must be shed: %r" % (calls,)
        time.sleep(0.4)  # backoff over - the shed batch never comes back
        assert calls == [["idU"]], "a shed batch must not resurrect itself"
        assert [j.identity for j in done] == ["idU"]
        assert not q.in_backoff()
    finally:
        q.shutdown()


def _capture_wire(monkeypatch, protocol, cur, prev="", nxt="", system="BASE PROMPT"):
    """Drive translate_group against a stubbed transport (no network) and return
    (system, user) exactly as they would go on the wire for either protocol."""
    seen = []

    def fake_post(url, headers, payload, timeout_s):
        seen.append(payload)


        # one body that satisfies both protocols' extractors
        return 200, {}, json.dumps({"choices": [{"message": {"content": "ok"}}],
                                    "output_text": "ok"})

    monkeypatch.setattr(P, "_do_post", fake_post)
    cfg = {"base_url": "https://api.example.test/v1", "api_key": "k", "model": "m",
           "protocol": protocol, "system": system}
    r = P.translate_group(cfg, cur, prev, nxt, expected_lines=0)
    assert r.get("error") is None and seen, "the stubbed transport must be hit"
    body = seen[-1]
    if protocol == "chat-completions":
        return body["messages"][0]["content"], body["messages"][1]["content"]
    return body["instructions"], body["input"][0]["content"][0]["text"]

# ---- seam 3 (#23): the client against REAL bad addresses never raises ----
# Old bug (decision 14): a refused connection or read timeout escaped the
# client as a raw URLError and surfaced to the user as an internal WORKER
# error. Real closed port + real blackhole address, no HTTP patching.
BAD_REFUSED = "http://127.0.0.1:9/v1"
BAD_BLACKHOLE = "http://10.255.255.1:9/v1"


def _net_cfg(base, timeout=2.0):
    return {"base_url": base, "api_key": "x", "model": "m", "protocol": "auto",
            "timeout_s": timeout, "max_retries": 0, "system": "t"}


def test_translate_group_refused_port_reports_network_and_never_raises(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1,::1")
    r = P.translate_group(_net_cfg(BAD_REFUSED, timeout=3.0), "hello")
    assert r["error"] == "NETWORK", r
    assert r["attempts"] == 1


def test_translate_group_blackhole_reports_timeout(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "10.255.255.1")
    r = P.translate_group(_net_cfg(BAD_BLACKHOLE, timeout=2.0), "hello")
    assert r["error"] == "TIMEOUT", r
    assert r["attempts"] == 1


def test_translate_group_local_static_short_circuits_without_attempts():
    r = P.translate_group(_net_cfg("ftp://x/v1"), "hello")
    assert r["error"] == "BAD_CONFIG" and r["attempts"] == 0
    r = P.translate_group(dict(_net_cfg(BAD_REFUSED), model=""), "hello")
    assert r["error"] == "NO_MODEL" and r["attempts"] == 0


def test_list_models_reports_network_and_timeout_codes(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1,::1")
    ids, err = P.list_models(_net_cfg(BAD_REFUSED), timeout_s=3.0)
    assert ids == [] and err == "NETWORK"
    monkeypatch.setenv("NO_PROXY", "10.255.255.1")
    ids, err = P.list_models(_net_cfg(BAD_BLACKHOLE), timeout_s=2.0)
    assert ids == [] and err == "TIMEOUT"


def test_wire_context_lines_go_into_system_and_user_stays_pure(monkeypatch):
    """#38 / ADR-009 wire contract: neighbour context rides as two verbatim
    label lines appended to the system prompt; the user message is the pure
    current sentence - for both protocols. Wording and order are pinned on
    purpose: they feed the identity scheme, so changing them would fork every
    cache row for zero user benefit. Empty context appends nothing, and a
    missing neighbour (first/last group) omits exactly its own line."""
    cur, prev, nxt = "current sentence here", "previous neighbour line", "next neighbour line"
    want_sys = ("BASE PROMPT" + chr(10) +
                "Previous line (context only, do not translate): " + prev + chr(10) +
                "Next line (context only, do not translate): " + nxt)
    for protocol in ("chat-completions", "responses"):
        system, user = _capture_wire(monkeypatch, protocol, cur, prev, nxt)
        assert user == cur, protocol + ": user message must be the pure current sentence"
        assert system == want_sys, protocol + ": exactly two verbatim label lines in system"

    # empty context (both neighbours absent): nothing is appended
    for protocol in ("chat-completions", "responses"):
        system, user = _capture_wire(monkeypatch, protocol, cur)
        assert system == "BASE PROMPT" and user == cur, protocol + ": no lines when no context"

    # positional defaults: a missing neighbour omits exactly its own line
    system, _ = _capture_wire(monkeypatch, "chat-completions", cur, "", nxt)
    assert system == ("BASE PROMPT" + chr(10) +
                      "Next line (context only, do not translate): " + nxt)
    system, _ = _capture_wire(monkeypatch, "chat-completions", cur, prev, "")
    assert system == ("BASE PROMPT" + chr(10) +
                      "Previous line (context only, do not translate): " + prev)