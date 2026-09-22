"""Settings: JSON file in %APPDATA%/SubOverlay, save-on-change, .bak on corruption.
Adapted ideas from LiveSubs Setting.cs + WindowHandler.cs (Apache-2.0)."""
import json, os, shutil

APP_DIR_NAME = "SubOverlay"
FILE_NAME = "setting.json"

# Built-in presets (issue #39 / ADR-010): three, single category, locked in
# code - never persisted, never renamed, never deleted. The default text is
# the legacy prompt.system default, preserved verbatim.
DEFAULT_PROMPT_TEXT = (
    "Translate the following subtitles into Chinese. Return ONLY the translation, one line per input line, in the same order. Do not add explanations.")
LITERAL_PROMPT_TEXT = (
    "Translate the following subtitles into Chinese. Render technical terms and proper names with their commonly accepted literal translations; keep numbers, units and amounts exactly as written; add or remove no information. Return ONLY the translation, one line per input line, in the same order. Do not add explanations.")
NATURAL_PROMPT_TEXT = (
    "Translate the following subtitles into Chinese as natural, colloquial spoken language - the way a native speaker would actually say it in everyday conversation. Return ONLY the translation, one line per input line, in the same order. Do not add explanations.")

BUILTIN_PROMPTS = (
    {"id": "default", "name": "Default", "text": DEFAULT_PROMPT_TEXT},
    {"id": "literal", "name": "Literal", "text": LITERAL_PROMPT_TEXT},
    {"id": "natural", "name": "Natural", "text": NATURAL_PROMPT_TEXT},
)

# One-way migration of the legacy free-form prompt.system key (#39).
MIGRATED_PRESET_ID = "prompt_migrated"
MIGRATED_PRESET_NAME = "\u65e7\u7248\u81ea\u5b9a\u4e49"   # 旧版自定义 - name fixed by #39


def active_prompt_text(cfg):
    """Text of the active preset: built-in by id, custom from
    prompt.presets, else the default built-in. The one resolver shared by
    the engine (identity + wire) and the panel preview (#39)."""
    pr = cfg.get("prompt") if isinstance(cfg, dict) else None
    pr = pr if isinstance(pr, dict) else {}
    active = pr.get("active")
    for b in BUILTIN_PROMPTS:
        if b["id"] == active:
            return b["text"]
    for c in (pr.get("presets") or []):
        if isinstance(c, dict) and c.get("id") == active and isinstance(c.get("text"), str):
            return c["text"]
    return DEFAULT_PROMPT_TEXT


def default_settings():
    return {
        "provider": {"base_url": "", "api_key": "", "model": "", "protocol": "auto",
                     "timeout_s": 60.0, "max_concurrent": 5},
        # Schema per #39: active = built-in id or custom id; presets = custom
        # array only (built-ins never appear here); legacy prompt.system is
        # migrated one-way in load() and never returns.
        "prompt": {"active": "default", "presets": [], "context_groups": 1},
        "display": {"mode": "bilingual", "order": "trans_first", "history_lines": 2,
                    "font_size": 10, "font_bold": "none", "stroke": 1.5,
                    "bg_color": [0, 0, 0], "bg_opacity": 150},
        "window": {"x": None, "y": None, "w": 380, "h": 64},
        "server": {"port": 9877},
    }


def settings_dir():
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(base, APP_DIR_NAME)


def settings_path():
    return os.path.join(settings_dir(), FILE_NAME)


def load(path=None):
    """Load settings; corrupt file -> renamed to .bak, defaults returned."""
    p = path or settings_path()
    cfg = default_settings()
    if not os.path.exists(p):
        return cfg
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        try:
            shutil.move(p, p + ".bak")
        except OSError:
            pass
        return cfg
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    if _normalize_prompt(cfg):
        # One-way migration (#39): the legacy prompt.system key is already
        # gone from memory - write the file back now so old and new schema
        # never coexist on disk. Schema operation, not a user save:
        # _meta.saved_at stays untouched (file mtime remains untrusted, #4).
        try:
            save(cfg, p)
        except OSError:
            pass
    return cfg


_LEGACY = object()


def _valid_preset(item):
    return (isinstance(item, dict) and isinstance(item.get("id"), str)
            and bool(item.get("id")) and "text" in item
            and isinstance(item.get("text"), str))


def _normalize_prompt(cfg):
    """#39 / ADR-010 schema normalization + one-way migration.

    Returns True iff the legacy prompt.system key was removed (caller must
    write the file back). Damaged prompt node resets to defaults; a damaged
    presets array falls back to []; active pointing at a missing id falls
    back to "default"."""
    pr = cfg.get("prompt")
    if not isinstance(pr, dict):
        d = default_settings()["prompt"]
        cfg["prompt"] = {"active": d["active"], "presets": [],
                         "context_groups": d["context_groups"]}
        return False
    legacy = pr.pop("system", _LEGACY)
    had_legacy = legacy is not _LEGACY
    presets = pr.get("presets")
    if not isinstance(presets, list) or not all(_valid_preset(x) for x in presets):
        presets = []
    if had_legacy:
        content = legacy.strip() if isinstance(legacy, str) else ""
        if content and content != DEFAULT_PROMPT_TEXT:
            if not any(x.get("id") == MIGRATED_PRESET_ID for x in presets):
                presets.append({"id": MIGRATED_PRESET_ID,
                                "name": MIGRATED_PRESET_NAME, "text": content})
            pr["active"] = MIGRATED_PRESET_ID
        # empty or equal to the built-in default: the key is simply dropped
    pr["presets"] = presets
    known = {b["id"] for b in BUILTIN_PROMPTS} | {x["id"] for x in presets}
    if not isinstance(pr.get("active"), str) or pr["active"] not in known:
        pr["active"] = "default"
    pr.setdefault("context_groups", default_settings()["prompt"]["context_groups"])
    return had_legacy


def save(cfg, path=None):
    """Atomic save (tmp + replace). Never logs or prints the api key."""
    p = path or settings_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, p)
    return p


def redact(cfg):
    """Public summary for untrusted consumers (transly providerSummary rule)."""
    prov = cfg.get("provider", {}) if isinstance(cfg, dict) else {}
    return {"configured": bool(prov.get("base_url")) and bool(prov.get("model")),
            "host": (prov.get("base_url") or "").split("/")[2] if "://" in (prov.get("base_url") or "") else "",
            "model": prov.get("model", ""), "protocol": prov.get("protocol", "auto")}
