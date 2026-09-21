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


def translate_group(cfg, group_text, context_prev="", context_next="",
                    expected_lines=0, sleep=time.sleep, now=time.time):
    """Translate one sentence group with retries/backoff.

    Returns dict {aligned: bool, values: [..] or None, text: str or None, cached_hint: str}.
    expected_lines > 0 requests the aligned protocol (N|line) and validates strictly;
    on shape miss the caller may retry in whole-line mode (never split a sentence).
    cfg keys: base_url, api_key, model, protocol, timeout_s, max_retries, system.
    Never raises for provider failures - returns {error: code}.
    """
    model = (cfg.get("model") or "").strip()
    if not model:
        return {"error": "NO_MODEL"}
    try:
        endpoint, protocol = coerce_endpoint(cfg.get("base_url"), cfg.get("protocol"))
    except ProviderError as e:
        return {"error": e.code}
    instructions = cfg.get("system") or DEFAULT_SYSTEM_PROMPT
    prompt = group_text
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
                if expected_lines > 1:
                    vals = unpack_numbered(out, expected_lines)
                    if vals is not None:
                        return {"aligned": True, "values": vals, "error": None}
                    last_err = ProviderError("SHAPE_MISS", "aligned output count mismatch")
                    break  # shape miss: caller degrades to whole-line, no re-ask
                return {"aligned": False, "text": out.strip(), "error": None}
        else:
            last_err = map_status_error(status, text)
            ra = _retry_after_s(rh)
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
    return {"error": code, "message": str(last_err) if last_err else None}


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
    except (urllib.error.URLError, json.JSONDecodeError, OSError, ValueError):
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
