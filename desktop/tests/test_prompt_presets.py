"""#39 / ADR-010 - prompt presets: identity forks, wire shape, one-way migration,
and the preview == production shared-assembly-function contract."""
import json, os, sys, types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from suboverlay import provider as P
from suboverlay import settings as S
from suboverlay.engine import Engine
from suboverlay.queue_cache import TranslationCache

GROUP = types.SimpleNamespace(text="Hello world, this is a sentence.")


def _engine(tmp_path, active="default", presets=None, tag="a"):
    s = S.default_settings()
    s["provider"].update({"base_url": "https://x.test/v1", "model": "m", "mock": True})
    s["prompt"]["active"] = active
    if presets is not None:
        s["prompt"]["presets"] = presets
    return Engine(s, cache=TranslationCache(os.path.join(str(tmp_path), "t-%s.db" % tag)),
                  workers=1)


def _ident_ns(e):
    """(identity, namespace) the engine would use for GROUP right now."""
    prov, instr = e._provider_snapshot()
    ident = e._identity(prov, instr, "video|manual|0|1000|Hello", GROUP, ("", ""))
    return ident, e._namespace_of(prov, instr)


# ---------------------------------------------------------------------------
# Testing Decision 1 - identity x preset (engine / identity layer)
# ---------------------------------------------------------------------------

def test_switching_builtin_preset_forks_identity_and_namespace(tmp_path):
    """active default -> literal -> natural: every switch must fork both the
    identity and the translation namespace; switching back to default must be
    byte-identical to the first run (the fork is deterministic, not one-way)."""
    e = _engine(tmp_path)
    try:
        id_def, ns_def = _ident_ns(e)
        e.settings["prompt"]["active"] = "literal"
        id_lit, ns_lit = _ident_ns(e)
        assert id_lit != id_def, "switching preset must change the identity"
        assert ns_lit != ns_def, "switching preset must change the namespace"
        e.settings["prompt"]["active"] = "natural"
        id_nat, ns_nat = _ident_ns(e)
        assert id_nat not in (id_def, id_lit)
        assert ns_nat not in (ns_def, ns_lit)
        e.settings["prompt"]["active"] = "default"
        id_back, ns_back = _ident_ns(e)
        assert id_back.encode("utf-8") == id_def.encode("utf-8"), \
            "returning to default must reproduce the first identity byte-for-byte"
        assert ns_back == ns_def
    finally:
        e._queue.shutdown()


def test_editing_and_deleting_a_custom_preset_fork_identity(tmp_path):
    """A one-character edit of the active custom text forks identity and
    namespace; deleting the active custom (falling back to default) forks both
    too - the three switch/delete/edit cases the issue pins as a regression
    net (issue #39 Testing Decision 6: registered so they cannot be deleted)."""
    presets = [{"id": "prompt_ab12cd34", "name": "Mine", "text": "Custom text."}]
    e = _engine(tmp_path, active="prompt_ab12cd34", presets=presets, tag="c")
    try:
        id_c, ns_c = _ident_ns(e)
        e.settings["prompt"]["presets"][0]["text"] = "Custom text!"  # one char
        id_c2, ns_c2 = _ident_ns(e)
        assert id_c2 != id_c, "editing the active custom text must fork the identity"
        assert ns_c2 != ns_c, "editing the active custom text must fork the namespace"
        # delete the active custom -> dialog falls back to default (#39 D5)
        e.settings["prompt"]["presets"] = []
        e.settings["prompt"]["active"] = "default"
        id_d, ns_d = _ident_ns(e)
        assert id_d != id_c2, "deleting the active custom must fork the identity"
        assert ns_d != ns_c2, "deleting the active custom must fork the namespace"
    finally:
        e._queue.shutdown()


def test_snapshot_carries_the_preset_to_the_wire(tmp_path):
    """The text that shaped the identity is the text put on the wire: the
    snapshot copies the active preset into prov['system'], the cfg key
    translate_group reads (before #39 the wire silently fell back to
    DEFAULT_SYSTEM_PROMPT while the identity used prompt.system - preview ==
    production was impossible)."""
    e = _engine(tmp_path, active="literal")
    try:
        prov, instr = e._provider_snapshot()
        assert instr == S.LITERAL_PROMPT_TEXT
        assert prov["system"] == instr, "identity text and wire text must match"
        assert P.build_instructions(prov["system"], "", "", 0) == instr
    finally:
        e._queue.shutdown()


# ---------------------------------------------------------------------------
# Testing Decision 2 - wire shape (client layer)
# ---------------------------------------------------------------------------

def _capture_wire(monkeypatch, cur, prev="", nxt="", expected_lines=0,
                  system="PRESET TEXT", protocol="chat-completions"):
    """Drive translate_group against a stubbed transport and return the
    (system, user) pair exactly as it would go on the wire."""
    seen = []

    def fake_post(url, headers, payload, timeout_s):
        seen.append(payload)
        body = chr(10).join(["1|ok", "2|ok"])
        return 200, {}, json.dumps({"choices": [{"message": {"content": body}}],
                                    "output_text": body})

    monkeypatch.setattr(P, "_do_post", fake_post)
    cfg = {"base_url": "https://api.example.test/v1", "api_key": "k",
           "model": "m", "protocol": protocol, "system": system}
    r = P.translate_group(cfg, cur, prev, nxt, expected_lines=expected_lines)
    assert r.get("error") is None, r
    payload = seen[-1]
    if protocol == "chat-completions":
        return payload["messages"][0]["content"], payload["messages"][1]["content"]
    return payload["instructions"], payload["input"][0]["content"][0]["text"]


NLINE_2 = ("The input is one sentence split into 2 subtitle lines. Translate "
           "the whole sentence, then output exactly 2 lines in format "
           "'N|translation' (N=1..2) matching the original line breaks. No "
           "other text.")
PREV_LINE = "Previous line (context only, do not translate): "
NEXT_LINE = "Next line (context only, do not translate): "


def test_wire_three_segment_order_all_four_combos(monkeypatch):
    """expected_lines 1/2 x context off/on: preset first, label lines in the
    middle, N|line instruction last, no stray blank lines, and the user
    message is always the pure current sentence. Protocol wording is pinned
    verbatim - it feeds the cache identity, so it must not drift."""
    cur, prev, nxt = "current sentence here", "previous neighbour", "next neighbour"

    # (expected_lines=1, context off) -> preset only
    sys1, user1 = _capture_wire(monkeypatch, cur, expected_lines=1)
    assert sys1 == "PRESET TEXT"
    assert user1 == cur

    # (expected_lines=1, context on) -> preset + two label lines, no N|line
    sys2, user2 = _capture_wire(monkeypatch, cur, prev, nxt, expected_lines=1)
    assert sys2 == ("PRESET TEXT" + chr(10) + PREV_LINE + prev + chr(10) +
                    NEXT_LINE + nxt)
    assert user2 == cur

    # (expected_lines=2, context off) -> preset + N|line instruction at the tail
    sys3, user3 = _capture_wire(monkeypatch, cur, expected_lines=2)
    assert sys3 == "PRESET TEXT" + chr(10) + NLINE_2
    assert user3 == cur

    # (expected_lines=2, context on) -> all three segments in order
    sys4, user4 = _capture_wire(monkeypatch, cur, prev, nxt, expected_lines=2)
    assert sys4 == ("PRESET TEXT" + chr(10) + PREV_LINE + prev + chr(10) +
                    NEXT_LINE + nxt + chr(10) + NLINE_2)
    assert user4 == cur

    for s in (sys1, sys2, sys3, sys4):
        assert s.startswith("PRESET TEXT"), "the preset must lead the system"
        assert "\n\n" not in s, "no stray blank lines in the assembled system"


def test_wire_same_shape_on_responses_protocol(monkeypatch):
    """The assembly is protocol-independent: the responses protocol carries
    the byte-identical system and user strings."""
    cur, prev = "current sentence here", "previous neighbour"
    sys_r, user_r = _capture_wire(monkeypatch, cur, prev, "", expected_lines=2,
                                  protocol="responses")
    sys_c, user_c = _capture_wire(monkeypatch, cur, prev, "", expected_lines=2)
    assert sys_r == sys_c
    assert user_r == user_c == cur


# ---------------------------------------------------------------------------
# Testing Decision 3 - migration (settings layer, table-driven)
# ---------------------------------------------------------------------------

def _write_legacy(tmp_path, prompt_node):
    p = str(tmp_path / "setting.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump({"prompt": prompt_node}, f, ensure_ascii=False)
    return p


def _read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def test_migration_custom_text_becomes_prompt_migrated(tmp_path):
    p = _write_legacy(tmp_path, {"system": "  My custom instructions.  ",
                                 "context_groups": 1})
    cfg = S.load(p)
    assert cfg["prompt"]["active"] == "prompt_migrated"
    assert cfg["prompt"]["presets"] == [
        {"id": "prompt_migrated", "name": "旧版自定义",
         "text": "My custom instructions."}]
    assert "system" not in cfg["prompt"], "no dual source in memory"
    on_disk = _read_json(p)
    assert "system" not in on_disk["prompt"], "legacy key removed from disk"
    # idempotent: a second load migrates nothing new
    cfg2 = S.load(p)
    assert cfg2 == cfg
    assert len(cfg2["prompt"]["presets"]) == 1


@pytest.mark.parametrize("legacy", ["", "   ", chr(10) + "  ", S.DEFAULT_PROMPT_TEXT])
def test_migration_blank_or_default_legacy_is_discarded(tmp_path, legacy):
    p = _write_legacy(tmp_path, {"system": legacy, "context_groups": 0})
    cfg = S.load(p)
    assert cfg["prompt"] == {"active": "default", "presets": [],
                             "context_groups": 0}
    assert "system" not in _read_json(p)["prompt"]
    assert S.load(p) == cfg  # idempotent


def test_migration_zero_without_legacy_key(tmp_path):
    p = _write_legacy(tmp_path, {"active": "natural", "presets": [],
                                 "context_groups": 0})
    before = open(p, encoding="utf-8").read()
    cfg = S.load(p)
    assert cfg["prompt"] == {"active": "natural", "presets": [],
                             "context_groups": 0}
    assert open(p, encoding="utf-8").read() == before, \
        "no legacy key -> zero migration, file untouched"


@pytest.mark.parametrize("bad, want_presets, want_active", [
    ("not-a-list", [], "default"),                      # not an array
    ([{"name": "no id", "text": "t"}], [], "default"),   # item missing id
    ([{"id": "prompt_x1"}], [], "default"),              # item missing text
    ([{"id": "prompt_ok", "text": "t"}, {"bad": 1}], [], "default"),  # one bad poisons all
    ([{"id": "prompt_ok", "text": "t"}], [{"id": "prompt_ok", "text": "t"}], "prompt_ok"),
])
def test_damaged_presets_array_falls_back(tmp_path, bad, want_presets, want_active):
    p = _write_legacy(tmp_path, {"presets": bad, "active": "prompt_ok"})
    cfg = S.load(p)
    assert cfg["prompt"]["presets"] == want_presets
    assert cfg["prompt"]["active"] == want_active


def test_active_pointing_at_missing_id_falls_back_to_default(tmp_path):
    p = _write_legacy(tmp_path, {"active": "prompt_ghost",
                                 "presets": [{"id": "prompt_ok", "text": "t"}]})
    cfg = S.load(p)
    assert cfg["prompt"]["active"] == "default"


def test_non_dict_prompt_node_resets_to_schema(tmp_path):
    p = _write_legacy(tmp_path, "garbage")
    cfg = S.load(p)
    assert cfg["prompt"] == {"active": "default", "presets": [],
                             "context_groups": 1}


def test_default_settings_ship_new_schema():
    pr = S.default_settings()["prompt"]
    assert pr == {"active": "default", "presets": [], "context_groups": 1}
    assert "system" not in pr
    # built-ins exist only in code, never on disk
    assert [b["id"] for b in S.BUILTIN_PROMPTS] == ["default", "literal", "natural"]
    assert S.active_prompt_text(S.default_settings()) == S.DEFAULT_PROMPT_TEXT


# ---------------------------------------------------------------------------
# Testing Decision 5 (non-UI half) - preview == production, ONE function
# ---------------------------------------------------------------------------

def test_production_goes_through_the_single_assembly_function(monkeypatch):
    """translate_group must call P.build_instructions (asserted via spy, not
    via comparing two constants), and for identical (preset, ctx,
    expected_lines) inputs the assembled system is byte-identical to what the
    preview path produces by calling the same function directly."""
    calls = []
    real = P.build_instructions

    def spy(*a, **k):
        out = real(*a, **k)
        calls.append((a, k, out))
        return out

    monkeypatch.setattr(P, "build_instructions", spy)

    args = ("PRESET X", "prev ctx", "next ctx", 2)
    preview_out = P.build_instructions(*args)
    wire_sys, wire_user = _capture_wire(monkeypatch, "the current sentence",
                                        prev="prev ctx", nxt="next ctx",
                                        expected_lines=2, system="PRESET X")
    assert preview_out == wire_sys, \
        "preview path and production must emit byte-identical systems"
    assert wire_user == "the current sentence"
    assert len(calls) >= 2, "both paths must have gone through build_instructions"
    assert all(c[2] == real(*c[0], **c[1]) for c in calls)
