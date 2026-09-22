"""OpenAI-compatible translation client (clean-room Python).

Designs absorbed from transly src/provider (MIT, (c) 2026 Haitian):
single {instructions, prompt} shape, protocol auto-detect + endpoint rewrite,
SSE-or-JSON response normalization, strict output validation, narrow repair.
Added here (transly gaps): retries + exponential backoff + 429/Retry-After,
proxy-aware transport, user-configurable system prompt.
"""
import json, re, time, urllib.request, urllib.error

REQUEST_TIMEOUT_S = 60.0
MODELS_TIMEOUT_S = 15.0
MAX_RETRIES = 3
BACKOFF_BASE_S = 1.0
MAX_BODY_ERR_CHARS = 4000
DEFAULT_SYSTEM_PROMPT = (
    "You are a subtitle translator. Translate the user's text into Chinese.")

class ProviderError(Exception):
    def __init__(self, code, message, status=None, retryable=False):
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable


def coerce_endpoint(base_url, protocol):
    """Normalize base URL + protocol to a concrete action endpoint.
    protocol in {auto, responses, chat-completions}; auto picks from URL suffix
    (chat/completions) else responses. Returns (endpoint, protocol)."""
    base = (base_url or "").strip().rstrip("/")
    if not base:
        raise ProviderError("BAD_CONFIG", "Base URL is empty")
    if "://" not in base:
        raise ProviderError("BAD_CONFIG", "Base URL must be absolute http(s) URL")
    scheme = base.split("://", 1)[0].lower()
    if scheme not in ("http", "https"):
        raise ProviderError("BAD_CONFIG", "Base URL must be http(s)")
    p = (protocol or "auto").strip().lower() or "auto"
    if p == "auto":
        p = "chat-completions" if base.endswith("/chat/completions") else "responses"
    if p == "chat-completions":
        if base.endswith("/responses"):
            base = base[: -len("/responses")] + "/chat/completions"
        elif not base.endswith("/chat/completions"):
            base = base + "/chat/completions"
    elif p == "responses":
        if base.endswith("/chat/completions"):
            base = base[: -len("/chat/completions")] + "/responses"
        elif not base.endswith("/responses"):
            base = base + "/responses"
    else:
        raise ProviderError("BAD_CONFIG", "Unknown protocol: " + str(protocol))
    return base, p


def models_endpoint(action_endpoint):
    """Strip the action suffix to derive GET .../models."""
    for suffix in ("/chat/completions", "/responses"):
        if action_endpoint.endswith(suffix):
            return action_endpoint[: -len(suffix)] + "/models"
    return action_endpoint.rstrip("/") + "/models"

def build_body(protocol, model, instructions, prompt, stream=False):
    if protocol == "chat-completions":
        return {"model": model, "stream": stream,
                "messages": [{"role": "system", "content": instructions},
                             {"role": "user", "content": prompt}]}
    return {"model": model, "store": False, "stream": stream,
            "instructions": instructions,
            "input": [{"role": "user",
                       "content": [{"type": "input_text", "text": prompt}]}]}


def extract_complete_text(protocol, body):
    """Pull the assistant text out of a complete (non-stream) JSON body."""
    if not isinstance(body, dict):
        raise ProviderError("INVALID_MODEL_OUTPUT", "Response body is not an object")
    if protocol == "chat-completions":
        try:
            content = body["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            content = None
        if isinstance(content, list):
            content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
        if isinstance(content, str) and content:
            return content
    else:
        if isinstance(body.get("output_text"), str) and body["output_text"]:
            return body["output_text"]
        chunks = []
        for item in body.get("output", []) or []:
            for part in (item.get("content", []) if isinstance(item, dict) else []) or []:
                if isinstance(part, dict) and part.get("type") == "output_text":
                    chunks.append(part.get("text", ""))
        if chunks:
            return "".join(chunks)
    raise ProviderError("INVALID_MODEL_OUTPUT", "Response carried no text")

def _do_post(url, headers, payload, timeout_s):
    """One HTTP POST via proxy-aware urllib (respects HTTP_PROXY/HTTPS_PROXY,
    but never proxies localhost). Returns (status, resp_headers, body_text)."""
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                   headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return resp.status, dict(resp.headers.items()), resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")
        except Exception:
            detail = ""
        return e.code, dict(e.headers.items()), detail[:MAX_BODY_ERR_CHARS]


_FENCE_RE = None  # built lazily without backslash-in-source hazards


def _strip_fence(text):
    """Remove a leading/trailing ``` or ```json fence if present."""
    t = text.strip()
    if t.startswith(chr(96) * 3):
        nl = t.find(chr(10))
        t = t[nl + 1:] if nl != -1 else ""
        end = t.rfind(chr(96) * 3)
        if end != -1:
            t = t[:end]
    return t.strip()


def unpack_numbered(raw, expected_n):
    """Validate aligned model output: exactly expected_n distinct in-range
    non-empty 'N|translation' lines, else None (all-or-nothing).
    Adapted from yt-dual-subs background.js unpackNumbered (MIT)."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    lines = _strip_fence(raw).splitlines()
    vals = {}
    for line in lines:
        line = line.strip()
        if not line or chr(124) not in line:
            continue
        head, _, body = line.partition(chr(124))
        head = head.strip()
        if not head.isdigit():
            continue
        i = int(head)
        body = body.strip()
        if i < 1 or i > expected_n or not body or i in vals:
            return None
        vals[i] = body
    if len(vals) != expected_n:
        return None
    return [vals[i] for i in range(1, expected_n + 1)]


def map_status_error(status, body_text):
    """HTTP status -> ProviderError with retryable flag (429/5xx retryable)."""
    snippet = " ".join((body_text or "").split())[:500]
    if status == 401:
        return ProviderError("AUTH", "401 unauthorized", status)
    if status == 403:
        return ProviderError("FORBIDDEN", "403 forbidden", status)
    if status in (402, 429):
        return ProviderError("RATE_LIMITED", str(status) + " rate limited: " + snippet,
                             status, retryable=True)
    if status >= 500:
        return ProviderError("SERVER", str(status) + " server error", status, retryable=True)
    return ProviderError("BAD_REQUEST", str(status) + ": " + snippet, status)


def _headers(api_key):
    h = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key:
        h["Authorization"] = "Bearer " + api_key
    return h


def _retry_after_s(headers):
    try:
        v = (headers or {}).get("Retry-After") or (headers or {}).get("retry-after")
        return max(0.0, float(v))
    except (TypeError, ValueError):
        return None


def build_instructions(preset_text, context_prev="", context_next="",
                      expected_lines=0):
    """THE single system-prompt assembly function (ADR-010 / issue #39).

    Three segments, fixed order, none overriding another:
      1. preset text - the task-definition segment, the only user-editable one;
      2. neighbour context label lines - protocol segment, appended only when
         context is non-empty (the caller gates on prompt.context_groups);
      3. the N|line alignment instruction - protocol segment, appended only
         when expected_lines > 1.
    The user message is always the pure current sentence and is NOT built
    here. Production (translate_group), the panel read-only preview and the
    connection test all call this function - never a copy of it. The wording
    is byte-pinned: it feeds the cache identity, so changing it would fork
    every cache row for zero user benefit (#39 Testing Decision 2)."""
    instructions = preset_text or DEFAULT_SYSTEM_PROMPT
    if context_prev or context_next:
        ctx = []
        if context_prev:
            ctx.append("Previous line (context only, do not translate): " + context_prev)
        if context_next:
            ctx.append("Next line (context only, do not translate): " + context_next)
        instructions = instructions + chr(10) + chr(10).join(ctx)
    if expected_lines > 1:
        instructions = instructions + chr(10) + (
            "The input is one sentence split into " + str(expected_lines) +
            " subtitle lines. Translate the whole sentence, then output exactly " +
            str(expected_lines) + " lines in format 'N|translation' (N=1.." +
            str(expected_lines) + ") matching the original line breaks. No other text.")
    return instructions


def _timed_out(e):
    """True when a socket-level OSError is a timeout (connect or read).
    socket.timeout IS TimeoutError since 3.10; Windows can also surface the
    condition by message, so match both (#23 decision 14)."""
    reason = getattr(e, "reason", e)
    if isinstance(reason, TimeoutError):
        return True
    blob = (str(reason) + " " + str(e)).lower()
    return "timed out" in blob or "timedout" in blob


def _network_message(e, kind, timeout_s):
    if kind == "TIMEOUT":
        return "timed out after %gs waiting for the endpoint" % timeout_s
    detail = str(getattr(e, "reason", "") or e)
    return "connection failed: " + detail[:300]


def translate_group(cfg, group_text, context_prev="", context_next="",
                    expected_lines=0, sleep=time.sleep, now=time.time):
    """Translate one sentence group with retries/backoff.

    Returns dict {aligned, values, text, error, message, attempts} - attempts
    counts the HTTP tries actually made (0 when nothing was sent), because the
    connection test's report must show whether retries multiplied usage (#23).
    expected_lines > 0 requests the aligned protocol (N|line) and validates strictly;
    on shape miss the caller may retry in whole-line mode (never split a sentence).
    cfg keys: base_url, api_key, model, protocol, timeout_s, max_retries, system.
    Never raises for provider failures - connection failures included (#23
    decision 14: they used to escape as URLError and surface as WORKER).
    """
    model = (cfg.get("model") or "").strip()
    if not model:
        return {"error": "NO_MODEL", "message": None, "attempts": 0}
    try:
        endpoint, protocol = coerce_endpoint(cfg.get("base_url"), cfg.get("protocol"))
    except ProviderError as e:
        return {"error": e.code, "message": str(e), "attempts": 0}
    instructions = build_instructions(cfg.get("system"), context_prev,
                                     context_next, expected_lines)
    prompt = group_text
    body = build_body(protocol, model, instructions, prompt, stream=False)
    timeout_s = float(cfg.get("timeout_s") or REQUEST_TIMEOUT_S)
    max_retries = int(cfg.get("max_retries") if cfg.get("max_retries") is not None else MAX_RETRIES)
    headers = _headers(cfg.get("api_key"))

    last_err = None
    ra = None
    attempts = 0
    status = None
    rh = None
    for attempt in range(max_retries + 1):
        try:
            status, rh, text = _do_post(endpoint, headers, body, timeout_s)
        except OSError as e:
            # #23 decision 14: a timeout is transient (retried like a 5xx);
            # a refused/reset connection is deterministic and fails fast with
            # its real cause instead of an internal WORKER error.
            attempts += 1
            kind = "TIMEOUT" if _timed_out(e) else "NETWORK"
            last_err = ProviderError(kind, _network_message(e, kind, timeout_s),
                                     None, retryable=(kind == "TIMEOUT"))
            status, rh = None, None
        else:
            attempts += 1
            if status == 200:
                try:
                    out = extract_complete_text(protocol, json.loads(text))
                except (json.JSONDecodeError, ValueError):
                    last_err = ProviderError("INVALID_MODEL_OUTPUT", "response is not JSON")
                except ProviderError as e:
                    last_err = e
                else:
                    if expected_lines > 1:
                        vals = unpack_numbered(out, expected_lines)
                        if vals is not None:
                            return {"aligned": True, "values": vals, "error": None,
                                    "attempts": attempts}
                        last_err = ProviderError("SHAPE_MISS", "aligned output count mismatch")
                        break  # shape miss: caller degrades to whole-line, no re-ask
                    return {"aligned": False, "text": out.strip(), "error": None,
                            "attempts": attempts}
            else:
                last_err = map_status_error(status, text)
                ra = _retry_after_s(rh)
        if not getattr(last_err, "retryable", False):
            break
        if attempt < max_retries:
            if status is not None and status in (402, 429):
                ra = _retry_after_s(rh)
                delay = ra if ra is not None else BACKOFF_BASE_S * (2 ** attempt)
            else:
                delay = BACKOFF_BASE_S * (2 ** attempt)
            sleep(min(delay, 30.0))
    code = getattr(last_err, "code", None) or "UNKNOWN"
    message = str(last_err) if last_err else None
    if code == "RATE_LIMITED" and ra is not None:
        # user story 9: the server's own wait time travels with the verdict
        message = "%s (server asked to retry after %gs)" % (message, ra)
    return {"error": code, "message": message, "attempts": attempts}


def slice_numbered_batch(raw, counts):
    """Batch output contract (spec #24 / ADR-007): globally continuous numbering.

    counts = per-group line counts (each >= 1); T = sum(counts). The model must
    return exactly '1|... .. T|...' covering every line - the SAME exact-full-
    coverage semantics as the single-group aligned protocol, reused unmodified
    via unpack_numbered. Any deviation (missing / extra / duplicate / empty /
    out-of-range line) returns None and voids the WHOLE batch: "missing-line
    patching" is forbidden because a model that drops a line usually
    re-numbers the rest contiguously, making the misalignment undetectable
    from the text itself. On success returns the per-group slices.
    """
    if not counts or any(int(c) < 1 for c in counts):
        return None
    vals = unpack_numbered(raw, sum(int(c) for c in counts))
    if vals is None:
        return None
    out, i = [], 0
    for c in counts:
        out.append(vals[i:i + int(c)])
        i += int(c)
    return out


def _batch_prompt(items):
    """User message for a batch: only sentence texts, one marked section each.

    Mirrors the single-group composition (user = pure current sentence, no
    context) - context travels in the instructions instead (see
    _batch_instructions), so batch and single requests keep the same shape of
    contract. items = [{text, prev, nxt, expected}].
    """
    sections = []
    for i, it in enumerate(items, 1):
        sections.append("Sentence " + str(i) + " (" + str(max(1, int(it.get("expected") or 1)))
                        + " lines):" + chr(10) + (it.get("text") or ""))
    return chr(10).join(sections)


def _batch_instructions(base, items, counts):
    """System instructions for a batch: base prompt -> per-sentence context
    label lines (same wording as the single path - each group carries ITS OWN
    context, ADR-007) -> the batch alignment protocol paragraph.
    """
    parts = [base or DEFAULT_SYSTEM_PROMPT]
    for i, it in enumerate(items, 1):
        ctx = []
        if it.get("prev"):
            ctx.append("Previous line (context only, do not translate): " + it["prev"])
        if it.get("nxt"):
            ctx.append("Next line (context only, do not translate): " + it["nxt"])
        if ctx:
            parts.append("Context for sentence " + str(i) + ":" + chr(10) + chr(10).join(ctx))
    total = sum(counts)
    parts.append(
        "The input contains " + str(len(items)) + " sentences; sentence i has the number "
        "of subtitle lines announced above. Translate every sentence. Output exactly "
        + str(total) + " lines in format 'N|translation' (N=1.." + str(total)
        + ") covering the subtitle lines of all sentences in order. No other text.")
    return chr(10).join(parts)


def translate_batch(cfg, items, sleep=time.sleep, now=time.time):
    """Translate several sentence groups in ONE request (spec #24 / ADR-007).

    items = [{text, prev, nxt, expected}] (expected = per-group line count).
    Returns a list of result dicts aligned with items:
      success -> {aligned: True, values: [..], error: None} per group (sliced
                 from the globally numbered output by the known line counts);
      failure -> every element carries the SAME error: the batch is all-or-
                 nothing. No retry of a shape miss, no splitting, no fallback
                 to whole-line mode - the caller drops the whole batch and the
                 per-group urgent path re-translates at play time.
    Transport-level retries/backoff (429/5xx, decision #24.14) are shared with
    translate_group; they are wire errors, not contract failures.
    Never raises for provider failures.
    """
    counts = [max(1, int(it.get("expected") or 1)) for it in items]

    def _failed(code, message=None):
        return [{"aligned": False, "text": "", "error": code, "message": message}
                for _ in items]

    if not items:
        return []
    model = (cfg.get("model") or "").strip()
    if not model:
        return _failed("NO_MODEL")
    try:
        endpoint, protocol = coerce_endpoint(cfg.get("base_url"), cfg.get("protocol"))
    except ProviderError as e:
        return _failed(e.code, str(e))
    instructions = _batch_instructions(cfg.get("system") or DEFAULT_SYSTEM_PROMPT, items, counts)
    prompt = _batch_prompt(items)
    body = build_body(protocol, model, instructions, prompt, stream=False)
    timeout_s = float(cfg.get("timeout_s") or REQUEST_TIMEOUT_S)
    max_retries = int(cfg.get("max_retries") if cfg.get("max_retries") is not None else MAX_RETRIES)
    headers = _headers(cfg.get("api_key"))

    last_err = None
    for attempt in range(max_retries + 1):
        status, rh, text = _do_post(endpoint, headers, body, timeout_s)
        if status == 200:
            try:
                out = extract_complete_text(protocol, json.loads(text))
            except (json.JSONDecodeError, ValueError):
                last_err = ProviderError("INVALID_MODEL_OUTPUT", "response is not JSON")
            except ProviderError as e:
                last_err = e
            else:
                sliced = slice_numbered_batch(out, counts)
                if sliced is None:
                    # Contract miss: whole batch void, no retry / no split.
                    return _failed("SHAPE_MISS", "batch output does not exactly cover 1..T")
                return [{"aligned": True, "values": v, "error": None} for v in sliced]
        else:
            last_err = map_status_error(status, text)
        if not getattr(last_err, "retryable", False):
            break
        if attempt < max_retries:
            if status != 200 and status in (402, 429):
                ra = _retry_after_s(rh)
                delay = ra if ra is not None else BACKOFF_BASE_S * (2 ** attempt)
            else:
                delay = BACKOFF_BASE_S * (2 ** attempt)
            sleep(min(delay, 30.0))
    code = getattr(last_err, "code", None) or "UNKNOWN"
    return _failed(code, str(last_err) if last_err else None)


def list_models(cfg, timeout_s=MODELS_TIMEOUT_S):
    """GET {base}/models; returns (ids, error_code). Manual entry stays valid on any error."""
    try:
        endpoint, protocol = coerce_endpoint(cfg.get("base_url"), cfg.get("protocol"))
    except ProviderError as e:
        return [], e.code
    url = models_endpoint(endpoint)
    req = urllib.request.Request(url, headers=_headers(cfg.get("api_key")), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return [], "HTTP_" + str(e.code)
    except json.JSONDecodeError:
        # answered (2xx) but not a model list: reachable, nothing to check
        # membership against - the step-1 "list unavailable" observation (#23)
        return [], "INVALID_MODEL_OUTPUT"
    except OSError as e:
        return [], "TIMEOUT" if _timed_out(e) else "NETWORK"
    except ValueError:
        return [], "NETWORK"
    items = body.get("data") if isinstance(body, dict) else None
    if not isinstance(items, list):
        items = body.get("models") if isinstance(body, dict) else None
    ids = []
    for it in items or []:
        mid = it if isinstance(it, str) else (it.get("id") or it.get("name") if isinstance(it, dict) else None)
        if isinstance(mid, str) and mid.strip() and mid not in ids:
            ids.append(mid.strip())
    return ids, None
