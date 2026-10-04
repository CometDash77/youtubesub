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
        # Prefetch / batch parameters (spec #24, ADR-007). Exposed by the debug
        # window's tuning page in its "experimental / uncalibrated" group since
        # map #152 / spec #161; ranges and defaults live in TUNING_FIELDS below.
        # Values still need real-Key calibration (milestone M) - do not treat
        # them as final.
        "prefetch": {"lead_s": 90.0,       # lead window measured in SECONDS (decoupled from subtitle density)
                     "max_groups": 20,      # hard group cap bounding the window (first of the two to hit wins)
                     "seek_debounce_ms": 400},  # quiet time before a window refill after a timeline jump
        "batch": {"max_groups": 8,         # max sentence groups per batched request
                   "max_chars": 8000},      # max chars (text + its own context) per batched request,
        "display": {"mode": "bilingual", "order": "trans_first", "history_lines": 2,
                    "font_size": 10, "font_bold": "none", "stroke": 1.5,
                    "bg_color": [0, 0, 0], "bg_opacity": 150},
        "window": {"x": None, "y": None, "w": 380, "h": 64},
        "server": {"port": 9877},
    }


# ---- Tuning-page field authority table (#152 / spec #161, ticket #158) ----
# The parameters that own a config key but have no UI of their own. This table
# is the ONE authority for their range, default, unit and effect timing: the
# debug window's tuning page builds its controls from it and clamps through it
# (spec #161 decision 5). Being listed here does NOT add a key to the file -
# the schema stays frozen.
#
# `control` is the widget kind the page must use, one per spec #161's table:
# "choice" (下拉), "int" / "float" (数字框), "slider" (滑条 + 数字框, 背景不透明度),
# "color" (取色器).
TUNING_GROUPS = ("display", "network", "experimental")


def _tune(path, group, label, control, default, **kw):
    spec = {"path": path, "group": group, "label": label, "control": control,
            "default": default, "choices": (), "labels": (), "min": None,
            "max": None, "step": None, "scale": 1, "unit": "",
            "restart": False, "uncalibrated": False, "notify_overlay": False,
            "hint": ""}
    spec.update(kw)
    return spec


TUNING_FIELDS = (
    _tune(("display", "mode"), "display", "显示模式", "choice", "bilingual",
          choices=("bilingual", "trans", "orig"), labels=("双语", "只看译文", "只看原文"),
          notify_overlay=True),
    _tune(("display", "order"), "display", "上下顺序", "choice", "trans_first",
          choices=("trans_first", "orig_first"), labels=("译文在上", "原文在上"),
          notify_overlay=True, hint="仅双语模式可用"),
    _tune(("display", "history_lines"), "display", "历史保留行数", "int", 2,
          min=0, max=10, step=1),
    _tune(("display", "font_bold"), "display", "粗体范围", "choice", "none",
          choices=("none", "trans_only", "sub_only", "both"),
          labels=("都不粗", "只译文", "只原文", "都粗")),
    _tune(("display", "stroke"), "display", "描边宽度", "float", 1.5,
          min=0.0, max=10.0, step=0.5, hint="0 = 不描边"),
    _tune(("display", "bg_color"), "display", "背景色", "color", [0, 0, 0],
          min=0, max=255),
    _tune(("display", "bg_opacity"), "display", "背景不透明度", "slider", 150,
          min=0, max=255, step=1),
    _tune(("provider", "timeout_s"), "network", "请求超时", "float", 60.0,
          min=1.0, max=600.0, step=1.0, unit="秒"),
    _tune(("provider", "max_concurrent"), "network", "同时请求数", "int", 5,
          min=1, max=16, step=1, restart=True, hint="重启后生效"),
    _tune(("server", "port"), "network", "服务端口", "int", 9877,
          min=1, max=65535, step=1, restart=True, hint="重启后生效"),
    _tune(("prefetch", "lead_s"), "experimental", "预取窗口秒数", "float", 90.0,
          min=0.0, max=600.0, step=1.0, unit="秒", uncalibrated=True),
    _tune(("prefetch", "max_groups"), "experimental", "预取组数上限", "int", 20,
          min=1, max=200, step=1, uncalibrated=True),
    _tune(("prefetch", "seek_debounce_ms"), "experimental", "seek 静默等待",
          "float", 0.4, min=0.0, max=5.0, step=0.1, unit="秒", scale=1000,
          uncalibrated=True),
    _tune(("batch", "max_groups"), "experimental", "批量组数上限", "int", 8,
          min=1, max=64, step=1, uncalibrated=True),
    _tune(("batch", "max_chars"), "experimental", "批量字符上限", "int", 8000,
          min=100, max=64000, step=500, uncalibrated=True),
)

_FIELDS_BY_PATH = {f["path"]: f for f in TUNING_FIELDS}


def field_by_path(path):
    """Field spec for a (section, key) path; KeyError when not tunable."""
    return _FIELDS_BY_PATH[tuple(path)]


def is_scaled(field):
    """True when the page shows one unit and the file stores another (seek)."""
    return field.get("scale", 1) != 1


def _is_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float))


def _raw(cfg, field):
    section, key = field["path"]
    node = cfg.get(section) if isinstance(cfg, dict) else None
    return node.get(key) if isinstance(node, dict) else None


def _clamp_number(field, value):
    """Clamp a numeric UI value into range; None when it is not a number."""
    if not _is_number(value):
        return None
    v = min(max(float(value), float(field["min"])), float(field["max"]))
    return int(round(v)) if field["control"] in ("int", "slider") else float(v)


def _clamp_channels(field, value):
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return None
    out = []
    for channel in value:
        if not _is_number(channel):
            return None
        out.append(int(round(min(max(float(channel), float(field["min"])),
                                 float(field["max"])))))
    return out


def display_value(field, cfg):
    """Stored value -> UI value (clamped, UI unit). Never raises: a hand-edited
    or corrupted value falls back to the field default."""
    raw = _raw(cfg, field)
    if field["control"] == "choice":
        return raw if raw in field["choices"] else field["default"]
    if field["control"] == "color":
        channels = _clamp_channels(field, raw)
        return channels if channels is not None else list(field["default"])
    if not _is_number(raw):
        return field["default"]
    value = _clamp_number(field, raw / field.get("scale", 1))
    return field["default"] if value is None else value


def stored_value(field, ui_value):
    """UI value -> stored value (clamped, stored unit)."""
    if field["control"] == "choice":
        return ui_value if ui_value in field["choices"] else field["default"]
    if field["control"] == "color":
        channels = _clamp_channels(field, ui_value)
        return channels if channels is not None else list(field["default"])
    value = _clamp_number(field, ui_value)
    if value is None:
        value = _clamp_number(field, field["default"])
    scale = field.get("scale", 1)
    return int(round(value * scale)) if scale != 1 else value


def tuning_ui_state(cfg):
    """UI-unit working copy of every tunable field (fresh lists, never aliases
    cfg). The page edits this; the file is written only on 确定."""
    return {f["path"]: display_value(f, cfg) for f in TUNING_FIELDS}


def collect_edits(ui_state, initial_state):
    """Paths whose UI value differs from the state the page loaded, in page
    order. Value equality (not a dirty flag) is what makes an untouched key
    stay untouched - including hand-edited out-of-range values."""
    edits = []
    for f in TUNING_FIELDS:
        path = f["path"]
        if path in ui_state and path in initial_state and ui_state[path] != initial_state[path]:
            edits.append((path, ui_state[path]))
    return edits


def apply_edits(cfg, edits):
    """Write clamped+converted values into cfg in place; returns the applied
    paths. Keys outside TUNING_FIELDS raise - the page cannot reach them."""
    applied = []
    for path, ui_value in edits:
        field = field_by_path(path)
        section, key = field["path"]
        node = cfg.get(section)
        if not isinstance(node, dict):
            node = cfg[section] = {}
        node[key] = stored_value(field, ui_value)
        applied.append(field["path"])
    return applied


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
