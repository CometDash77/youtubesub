"""#39 / ADR-010 - SettingsDialog preset UI (Qt offscreen).

Covers Testing Decision 4: built-in lock states, copy -> rename -> delete
chain persistence shape, delete-active fallback, preview byte-identity with
the single assembly function, and the context_groups round-trip."""
import json, os, sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtWidgets

import app as app_mod
from app import SettingsDialog, PREVIEW_PREV_EXAMPLE, PREVIEW_NEXT_EXAMPLE
from suboverlay import provider as P
from suboverlay import settings as S

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])

PREV_LABEL = "Previous line (context only, do not translate): "
NEXT_LABEL = "Next line (context only, do not translate): "


def _save_spy(monkeypatch):
    """Capture what accept() would write instead of touching %APPDATA%."""
    box = {}

    def fake_save(cfg, path=None):
        box["cfg"] = json.loads(json.dumps(cfg, ensure_ascii=False))

    monkeypatch.setattr(S, "save", fake_save)
    return box


def _ids(d):
    return [d.preset.itemData(i) for i in range(d.preset.count())]


def test_builtin_selection_locks_editor_and_actions():
    d = SettingsDialog(S.default_settings())
    assert d.preset.currentData() == "default"
    assert d.system.isReadOnly(), "built-in text must be read-only"
    assert not d.rename_btn.isEnabled(), "built-ins cannot be renamed"
    assert not d.delete_btn.isEnabled(), "built-ins cannot be deleted"
    assert d.copy_btn.isEnabled(), "copy-as-custom is the one way past the lock"
    # every built-in behaves the same
    for pid, text in (("literal", S.LITERAL_PROMPT_TEXT),
                      ("natural", S.NATURAL_PROMPT_TEXT)):
        d.preset.setCurrentIndex(d.preset.findData(pid))
        assert d.system.isReadOnly()
        assert not d.rename_btn.isEnabled() and not d.delete_btn.isEnabled()
        assert d.system.toPlainText() == text
    # two groups are present: built-ins, then customs (empty but labelled)
    ids = _ids(d)
    assert ids[0] is None and ids[1:4] == ["default", "literal", "natural"]
    assert None in ids[4:], "a separator/header divides the two groups"


def test_group_header_click_snaps_selection_back():
    d = SettingsDialog(S.default_settings())
    header_idx = next(i for i in range(d.preset.count())
                      if d.preset.itemData(i) is None)
    d.preset.setCurrentIndex(header_idx)  # header carries no preset id
    assert d.preset.currentData() == "default", "selection must snap back"


def test_copy_rename_delete_chain_persists_the_right_shape(monkeypatch):
    saved = _save_spy(monkeypatch)
    monkeypatch.setattr(app_mod, "_ask_new_name",
                        lambda parent, initial: "我的提示")
    s = S.default_settings()
    d = SettingsDialog(s)

    # copy the built-in default -> new custom, selected, editable
    d.copy_btn.click()
    new_id = d.preset.currentData()
    assert new_id and new_id.startswith("prompt_") and len(new_id) == len("prompt_") + 8
    assert not d.system.isReadOnly()
    assert d.rename_btn.isEnabled() and d.delete_btn.isEnabled()
    custom = d._find_custom(new_id)
    assert custom["name"] == "Default 副本"
    assert custom["text"] == S.DEFAULT_PROMPT_TEXT

    # a second copy from the same built-in gets the ordinal suffix
    d.preset.setCurrentIndex(d.preset.findData("default"))
    d.copy_btn.click()
    assert [p["name"] for p in d._presets] == ["Default 副本", "Default 副本 2"]

    # rename the first copy
    d.preset.setCurrentIndex(d.preset.findData(new_id))
    d.rename_btn.click()
    assert d._find_custom(new_id)["name"] == "我的提示"
    assert d.preset.itemText(d.preset.findData(new_id)) == "我的提示"

    # edit the custom text - lands in the working copy immediately
    d.system.setPlainText("Edited custom text.")
    assert d._find_custom(new_id)["text"] == "Edited custom text."

    # nothing hit settings before OK (#4 semantics)
    assert "system" not in s["prompt"] or s["prompt"].get("active") == "default"
    assert s["prompt"]["presets"] == []
    assert not saved, "no write before accept()"

    # OK -> persisted shape
    d.preset.setCurrentIndex(d.preset.findData(new_id))
    d.accept()
    assert saved, "accept() must save"
    pr = saved["cfg"]["prompt"]
    assert "system" not in pr, "legacy key must never come back"
    assert pr["active"] == new_id
    assert len(pr["presets"]) == 2
    mine = next(p for p in pr["presets"] if p["id"] == new_id)
    assert mine == {"id": new_id, "name": "我的提示", "text": "Edited custom text."}


def test_delete_active_custom_falls_back_to_default(monkeypatch):
    saved = _save_spy(monkeypatch)
    s = S.default_settings()
    s["prompt"]["presets"] = [{"id": "prompt_deadbee", "name": "Doomed",
                               "text": "Doomed text."}]
    s["prompt"]["active"] = "prompt_deadbee"
    d = SettingsDialog(s)
    assert d.preset.currentData() == "prompt_deadbee"
    assert not d.system.isReadOnly()

    d.delete_btn.click()
    assert d.preset.currentData() == "default", \
        "deleting the active custom must fall back to default"
    assert d.system.isReadOnly(), "editor locked again on the built-in"
    assert d.system.toPlainText() == S.DEFAULT_PROMPT_TEXT
    assert d.preview.toPlainText() == P.build_instructions(
        S.DEFAULT_PROMPT_TEXT, PREVIEW_PREV_EXAMPLE, PREVIEW_NEXT_EXAMPLE, 0), \
        "preview must refresh immediately after the fallback"

    d.accept()
    assert saved["cfg"]["prompt"] == {"active": "default", "presets": [],
                                      "context_groups": 1}


def test_preview_is_byte_identical_to_the_production_assembly(monkeypatch):
    """The UI half of Testing Decision 5: the dialog preview and the system
    translate_group actually sends, for the same (preset, ctx, expected_lines)
    inputs, are byte-identical - and both come out of the SAME function object
    (asserted by identity, not by comparing two hard-coded constants)."""
    assert app_mod.P.build_instructions is P.build_instructions

    def fake_post(url, headers, payload, timeout_s):
        fake_post.seen = payload
        return 200, {}, json.dumps({"choices": [{"message": {"content": "ok"}}],
                                    "output_text": "ok"})

    monkeypatch.setattr(P, "_do_post", fake_post)

    s = S.default_settings()
    s["prompt"]["presets"] = [{"id": "prompt_11223344", "name": "Mine",
                               "text": "MY CUSTOM TASK"}]
    s["prompt"]["active"] = "prompt_11223344"
    d = SettingsDialog(s)
    assert d.context_groups.isChecked()  # default on

    preview_on = d.preview.toPlainText()
    assert preview_on == P.build_instructions(
        "MY CUSTOM TASK", PREVIEW_PREV_EXAMPLE, PREVIEW_NEXT_EXAMPLE, 0)
    assert PREV_LABEL in preview_on and NEXT_LABEL in preview_on

    # production, same inputs -> byte-identical system on the wire
    cfg = {"base_url": "https://api.example.test/v1", "api_key": "k",
           "model": "m", "protocol": "chat-completions",
           "system": "MY CUSTOM TASK"}
    P.translate_group(cfg, "a sentence", PREVIEW_PREV_EXAMPLE,
                      PREVIEW_NEXT_EXAMPLE, expected_lines=0)
    wire_system = fake_post.seen["messages"][0]["content"]
    assert wire_system == preview_on, \
        "preview and production must emit byte-identical systems"
    assert fake_post.seen["messages"][1]["content"] == "a sentence"

    # switch state is visible in the preview
    d.context_groups.setChecked(False)
    preview_off = d.preview.toPlainText()
    assert preview_off == P.build_instructions("MY CUSTOM TASK", "", "", 0)
    assert PREV_LABEL not in preview_off
    assert preview_off != preview_on


def test_context_groups_checkbox_round_trip(monkeypatch):
    saved = _save_spy(monkeypatch)
    d = SettingsDialog(S.default_settings())
    assert d.context_groups.isChecked()  # default truthy

    d.context_groups.setChecked(False)
    d.accept()
    assert saved["cfg"]["prompt"]["context_groups"] == 0

    d2 = SettingsDialog(saved["cfg"])
    assert not d2.context_groups.isChecked()
    d2.context_groups.setChecked(True)
    d2.accept()
    assert saved["cfg"]["prompt"]["context_groups"] == 1


def test_edits_only_persist_on_ok(monkeypatch):
    saved = _save_spy(monkeypatch)
    s = S.default_settings()
    d = SettingsDialog(s)
    d.copy_btn.click()
    d.system.setPlainText("Unsaved draft.")
    assert s["prompt"]["presets"] == [], \
        "Cancel must discard: settings untouched before accept()"
    assert not saved
    d.reject()
    assert not saved, "reject() must never write"
