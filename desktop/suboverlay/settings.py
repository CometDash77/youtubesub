"""Settings: JSON file in %APPDATA%/SubOverlay, save-on-change, .bak on corruption.
Adapted ideas from LiveSubs Setting.cs + WindowHandler.cs (Apache-2.0)."""
import json, os, shutil

APP_DIR_NAME = "SubOverlay"
FILE_NAME = "setting.json"


def default_settings():
    return {
        "provider": {"base_url": "", "api_key": "", "model": "", "protocol": "auto",
                     "timeout_s": 60.0, "max_concurrent": 5},
        "prompt": {"system": "Translate the following subtitles into Chinese. Return ONLY the translation, one line per input line, in the same order. Do not add explanations.",
                   "context_groups": 1},
        # Prefetch / batch parameters (spec #24, ADR-007). Read-only defaults:
        # they exist as config values but are deliberately NOT exposed in the
        # settings UI (UI exposure belongs to the "config-trusted UX" work item).
        # Values need real-Key calibration (milestone M) - do not treat them as
        # final.
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
    return cfg


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
