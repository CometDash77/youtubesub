"""#39 / ADR-010 - SettingsDialog preset UI (Qt offscreen).

Covers Testing Decision 4: built-in lock states, copy -> rename -> delete
chain persistence shape, delete-active fallback, preview byte-identity with
the single assembly function, and the context_groups round-trip."""
import json, os, sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtWidgets

import app as app_mod
from app import App, SettingsDialog, PREVIEW_PREV_EXAMPLE, PREVIEW_NEXT_EXAMPLE
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


def test_settings_surface_uses_the_approved_chinese_copy(monkeypatch):
    d = SettingsDialog(S.default_settings())
    assert d.windowTitle() == "AI 翻译设置"
    assert d.copy_btn.text() == "复制为自定义"
    assert d.rename_btn.text() == "重命名"
    assert d.delete_btn.text() == "删除"
    assert d.test_btn.text() == "测试连接"
    assert d.cancel_btn.text() == "取消测试"
    assert d.context_groups.text() == "携带上下文（前/后分组）"
    assert d.mock.text() == "Mock 模式（不调用真实 API）"
    assert [d.preset.itemText(i) for i in range(d.preset.count())
            if d.preset.itemData(i) is None and d.preset.itemText(i)] == [
                "——— 内置 ———", "——— 我的预设 ———"]

    labels = {d.layout().labelForField(field).text()
              for field in (d.base_url, d.api_key, d.model, d.protocol,
                            d.preset, d.system, d.preview, d.font_size,
                            d.progress, d.report_view)}
    assert {"Base URL", "API Key", "模型", "协议", "提示词预设", "提示词内容",
            "生效预览", "字号", "测试进度", "测试报告"} <= labels
    buttons = d.findChild(QtWidgets.QDialogButtonBox).buttons()
    assert {button.text() for button in buttons} == {"确定", "取消"}

    captured = {}
    def accept_dialog(dialog):
        captured.update(title=dialog.windowTitle(), label=dialog.labelText(),
                        ok=dialog.okButtonText(), cancel=dialog.cancelButtonText())
        dialog.setTextValue(" x ")
        return QtWidgets.QDialog.Accepted

    monkeypatch.setattr(QtWidgets.QInputDialog, "exec", accept_dialog)
    assert app_mod._ask_new_name(d, "initial") == "x"
    assert captured == {"title": "重命名预设", "label": "名称：",
                        "ok": "确定", "cancel": "取消"}


def test_tray_settings_action_is_chinese(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    instance = App()
    try:
        menu = instance._menu()
        assert "设置……" in [action.text() for action in menu.actions()]
    finally:
        instance.engine._queue.shutdown()


def test_report_localizes_human_labels_but_preserves_machine_and_sample_values():
    d = SettingsDialog(S.default_settings())
    d._render_report({
        "verdict": "mock", "layers": [{"id": "L4", "passed": None,
            "code": None, "title": "翻译可用", "message": "已跳过",
            "elapsed_ms": 0}],
        "skipped": ["step1", "step2"], "attempts": 0,
        "sample": {"source": "The cat sat on the mat.", "translation": "猫坐在垫子上"},
        "model_list": {"observed": True, "total": 2, "contains_model": False},
        "warnings": ["MOCK_MASKS_REAL_CONFIG", "FUTURE_WARNING"],
        "warning_messages": {"MOCK_MASKS_REAL_CONFIG": "当前为 Mock 模式；已填写的真实配置本次不会被使用。"},
        "notes": ["尚未验证 Alignment（N|line）协议；本次探测仅使用整行模式。"],
        "snapshot": {"base_url": "https://example.test/v1", "model": "gpt-test"},
        "quota_notice": "Mock 模式：未发送网络请求，也未消耗额度。",
    })
    text = d.report_view.toPlainText()
    assert "结论：MOCK" in text and "-- L4 翻译可用 - 已跳过 (0 毫秒)" in text
    assert "跳过：step1, step2" in text and "尝试次数：0" in text
    assert "原文：The cat sat on the mat." in text
    assert "译文：猫坐在垫子上" in text
    assert "模型列表：2（包含所配模型：否）" in text
    assert "警告：当前为 Mock 模式；已填写的真实配置本次不会被使用。" in text
    assert "警告：FUTURE_WARNING" in text
    assert "备注：尚未验证 Alignment（N|line）协议" in text
    assert "基于点击时的输入（base_url=https://example.test/v1，model=gpt-test）；未写入任何配置文件。" in text
    assert "Mock 模式：未发送网络请求，也未消耗额度。" in text
    assert "Warning: MOCK_MASKS_REAL_CONFIG" not in text
    for value, expected in ((True, "是"), (None, "未知")):
        report = {"model_list": {"observed": True, "total": 2,
                                 "contains_model": value}}
        d._render_report(report)
        assert "模型列表：2（包含所配模型：%s）" % expected in d.report_view.toPlainText()


def test_connection_test_progress_copy_is_chinese():
    class Tester:
        def __init__(self):
            self.cancelled = False

        def last_report(self):
            return None

        def start(self, snapshot, on_done):
            return True

        def progress(self):
            return {"running": True, "step": 2, "elapsed_s": 1.25}

        def cancel(self):
            self.cancelled = True

    tester = Tester()
    d = SettingsDialog(S.default_settings(), tester=tester)
    d._start_connection_test()
    assert d.progress.text() == "启动中……"
    d._poll_progress()
    assert d.progress.text() == "第 2/2 步 - 1.2 秒"
    d._cancel_connection_test()
    assert tester.cancelled
    assert d.progress.text() == "已取消——进行中的请求仍会继续执行，其额度不退还"


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

    # delete the OTHER copy (not the persisted active) - chain step
    other_id = next(p["id"] for p in d._presets if p["id"] != new_id)
    d.preset.setCurrentIndex(d.preset.findData(other_id))
    assert d.delete_btn.isEnabled()
    d.delete_btn.click()
    assert [p["id"] for p in d._presets] == [new_id]
    assert d.preset.currentData() == "default", \
        "deleting a non-active preset returns to the active choice the dialog opened with"

    # OK -> persisted shape
    d.preset.setCurrentIndex(d.preset.findData(new_id))
    d.accept()
    assert saved, "accept() must save"
    pr = saved["cfg"]["prompt"]
    assert "system" not in pr, "legacy key must never come back"
    assert pr["active"] == new_id
    assert len(pr["presets"]) == 1, "the deleted copy must not be persisted"
    mine = pr["presets"][0]
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
