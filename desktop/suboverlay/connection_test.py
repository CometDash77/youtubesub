"""Connection test runner and report contract (#23, ADR-005).

Answers one question honestly: does this provider configuration actually
translate? Four layers localize a failure - L1 endpoint reachable, L2 auth
accepted, L3 model listed, L4 a structurally valid non-empty translation -
and only L4 gates the verdict ("red = production would be red too").

Deliberately Qt-free and network-client-free: the two transports
(provider.translate_group, provider.list_models - the exact production
functions) are injected, so the whole run mechanics (single flight, cancel by
generation, progress ticks, snapshot semantics) are testable without a window
server. The GUI is a thin adapter over this module: it renders this module's
translated prose and formats its own labels and warning messages.

Rules honoured here: never auto-triggered; never writes the cache, the queue
or any config file; never puts the API key into the report; Mock is a third
verdict (never "pass") with zero network traffic; cancel means "stop waiting"
- the in-flight request finishes on its own and its quota is not refunded.
Human-facing report prose is produced here in Chinese alongside unchanged
machine codes. The GUI translates its own labels and warning codes only.
"""
import threading, time

from . import provider as provider_mod

# The minimal one-line English probe sentence for step 2 (whole-line mode,
# no context prefix). Module constant so tests can pin it.
TEST_SENTENCE = "The cat sat on the mat."

# Step 2's own time ceiling, tightened from the production 60s because the
# probe is one short sentence (decision 11; calibrated at milestone M with a
# real key). Step 1 keeps provider.MODELS_TIMEOUT_S. Constants only - no new
# user-facing setting.
TEST_TIMEOUT_S = 20.0

MOCK_MASKS_REAL_CONFIG = "MOCK_MASKS_REAL_CONFIG"

ALIGNMENT_NOTE = "尚未验证 Alignment（N|line）协议；本次探测仅使用整行模式。"

# The closed error vocabulary shared by both steps (decision 13). Codes kept
# in the engine's own vocabulary but unreachable here (SHAPE_MISS, WORKER)
# degrade to UNKNOWN instead of leaking a second language into the report.
KNOWN_CODES = frozenset({
    "BAD_CONFIG", "NO_MODEL", "TIMEOUT", "NETWORK", "AUTH", "FORBIDDEN",
    "RATE_LIMITED", "SERVER", "BAD_REQUEST", "INVALID_MODEL_OUTPUT", "UNKNOWN",
})

_DEFAULT_MESSAGES = {
    "BAD_CONFIG": "配置不是有效的绝对 HTTP(S) URL。",
    "NO_MODEL": "模型名称为空。",
    "TIMEOUT": "请求超时，服务未在规定时间内响应。",
    "NETWORK": "无法连接到服务（网络错误）。",
    "AUTH": "401 未授权：API Key 被拒绝。",
    "FORBIDDEN": "403 禁止访问：服务器拒绝了请求。",
    "RATE_LIMITED": "请求被服务器限流。",
    "SERVER": "服务器报告内部错误。",
    "BAD_REQUEST": "服务器拒绝了请求。",
    "INVALID_MODEL_OUTPUT": "响应中没有非空译文。",
    "UNKNOWN": "未知错误。",
}

_WARNING_MESSAGES = {
    MOCK_MASKS_REAL_CONFIG: "当前为 Mock 模式；已填写的真实配置本次不会被使用。",
}

_LAYERS = (("L1", "端点可访问"), ("L2", "身份验证"),
           ("L3", "模型存在"), ("L4", "翻译可用"))

_QUOTA_REAL = "本次点击会发送一次真实的最小翻译请求；重试可能增加用量，取消不会退还已消耗额度。"
_QUOTA_MOCK = "Mock 模式：未发送网络请求，也未消耗额度。"
_QUOTA_STATIC = "未发送请求：本地配置无效。"

_ID_LIST = "step1"
_ID_TRANS = "step2"


def _layer(lid, passed, code, message, elapsed_ms=0):
    title = dict(_LAYERS)[lid]
    return {"id": lid, "title": title, "passed": passed, "code": code,
            "message": message, "elapsed_ms": int(elapsed_ms)}


def _skip(msg):
    return {"L1": _layer("L1", None, None, msg),
            "L2": _layer("L2", None, None, msg),
            "L3": _layer("L3", None, None, msg),
            "L4": _layer("L4", None, None, msg)}


def _snapshot_fields(snap):
    return {"base_url": (snap.get("base_url") or "").strip(),
            "model": (snap.get("model") or "").strip(),
            "protocol": snap.get("protocol") or "auto",
            "system": snap.get("system") or "",
            "api_key_set": bool(snap.get("api_key")),
            "mock": bool(snap.get("mock"))}


def _report(verdict, layers, snap, attempts, translation, model_list,
            warnings, skipped, quota, duration_ms):
    return {
        "verdict": verdict,
        "mock": bool(snap.get("mock")),
        "layers": [layers[lid] for lid, _ in _LAYERS],
        "attempts": int(attempts),
        "sample": {"source": TEST_SENTENCE, "translation": translation},
        "model_list": model_list,
        "warnings": list(warnings),
        "warning_messages": {code: _WARNING_MESSAGES[code]
                             for code in warnings if code in _WARNING_MESSAGES},
        "skipped": list(skipped),
        "quota_notice": quota,
        "notes": [ALIGNMENT_NOTE],
        "snapshot": _snapshot_fields(snap),
        "duration_ms": int(duration_ms),
    }


def _no_model_list():
    return {"observed": False, "ids": [], "total": 0, "contains_model": None}


def _static_problems(snap):
    """Local validation only - exactly the short-circuit cases of decision 5:
    an empty / non-absolute / non-http(s) base URL, or an empty model name."""
    problems = {}
    try:
        provider_mod.coerce_endpoint(snap.get("base_url"), snap.get("protocol"))
    except provider_mod.ProviderError as e:
        problems["L1"] = ("BAD_CONFIG", _DEFAULT_MESSAGES["BAD_CONFIG"])
    if not (snap.get("model") or "").strip():
        problems["L3"] = ("NO_MODEL", _DEFAULT_MESSAGES["NO_MODEL"])
    return problems


def _layers_from_models(err, ids, model, elapsed_ms):
    """Derive L1-L3 from the step-1 result. The list endpoint is a locating
    probe, never a gate: only an explicit 401/403 fails L2, and L3 records an
    observation in all three of its states."""
    if err is None:
        l1 = _layer("L1", True, None, "端点已响应（HTTP 2xx）。",
                    elapsed_ms)
        l2 = _layer("L2", True, None, "API Key 已接受（HTTP 2xx）。",
                    elapsed_ms)
        if model in ids:
            l3 = _layer("L3", True, None,
                        "服务端模型列表包含配置的模型。",
                        elapsed_ms)
        else:
            l3 = _layer("L3", None, None,
                        "模型列表有响应，但其中未列出配置的模型。", elapsed_ms)
        return l1, l2, l3

    if isinstance(err, str) and err.startswith("HTTP_"):
        status = err[5:]
        l1 = _layer("L1", True, None, "端点已响应（HTTP %s）。"
                    % status, elapsed_ms)
        if status == "401":
            l2 = _layer("L2", False, "AUTH",
                        _DEFAULT_MESSAGES["AUTH"],
                        elapsed_ms)
            l3 = _layer("L3", None, None,
                        "模型列表不可用（401 未授权）。",
                        elapsed_ms)
            return l1, l2, l3
        if status == "403":
            l2 = _layer("L2", False, "FORBIDDEN",
                        _DEFAULT_MESSAGES["FORBIDDEN"],
                        elapsed_ms)
            l3 = _layer("L3", None, None,
                        "模型列表不可用（403 禁止访问）。",
                        elapsed_ms)
            return l1, l2, l3
        if status in ("402", "429"):
            note = "未能确认：端点触发限流（HTTP %s）。" % status
        elif status.isdigit() and int(status) >= 500:
            note = "未能确认：端点返回服务器错误（HTTP %s）。" % status
        else:
            note = "未能确认：端点拒绝了请求（HTTP %s）。" % status
        l2 = _layer("L2", None, None, note, elapsed_ms)
        l3 = _layer("L3", None, None,
                    "模型列表不可用（HTTP %s）。" % status,
                    elapsed_ms)
        return l1, l2, l3

    if err == "TIMEOUT":
        return (_layer("L1", False, "TIMEOUT", _DEFAULT_MESSAGES["TIMEOUT"],
                       elapsed_ms),
                _layer("L2", None, None,
                        "未能确认：端点未及时响应。",
                       elapsed_ms),
                _layer("L3", None, None,
                       "模型列表不可用（请求超时）。", elapsed_ms))
    if err == "NETWORK":
        return (_layer("L1", False, "NETWORK", _DEFAULT_MESSAGES["NETWORK"],
                       elapsed_ms),
                _layer("L2", None, None,
                        "未能确认：端点无法连接。",
                       elapsed_ms),
                _layer("L3", None, None,
                       "模型列表不可用（网络错误）。",
                       elapsed_ms))
    if err == "INVALID_MODEL_OUTPUT":
        return (_layer("L1", True, None,
                       "端点已响应，但模型列表不是有效 JSON。", elapsed_ms),
                _layer("L2", True, None,
                       "API Key 已接受（HTTP 2xx）。", elapsed_ms),
                _layer("L3", None, None,
                       "模型列表响应不是有效 JSON。",
                       elapsed_ms))
    if err == "BAD_CONFIG":
        return (_layer("L1", False, "BAD_CONFIG",
                       _DEFAULT_MESSAGES["BAD_CONFIG"], elapsed_ms),
                _layer("L2", None, None,
                       "已跳过：Base URL 无效。", elapsed_ms),
                _layer("L3", None, None,
                       "已跳过：Base URL 无效。", elapsed_ms))
    return (_layer("L1", False, "UNKNOWN",
                   "模型列表探测失败：%s。" % err, elapsed_ms),
            _layer("L2", None, None,
                   "未能确认：第 1 步探测失败。", elapsed_ms),
            _layer("L3", None, None, "模型列表不可用。",
                   elapsed_ms))


def _layer4_from_result(res, elapsed_ms):
    """The only gate: HTTP 200 + parseable JSON + non-empty text, judged
    purely structurally. Semantic quality is the human's call - the sample
    travels in the report for exactly that reason."""
    err = res.get("error")
    text = res.get("text") or ""
    if not err:
        if text.strip():
            return (_layer("L4", True, None,
                           "已收到非空译文。", elapsed_ms),
                    text)
        return (_layer("L4", False, "INVALID_MODEL_OUTPUT",
                       _DEFAULT_MESSAGES["INVALID_MODEL_OUTPUT"], elapsed_ms),
                None)
    code = err if err in KNOWN_CODES else "UNKNOWN"
    detail = (res.get("message") or "").strip()
    message = _DEFAULT_MESSAGES.get(code, _DEFAULT_MESSAGES["UNKNOWN"])
    if detail:
        message += "（原始详情：%s）" % detail
    return (_layer("L4", False, code, message, elapsed_ms), (text or None))

def run_connection_test(snapshot, translate_fn, list_models_fn, on_step=None):
    """Run the two-step contract synchronously and return the report dict.

    The caller owns threading (ConnectionTester does). on_step(1|2) fires
    before each step for progress display. This function never writes the
    cache, the queue or any config file, and it never mutates the snapshot.
    """
    snap = dict(snapshot)
    on_step = on_step or (lambda n: None)
    t_start = time.monotonic()

    def build(verdict, layers, attempts, translation, model_list, warnings,
              skipped, quota):
        return _report(verdict, layers, snap, attempts, translation,
                       model_list, warnings, skipped, quota,
                       int((time.monotonic() - t_start) * 1000))

    on_step(1)

    # --- Mock: third verdict, zero network, never green (decision 22).
    # Checked BEFORE local validation: an unconfigured Mock run is the honest
    # "verify the in-app link" path (story 23), not a configuration failure -
    # Mock can be verdict "mock" with every field empty.
    if snap.get("mock"):
        layers = _skip("已跳过：Mock 模式未发送网络请求。")
        layers["L4"] = _layer("L4", None, None,
                              "已跳过：Mock 模式不会声称完成真实翻译。")
        warnings = []
        if ((snap.get("base_url") or "").strip()
                and (snap.get("model") or "").strip()):
            warnings.append(MOCK_MASKS_REAL_CONFIG)
        return build("mock", layers, 0, None, _no_model_list(), warnings,
                     [_ID_LIST, _ID_TRANS], _QUOTA_MOCK)

    # --- local static validation: the only short-circuit (decision 5) -----
    problems = _static_problems(snap)
    if problems:
        layers = _skip("已跳过：本地校验未通过，未发送请求。")
        for lid, (code, message) in problems.items():
            layers[lid] = _layer(lid, False, code, message)
        return build("fail", layers, 0, None, _no_model_list(), [],
                     [_ID_LIST, _ID_TRANS], _QUOTA_STATIC)

    # --- step 1: GET /models (locating probe, never a gate) ---------------
    fields = _snapshot_fields(snap)
    cfg = {"base_url": fields["base_url"],
           "api_key": snap.get("api_key") or "",
           "model": fields["model"], "protocol": fields["protocol"],
           "system": fields["system"] or provider_mod.DEFAULT_SYSTEM_PROMPT,
           # decision 11: step 2's tightened ceiling; list_models ignores
           # this key and keeps its own MODELS_TIMEOUT_S default.
           "timeout_s": TEST_TIMEOUT_S}

    t0 = time.monotonic()
    ids, err = list_models_fn(cfg)
    list_ms = int((time.monotonic() - t0) * 1000)
    ids = list(ids or [])
    l1, l2, l3 = _layers_from_models(err, ids, fields["model"], list_ms)

    # --- step 2: the real minimal translation (the only gate) -------------
    on_step(2)
    t0 = time.monotonic()
    res = translate_fn(cfg, TEST_SENTENCE)
    trans_ms = int((monotonic_ms() - 0)) if False else int(
        (time.monotonic() - t0) * 1000)
    if not isinstance(res, dict):
        res = {"error": "UNKNOWN",
               "message": "传输层返回了非字典结果。",
               "attempts": 0}
    l4, translation = _layer4_from_result(res, trans_ms)
    attempts = int(res.get("attempts") or 0)

    # contains_model is an observation about a list we actually hold.
    model_list = {"observed": True, "ids": ids[:50], "total": len(ids),
                  "contains_model": (fields["model"] in ids)
                  if err is None else None}

    verdict = "pass" if l4["passed"] else "fail"
    return build(verdict, {"L1": l1, "L2": l2, "L3": l3, "L4": l4},
                 attempts, translation, model_list, [], [], _QUOTA_REAL)


def _crash_report(snapshot, exc):
    """Last-resort report if an injected transport raises: the UI must always
    unblock and the failure must stay inside the closed vocabulary."""
    snap = dict(snapshot)
    message = ("内部错误（%s）：%s"
               % (type(exc).__name__, str(exc)))[:300]
    layers = _skip("已跳过：运行在执行此步骤前中止。")
    layers["L4"] = _layer("L4", False, "UNKNOWN", message)
    return _report("fail", layers, snap, 0, None, _no_model_list(), [],
                   [_ID_LIST, _ID_TRANS], _QUOTA_STATIC, 0)


class ConnectionTester:
    """Owns the run mechanics: one flight at a time, cancel by generation
    (an abandoned run finishes in the background but can never write its
    report back), progress ticks for the UI, and the last report for the
    diagnostics endpoint. Thread-safe; no GUI dependency."""

    def __init__(self, translate_fn=None, list_models_fn=None):
        # Defaults are the production client functions themselves - the
        # same-path invariant (ADR-005) lives right here.
        self._translate = translate_fn or provider_mod.translate_group
        self._list_models = list_models_fn or provider_mod.list_models
        self._lock = threading.Lock()
        self._gen = 0
        self._busy = False
        self._step = 0
        self._started = None
        self._report = None

    def start(self, snapshot, on_done=None):
        """Begin a run with the click-time inputs. False when one is flying."""
        frozen = dict(snapshot)
        with self._lock:
            if self._busy:
                return False
            self._busy = True
            self._gen += 1
            gen = self._gen
            self._step = 1
            self._started = time.monotonic()

        def worker():
            def on_step(n):
                with self._lock:
                    if self._gen == gen:
                        self._step = n
            try:
                report = run_connection_test(frozen, self._translate,
                                             self._list_models,
                                             on_step=on_step)
            except Exception as e:  # a raising transport must not wedge the UI
                report = _crash_report(frozen, e)
            with self._lock:
                stale = gen != self._gen
                if not stale:
                    self._report = report
                    self._busy = False
                    self._step = 0
            if not stale and on_done is not None:
                try:
                    on_done(report)
                except Exception:
                    pass

        threading.Thread(target=worker, daemon=True,
                         name="connection-test").start()
        return True

    def cancel(self):
        """Give up waiting: free the UI now and invalidate the in-flight
        run's generation so it cannot write its report back. The HTTP request
        itself is not interrupted and its quota is not refunded."""
        with self._lock:
            self._gen += 1
            self._busy = False
            self._step = 0

    def is_running(self):
        with self._lock:
            return self._busy

    def progress(self):
        with self._lock:
            if not self._busy or self._started is None:
                return {"running": False, "step": 0, "elapsed_s": 0.0}
            return {"running": True, "step": self._step,
                    "elapsed_s": round(time.monotonic() - self._started, 1)}

    def last_report(self):
        with self._lock:
            return self._report

    def status_payload(self):
        """The /status addition. Empty until a run has produced a report -
        a never-run test must not read as an empty report (decision 17)."""
        with self._lock:
            if self._report is None:
                return {}
            return {"connection_test": self._report}
