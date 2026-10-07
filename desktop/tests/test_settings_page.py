"""设置页（#39 / ADR-010 的预设模型 + 地图 #164 / 落地票 #170 的窗口吸收）。

原来测的是模态 `SettingsDialog`：本页把它整份搬进三页窗口后，页脚「保存 / 取消」
归窗口级，所以断言改成两条线 —— 控件文案/预设模型仍按外部行为断言，落盘则走
`page.apply()` + `page.snapshot()`，不再有 `accept()`。
"""
import json, os, sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PySide6 import QtWidgets

import suboverlay.settings_page as page_mod
from suboverlay import provider as P
from suboverlay import settings as S
from suboverlay.settings_page import (PREVIEW_NEXT_EXAMPLE, PREVIEW_PREV_EXAMPLE,
                                      SettingsPage)

_QAPP = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])

PREV_LABEL = "Previous line (context only, do not translate): "
NEXT_LABEL = "Next line (context only, do not translate): "


def _page(settings=None, tester=None):
    return SettingsPage(settings if settings is not None else S.default_settings(),
                        tester=tester)


def _ids(d):
    return [d.preset.itemData(i) for i in range(d.preset.count())]


def test_settings_surface_uses_the_approved_chinese_copy(monkeypatch):
    d = _page()
    assert d.copy_btn.text() == "复制为自定义"
    assert d.rename_btn.text() == "重命名"
    assert d.delete_btn.text() == "删除"
    assert d.test_btn.text() == "测试连接"
    assert d.cancel_btn.text() == "取消测试"
    assert d.context_groups.text().startswith("携带上下文")
    assert d.mock.text().startswith("Mock 模式")
    assert [d.preset.itemText(i) for i in range(d.preset.count())
            if d.preset.itemData(i) is None and d.preset.itemText(i)] == [
                "——— 内置 ———", "——— 我的预设 ———"]
    # 内置预设名也过一遍「说人话」：不再是 Default / Literal / Natural。
    assert [d.preset.itemText(i) for i in range(d.preset.count())
            if d.preset.itemData(i) in ("default", "literal", "natural")] == [
                "标准", "直译", "口语"]

    # 每个可编辑项都要有「一句改了会发生什么」（地图 #164 的判据）。
    labels = {label.text() for label in d.findChildren(QtWidgets.QLabel)}
    for wanted in ("接口地址", "密钥", "模型名", "接口协议", "用哪套提示词",
                   "提示词内容", "实际发出去的提示词", "测试进度", "测试报告"):
        assert wanted in labels, sorted(labels)
    hints = [label.text() for label in d.findChildren(QtWidgets.QLabel)
             if label.objectName() == "debugHint" and label.text()]
    assert len(hints) >= 8, hints
    assert all(len(text) >= 8 for text in hints), hints
    assert not any("seek" in text or "帧" in text for text in hints), hints

    captured = {}
    def accept_dialog(dialog):
        captured.update(title=dialog.windowTitle(), label=dialog.labelText(),
                        ok=dialog.okButtonText(), cancel=dialog.cancelButtonText())
        dialog.setTextValue(" x ")
        return QtWidgets.QDialog.Accepted

    monkeypatch.setattr(QtWidgets.QInputDialog, "exec", accept_dialog)
    assert page_mod._ask_new_name(d, "initial") == "x"
    assert captured == {"title": "重命名预设", "label": "名称：",
                        "ok": "确定", "cancel": "取消"}


def test_report_localizes_human_labels_but_preserves_machine_and_sample_values():
    d = _page()
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
    d = _page(tester=tester)
    d._start_connection_test()
    assert d.progress.text() == "启动中……"
    d._poll_progress()
    assert d.progress.text() == "第 2/2 步 - 1.2 秒"
    d._cancel_connection_test()
    assert tester.cancelled
    assert d.progress.text() == "已取消——进行中的请求仍会继续执行，其额度不退还"
    # 关窗清理走同一条路（#23 决策 19：窗口关掉就放弃进行中的运行）。
    tester.cancelled = False
    d.cancel_test()
    assert tester.cancelled


def test_builtin_selection_locks_editor_and_actions():
    d = _page()
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
    d = _page()
    header_idx = next(i for i in range(d.preset.count())
                      if d.preset.itemData(i) is None)
    d.preset.setCurrentIndex(header_idx)  # header carries no preset id
    assert d.preset.currentData() == "default", "selection must snap back"


def test_copy_rename_delete_chain_applies_the_right_shape(monkeypatch):
    monkeypatch.setattr(page_mod, "_ask_new_name",
                        lambda parent, initial: "我的提示")
    s = S.default_settings()
    d = _page(s)

    # copy the built-in default -> new custom, selected, editable
    d.copy_btn.click()
    new_id = d.preset.currentData()
    assert new_id and new_id.startswith("prompt_") and len(new_id) == len("prompt_") + 8
    assert not d.system.isReadOnly()
    assert d.rename_btn.isEnabled() and d.delete_btn.isEnabled()
    custom = d._find_custom(new_id)
    assert custom["name"] == "标准 副本"
    assert custom["text"] == S.DEFAULT_PROMPT_TEXT

    # a second copy from the same built-in gets the ordinal suffix
    d.preset.setCurrentIndex(d.preset.findData("default"))
    d.copy_btn.click()
    assert [p["name"] for p in d._presets] == ["标准 副本", "标准 副本 2"]

    # rename the first copy
    d.preset.setCurrentIndex(d.preset.findData(new_id))
    d.rename_btn.click()
    assert d._find_custom(new_id)["name"] == "我的提示"
    assert d.preset.itemText(d.preset.findData(new_id)) == "我的提示"

    # edit the custom text - lands in the working copy immediately
    d.system.setPlainText("Edited custom text.")
    assert d._find_custom(new_id)["text"] == "Edited custom text."

    # nothing hit settings before apply()（编辑期间不碰引擎正在读的那份 dict）
    assert "system" not in s["prompt"] or s["prompt"].get("active") == "default"
    assert s["prompt"]["presets"] == []

    # delete the OTHER copy (not the persisted active) - chain step
    other_id = next(p["id"] for p in d._presets if p["id"] != new_id)
    d.preset.setCurrentIndex(d.preset.findData(other_id))
    assert d.delete_btn.isEnabled()
    d.delete_btn.click()
    assert [p["id"] for p in d._presets] == [new_id]
    assert d.preset.currentData() == "default", \
        "deleting a non-active preset returns to the active choice the page opened with"

    # apply -> persisted shape
    d.preset.setCurrentIndex(d.preset.findData(new_id))
    assert d.apply(), "apply() must report the fields it wrote"
    pr = s["prompt"]
    assert "system" not in pr, "legacy key must never come back"
    assert pr["active"] == new_id
    assert len(pr["presets"]) == 1, "the deleted copy must not be persisted"
    mine = pr["presets"][0]
    assert mine == {"id": new_id, "name": "我的提示", "text": "Edited custom text."}


def test_delete_active_custom_falls_back_to_default():
    s = S.default_settings()
    s["prompt"]["presets"] = [{"id": "prompt_deadbee", "name": "Doomed",
                               "text": "Doomed text."}]
    s["prompt"]["active"] = "prompt_deadbee"
    d = _page(s)
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

    d.apply()
    assert s["prompt"] == {"active": "default", "presets": [],
                           "context_groups": 1}


def test_preview_is_byte_identical_to_the_production_assembly(monkeypatch):
    """The UI half of Testing Decision 5: the page preview and the system
    translate_group actually sends, for the same (preset, ctx, expected_lines)
    inputs, are byte-identical - and both come out of the SAME function object
    (asserted by identity, not by comparing two hard-coded constants)."""
    assert page_mod.P.build_instructions is P.build_instructions

    def fake_post(url, headers, payload, timeout_s):
        fake_post.seen = payload
        return 200, {}, json.dumps({"choices": [{"message": {"content": "ok"}}],
                                    "output_text": "ok"})

    monkeypatch.setattr(P, "_do_post", fake_post)

    s = S.default_settings()
    s["prompt"]["presets"] = [{"id": "prompt_11223344", "name": "Mine",
                               "text": "MY CUSTOM TASK"}]
    s["prompt"]["active"] = "prompt_11223344"
    d = _page(s)
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


def test_context_groups_checkbox_round_trip():
    d = _page()
    assert d.context_groups.isChecked()  # default truthy

    d.context_groups.setChecked(False)
    d.apply()
    assert d.settings["prompt"]["context_groups"] == 0

    d2 = _page(d.settings)
    assert not d2.context_groups.isChecked()
    d2.context_groups.setChecked(True)
    d2.apply()
    assert d2.settings["prompt"]["context_groups"] == 1


def test_edits_stay_out_of_settings_until_apply():
    s = S.default_settings()
    d = _page(s)
    d.copy_btn.click()
    d.system.setPlainText("Unsaved draft.")
    assert s["prompt"]["presets"] == [], \
        "编辑期间不许碰那份 settings：引擎正在读它"
    d.snapshot()
    assert d.preset.currentData() == "default", "取消 = 回到盘上的活动预设"
    assert d.is_dirty() is False


def test_dirty_counts_only_the_fields_that_would_be_written():
    s = S.default_settings()
    s["prompt"]["presets"] = [{"id": "prompt_aabbccdd", "name": "Mine",
                               "text": "MINE"}]
    d = _page(s)
    assert d.is_dirty() is False and d.count_dirty() == 0

    # 改一个字段 -> 恰好 1 项；改回原值 -> 又不脏（值相等不算脏，不用 dirty flag）
    d.model.setText("gpt-test")
    assert d.count_dirty() == 1
    d.model.setText("")
    assert d.is_dirty() is False

    # 活动预设改走再改回：同样不算脏
    d.preset.setCurrentIndex(d.preset.findData("prompt_aabbccdd"))
    assert d.is_dirty() is True
    d.preset.setCurrentIndex(d.preset.findData("default"))
    assert d.is_dirty() is False

    # 预设改个名字再改回：规范化比较（json 指纹）之后不该再算脏
    d.preset.setCurrentIndex(d.preset.findData("prompt_aabbccdd"))
    d._presets[0]["name"] = "Renamed"
    assert d.count_dirty() == 2, "活动预设 + 预设名字各算一项"
    d._presets[0]["name"] = "Mine"
    assert d.count_dirty() == 1, "名字改回来之后只剩「活动预设变了」这一项"
    d.preset.setCurrentIndex(d.preset.findData("default"))
    assert d.is_dirty() is False

    # 勾一下 Mock 与上下文：各算一项
    d.mock.setChecked(True)
    d.context_groups.setChecked(False)
    assert d.count_dirty() == 2
    d.mock.setChecked(False)
    d.context_groups.setChecked(True)
    assert d.count_dirty() == 0


def test_snapshot_rolls_every_control_back_to_the_settings_dict():
    s = S.default_settings()
    s["provider"]["api_key"] = "sk-on-disk"
    d = _page(s)
    d.base_url.setText("https://elsewhere.test/v1")
    d.api_key.setText("sk-typo")
    d.protocol.setCurrentText("responses")
    d.mock.setChecked(True)
    d.context_groups.setChecked(False)
    assert d.count_dirty() == 5

    d.cancel()
    assert d.is_dirty() is False
    assert d.base_url.text() == ""
    assert d.api_key.text() == "sk-on-disk", "密钥要回滚到那份 settings 里的值"
    assert d.protocol.currentText() == "auto"
    assert d.mock.isChecked() is False
    assert d.context_groups.isChecked() is True
