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

    def fake_translate(job):
        while gate["hold"]:
            time.sleep(0.01)
        return {"aligned": False, "text": "T:" + job.group_text, "error": None}

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
    def fake_translate(job):
        return {"aligned": False, "text": "T", "error": None}
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