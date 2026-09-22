"""Connection test (#23): seam 1 (runner + report contract via injected
transports) and seam 2 (the /status connection_test field).

Seams are the three the spec's Testing Decisions pre-agree:
  seam 1 - the test runner + report, driven by injected fake transports;
  seam 2 - the loopback diagnostics endpoint as the black-box observation port;
  seam 3 - the translation client against real bad addresses (lives in
           test_provider_and_queue.py).
GUI dialog internals are deliberately NOT tested (spec: the panel form belongs
to the config-trust UX ticket).
"""
import json, os, queue as queue_mod, sys, threading, time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from suboverlay import connection_test as CT
from suboverlay import provider as P
from suboverlay import settings as S
from suboverlay.queue_cache import TranslationCache, TranslationQueue
from suboverlay.server import WSServer

KEY = "sk-SECRET-XYZ"


def snap(**kw):
    base = {"base_url": "https://api.example.test/v1", "api_key": KEY,
            "model": "test-model", "protocol": "auto",
            "system": "Translate into Chinese.", "mock": False}
    base.update(kw)
    return base


def layer(rep, lid):
    return next(L for L in rep["layers"] if L["id"] == lid)


def ok_translate(cfg, text, **kw):
    return {"aligned": False, "text": "OK", "error": None, "attempts": 1}


def ok_list(cfg):
    return ["test-model"], None


def run(s, translate=None, lst=None):
    return CT.run_connection_test(s, translate or ok_translate, lst or ok_list)


# ---------------------------------------------------------------- seam 1
# --- local static short-circuit: zero network --------------------------
def test_static_bad_url_short_circuits_with_zero_network():
    calls = []

    def boom(*a, **k):
        calls.append(a)
        raise AssertionError("network must not be touched")

    rep = run(snap(base_url="not-a-url"), boom, boom)
    assert rep["verdict"] == "fail"
    assert layer(rep, "L1")["passed"] is False
    assert layer(rep, "L1")["code"] == "BAD_CONFIG"
    assert rep["attempts"] == 0
    assert rep["skipped"] == ["step1", "step2"]
    assert calls == [], "a locally invalid URL must short-circuit both steps"


def test_static_empty_base_url_fails_immediately():
    t0 = time.time()
    rep = run(snap(base_url=""))
    assert rep["verdict"] == "fail" and layer(rep, "L1")["code"] == "BAD_CONFIG"
    assert time.time() - t0 < 1.0, "no network timeout may be waited out"


def test_static_empty_model_fails_model_layer_zero_network():
    calls = []

    def boom(*a, **k):
        calls.append(a)
        raise AssertionError("network must not be touched")

    rep = run(snap(model=""), boom, boom)
    assert rep["verdict"] == "fail"
    assert layer(rep, "L3")["passed"] is False
    assert layer(rep, "L3")["code"] == "NO_MODEL"
    assert rep["attempts"] == 0 and calls == []


# --- model list: three-state observation (never a gate) ----------------
def test_model_list_hit_passes_the_model_layer():
    rep = run(snap())
    assert layer(rep, "L3")["passed"] is True
    assert rep["model_list"] == {"observed": True, "ids": ["test-model"],
                                 "total": 1, "contains_model": True}


def test_model_not_in_list_is_an_observation_but_gate_still_passes():
    rep = run(snap(), lst=lambda cfg: (["other-model"], None))
    l3 = layer(rep, "L3")
    assert l3["passed"] is None, "not-in-list must not be judged a failure"
    assert "other" in (l3["message"] or "") or "not" in l3["message"].lower()
    assert rep["model_list"]["contains_model"] is False
    assert rep["verdict"] == "pass", "step 2 is the only gate"


def test_model_list_http_404_is_observation_not_failure():
    rep = run(snap(), lst=lambda cfg: ([], "HTTP_404"))
    assert layer(rep, "L1")["passed"] is True, "an answered endpoint is reachable"
    assert layer(rep, "L3")["passed"] is None
    assert rep["verdict"] == "pass"


def test_unparseable_model_list_still_passes_auth_and_gate():
    rep = run(snap(), lst=lambda cfg: ([], "INVALID_MODEL_OUTPUT"))
    assert layer(rep, "L1")["passed"] is True
    assert layer(rep, "L2")["passed"] is True, "HTTP 2xx means the key was accepted"
    assert layer(rep, "L3")["passed"] is None
    assert rep["verdict"] == "pass"


# --- list-side error codes -> layers ------------------------------------
def test_list_error_codes_map_to_layers():
    # L2 failure is localization, never a gate: with step 2 succeeding the
    # verdict stays pass (decision 1 - only L4 gates).
    for code, lid in (("HTTP_401", "L2"), ("HTTP_403", "L2")):
        rep = run(snap(), lst=lambda cfg, c=code: ([], c))
        assert layer(rep, lid)["passed"] is False, code
        assert layer(rep, lid)["code"] in ("AUTH", "FORBIDDEN")
        assert layer(rep, "L1")["passed"] is True, "HTTP response = reachable"
        assert rep["verdict"] == "pass", "L1-L3 never gate"
    for code in ("HTTP_429", "HTTP_500", "HTTP_400"):
        rep = run(snap(), lst=lambda cfg, c=code: ([], c))
        assert layer(rep, "L2")["passed"] is None, code + " says nothing about auth"
        assert layer(rep, "L1")["passed"] is True
    for code in ("TIMEOUT", "NETWORK"):
        rep = run(snap(), lst=lambda cfg, c=code: ([], c))
        assert layer(rep, "L1")["passed"] is False
        assert layer(rep, "L1")["code"] == code
        assert layer(rep, "L2")["passed"] is None
        assert rep["verdict"] == "pass", "a step-1 failure must never gate"


def test_list_401_fails_auth_layer_but_step2_still_runs():
    """Decision 5: network-layer step-1 results - 401 included - never block
    step 2; only local static validation short-circuits."""
    seen = []

    def translate(cfg, text, **kw):
        seen.append(text)
        return {"aligned": False, "text": "T", "error": "AUTH",
                "message": "401 unauthorized", "attempts": 1}

    rep = run(snap(), translate=translate, lst=lambda cfg: ([], "HTTP_401"))
    assert seen, "step 2 must still run after a step-1 401"
    assert layer(rep, "L1")["passed"] is True, "earlier success preserved"
    assert layer(rep, "L2")["code"] == "AUTH"
    assert layer(rep, "L4")["code"] == "AUTH" and rep["verdict"] == "fail"


# --- structural judgment of step 2 ---------------------------------------
def test_pass_carries_sample_source_and_real_translation():
    rep = run(snap(), translate=lambda cfg, text, **kw: {
        "aligned": False, "text": "猫坐在垫子上", "error": None, "attempts": 2})
    assert rep["verdict"] == "pass"
    assert rep["sample"] == {"source": CT.TEST_SENTENCE,
                             "translation": "猫坐在垫子上"}
    assert rep["attempts"] == 2
    assert layer(rep, "L4")["passed"] is True


def test_non_json_response_is_a_shape_failure_with_provider_message():
    rep = run(snap(), translate=lambda cfg, text, **kw: {
        "error": "INVALID_MODEL_OUTPUT", "message": "response is not JSON",
        "attempts": 1})
    assert rep["verdict"] == "fail"
    assert layer(rep, "L4")["code"] == "INVALID_MODEL_OUTPUT"
    assert layer(rep, "L4")["message"] == "response is not JSON"


def test_empty_text_without_error_is_still_a_failure():
    rep = run(snap(), translate=lambda cfg, text, **kw: {
        "aligned": False, "text": "", "error": None, "attempts": 1})
    assert rep["verdict"] == "fail"
    assert layer(rep, "L4")["passed"] is False
    assert layer(rep, "L4")["code"] == "INVALID_MODEL_OUTPUT"


def test_error_code_mapping_is_a_closed_set():
    closed = ("TIMEOUT", "NETWORK", "AUTH", "FORBIDDEN", "RATE_LIMITED",
              "SERVER", "BAD_REQUEST", "INVALID_MODEL_OUTPUT", "NO_MODEL",
              "BAD_CONFIG")
    for code in closed:
        rep = run(snap(), translate=lambda cfg, text, c=code: {
            "error": c, "message": "msg-" + c, "attempts": 1})
        assert rep["verdict"] == "fail"
        assert layer(rep, "L4")["code"] == code, code
        assert layer(rep, "L4")["message"] == "msg-" + code
    # anything outside the closed set degrades to the unknown code
    rep = run(snap(), translate=lambda cfg, text, **kw: {
        "error": "SOMETHING_NEW", "message": "x", "attempts": 1})
    assert layer(rep, "L4")["code"] == "UNKNOWN"


def test_failure_keeps_the_layers_that_succeeded():
    rep = run(snap(), translate=lambda cfg, text, **kw: {
        "error": "AUTH", "message": "401 unauthorized", "attempts": 1})
    assert rep["verdict"] == "fail"
    assert layer(rep, "L1")["passed"] is True
    assert layer(rep, "L2")["passed"] is True
    assert layer(rep, "L3")["passed"] is True
    assert layer(rep, "L4")["passed"] is False


# --- Mock: third verdict, zero network, never green ----------------------
def test_mock_is_the_third_verdict_with_zero_network():
    def boom(*a, **k):
        raise AssertionError("Mock must send no network request")

    rep = run(snap(mock=True), boom, boom)
    assert rep["verdict"] == "mock"
    assert rep["verdict"] != "pass"
    assert rep["mock"] is True
    assert rep["attempts"] == 0
    assert rep["skipped"] == ["step1", "step2"]
    for lid in ("L1", "L2", "L3", "L4"):
        assert layer(rep, lid)["passed"] is None, lid


def test_mock_with_real_config_warns_it_masks_the_real_state():
    rep = run(snap(mock=True))
    assert CT.MOCK_MASKS_REAL_CONFIG in rep["warnings"]


def test_mock_without_real_config_has_no_mask_warning():
    rep = run(snap(mock=True, base_url="", model=""))
    assert rep["verdict"] == "mock"
    assert CT.MOCK_MASKS_REAL_CONFIG not in rep["warnings"]


# --- attempts / quota / snapshot -----------------------------------------
def test_attempts_zero_when_nothing_was_sent():
    assert run(snap(base_url=""))["attempts"] == 0
    assert run(snap(mock=True))["attempts"] == 0


def test_quota_notice_promises_a_real_request_only_for_real_runs():
    assert "real" in run(snap())["quota_notice"].lower()
    assert "no network request" in run(snap(mock=True))["quota_notice"].lower()
    assert "no request" in run(snap(base_url=""))["quota_notice"].lower()


def test_report_snapshot_is_the_click_time_input_and_never_the_key():
    s = snap(system="CLICK-TIME PROMPT")
    rep = run(s)
    blob = json.dumps(rep, ensure_ascii=False)
    assert KEY not in blob, "the API key must never appear in the report"
    assert "api_key" not in rep["snapshot"]
    assert rep["snapshot"]["api_key_set"] is True
    assert rep["snapshot"]["system"] == "CLICK-TIME PROMPT"
    assert rep["snapshot"]["base_url"] == s["base_url"]
    assert s["api_key"] == KEY, "the run must not mutate the caller's snapshot"


def test_alignment_protocol_is_declared_unverified():
    rep = run(snap())
    assert any("Alignment" in n for n in rep["notes"])


# --- same-path invariant --------------------------------------------------
def test_default_transports_are_the_production_client_functions():
    t = CT.ConnectionTester()
    assert t._translate is P.translate_group
    assert t._list_models is P.list_models


def test_step2_sends_the_constant_sentence_with_form_prompt_and_tightened_timeout():
    calls = []

    def capture(cfg, *args, **kw):
        calls.append((dict(cfg), args, kw))
        return {"aligned": False, "text": "T", "error": None, "attempts": 1}

    run(snap(system="FORM PROMPT"), translate=capture)
    assert len(calls) == 1
    cfg, args, kw = calls[0]
    assert args == (CT.TEST_SENTENCE,), "one positional prompt, no context"
    assert "\n" not in CT.TEST_SENTENCE, "the probe sentence must be one line"
    assert kw == {}, "whole-line mode: no expected_lines override, no context"
    assert cfg["system"] == "FORM PROMPT", "the current form prompt goes on the wire"
    assert cfg["timeout_s"] == CT.TEST_TIMEOUT_S == 20.0
    assert cfg["base_url"] == "https://api.example.test/v1"
    assert cfg["model"] == "test-model"
    assert cfg["protocol"] == "auto"
    assert cfg["api_key"] == KEY


# --- run mechanics: single-flight, cancel/generation, progress ------------
def _gated_translator(gate, started, text="late"):
    def f(cfg, t, **kw):
        started.set()
        gate.wait(5)
        return {"aligned": False, "text": text, "error": None, "attempts": 1}
    return f


def test_single_flight_rejects_a_second_start_while_running():
    gate, started = threading.Event(), threading.Event()
    done = []
    tester = CT.ConnectionTester(translate_fn=_gated_translator(gate, started),
                                 list_models_fn=ok_list)
    try:
        assert tester.start(snap(), on_done=done.append) is True
        assert started.wait(5)
        assert tester.is_running()
        assert tester.start(snap(), on_done=done.append) is False, "single flight"
        gate.set()
        deadline = time.time() + 5
        while time.time() < deadline and not done:
            time.sleep(0.02)
        assert done and tester.last_report() is not None
        # after the run ends the button works again
        assert tester.start(snap(), on_done=done.append) is True
        deadline = time.time() + 5
        while time.time() < deadline and len(done) < 2:
            time.sleep(0.02)
        assert len(done) == 2
    finally:
        gate.set()
        tester.cancel()


def test_cancel_unblocks_immediately_drops_stale_result_and_allows_rerun():
    gate, started = threading.Event(), threading.Event()
    done = []
    tester = CT.ConnectionTester(translate_fn=_gated_translator(gate, started),
                                 list_models_fn=ok_list)
    try:
        assert tester.start(snap(), on_done=done.append)
        assert started.wait(5)
        assert tester.progress()["step"] == 2
        tester.cancel()
        assert not tester.is_running(), "cancel must free the UI immediately"
        gate.set()
        time.sleep(0.3)
        assert done == [], "the abandoned run must not write its report back"
        assert tester.last_report() is None
        # a fresh run right after cancel works and is the one that lands
        assert tester.start(snap(), on_done=done.append)
        deadline = time.time() + 5
        while time.time() < deadline and not done:
            time.sleep(0.02)
        assert len(done) == 1
        assert tester.last_report() is not None
        assert tester.last_report()["verdict"] == "pass"
    finally:
        gate.set()
        tester.cancel()


def test_progress_reports_step_and_elapsed_seconds():
    gate, started = threading.Event(), threading.Event()

    def slow_list(cfg):
        started.set()
        gate.wait(5)
        return ["test-model"], None

    tester = CT.ConnectionTester(translate_fn=ok_translate,
                                 list_models_fn=slow_list)
    try:
        assert tester.start(snap(), on_done=lambda r: None)
        assert started.wait(5)
        p = tester.progress()
        assert p["running"] and p["step"] == 1
        assert p["elapsed_s"] >= 0.0
        gate.set()
        deadline = time.time() + 5
        while time.time() < deadline and tester.is_running():
            time.sleep(0.02)
        assert not tester.is_running()
        assert tester.progress()["step"] == 0
    finally:
        gate.set()
        tester.cancel()


def test_a_run_writes_no_cache_no_queue_and_no_config(monkeypatch):
    hits = {"cache": 0, "queue": 0, "save": 0}
    monkeypatch.setattr(TranslationCache, "put",
                        lambda *a, **k: hits.__setitem__("cache", hits["cache"] + 1))
    monkeypatch.setattr(TranslationQueue, "submit",
                        lambda *a, **k: hits.__setitem__("queue", hits["queue"] + 1))
    monkeypatch.setattr(S, "save",
                        lambda *a, **k: hits.__setitem__("save", hits["save"] + 1))
    rep = run(snap())
    assert rep["verdict"] == "pass"
    assert hits == {"cache": 0, "queue": 0, "save": 0}, hits


# ---------------------------------------------------------------- seam 2
def _http_get(port, path):
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        return resp.status, resp.read().decode("utf-8")
    finally:
        conn.close()


def test_status_field_absent_before_first_run_then_equals_the_report():
    port = 19890
    tester = CT.ConnectionTester(translate_fn=ok_translate, list_models_fn=ok_list)
    srv = WSServer(port=port, event_queue=queue_mod.Queue(maxsize=10),
                   status_provider=lambda: {"state": "ok",
                                            **tester.status_payload()})
    srv.start()
    time.sleep(0.4)
    try:
        code, body = _http_get(port, "/status")
        assert code == 200
        assert "connection_test" not in json.loads(body),             "a never-run test must not appear as an empty report"
        done = []
        assert tester.start(snap(api_key="sk-SUPER-SECRET"), on_done=done.append)
        deadline = time.time() + 5
        while time.time() < deadline and not done:
            time.sleep(0.02)
        assert done
        code, body = _http_get(port, "/status")
        data = json.loads(body)
        assert data["connection_test"] == tester.last_report()
        assert data["connection_test"]["verdict"] == "pass"
        assert "sk-SUPER-SECRET" not in body, "the key must not ride the endpoint"
    finally:
        srv.stop()
