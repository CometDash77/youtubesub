"""设置页：凭据、提示词与连接测试（地图 #164 / 落地票 #170）。

从原来的模态对话框 `SettingsDialog` 原样搬来，只换承载体：现在是三页窗口
（`debug_window.DebugWindow`）的第一页，页脚「保存 / 取消」在窗口级，本页只负责
自己那 8 个字段的收集、回滚与套用，并回答「有没有改过」。

**为什么本页不用 `settings.apply_edits`**：那张权威表只认 `TUNING_FIELDS` 里的键，
表外的 `provider.*` / `prompt.*` 会 raise（`desktop/suboverlay/settings.py:221-223`），
所以本页自建快照，比较对象恰好是它写通道的那 8 个字段（`presets` 用 json 规范化后
比较）。窗口级的「有 N 项改动没保存」= 本页 + 调参页两边计数相加。

编辑期间**不碰** `self.settings`（引擎正在读那份 dict）：改动只活在控件与
`self._presets` 工作副本里，只有「保存」时 `apply()` 才写进去。
"""
import json, uuid

from PySide6 import QtCore, QtWidgets

from qfluentwidgets import BodyLabel, PushButton, PrimaryPushButton

from . import debug_tokens as TOKENS
from . import provider as P
from . import settings as S

# 预览里的邻居用示例文本：真正发出去时这里会是上一句 / 下一句，窗口里看不到
# 真实上下文，所以用这两个占位把「携带上下文」开关的效果演示出来（#39 决策 5）。
PREVIEW_PREV_EXAMPLE = "(previous group)"
PREVIEW_NEXT_EXAMPLE = "(next group)"

# 卡片标题与每项的一句说明（判据：没用过的人不看文档也能说出改了会发生什么）。
CARD_CREDENTIALS = "接口凭据（服务商给你的那几项）"
CARD_PROMPT = "提示词（决定翻译的风格）"
CARD_TEST = "测试连接（用上面这些还没保存的输入试一次）"


def _ask_new_name(parent, initial):
    """重命名预设。模块级接缝：offscreen 测试可以直接 stub 掉这个模态输入框。"""
    dialog = QtWidgets.QInputDialog(parent)
    dialog.setInputMode(QtWidgets.QInputDialog.TextInput)
    dialog.setWindowTitle("重命名预设")
    dialog.setLabelText("名称：")
    dialog.setTextValue(initial)
    dialog.setOkButtonText("确定")
    dialog.setCancelButtonText("取消")
    if dialog.exec() != QtWidgets.QDialog.Accepted:
        return ""
    return dialog.textValue().strip()


class SettingsPage(QtWidgets.QWidget):
    """凭据 / 提示词 / 连接测试（#39 / ADR-010 的预设模型原样保留）。"""

    # 把跑完的连接测试从工作线程搬到 GUI 线程：Qt 会把这次 emit 排队给槽。
    report_ready = QtCore.Signal(object)
    # 任何一次编辑都通知窗口刷新页脚（「保存」的可用态与那行提示）。
    changed = QtCore.Signal()

    # 本页写通道恰好是这 8 个字段，`is_dirty()` 的比较对象用同一份定义。
    STATE_KEYS = ("base_url", "api_key", "model", "protocol", "mock",
                  "active", "presets", "context_groups")

    def __init__(self, settings, tester=None, parent=None):
        super().__init__(parent)
        self.setObjectName("debugSettingsPage")
        self.tester = tester
        self.settings = settings
        prov = settings["provider"]
        prompt = settings["prompt"]
        self._presets = [dict(p) for p in prompt.get("presets", [])]  # 工作副本
        self._active = prompt.get("active") or "default"
        if self._find_custom(self._active) is None and not any(
                b["id"] == self._active for b in S.BUILTIN_PROMPTS):
            self._active = "default"
        # 打开时的活动预设。删掉「非活动」预设要落回这里，而不是 default —— 只有
        # 删掉「活动的那条自定义」才落回 default（#39 D5）。
        self._persisted_active = self._active
        self._build()
        self._baseline = self.state()

    # ---- 窗口页脚要的三件事：脏没脏、计数、套用 ----

    def state(self):
        """本页写通道上 8 个字段的当前值（控件 + 预设工作副本）。"""
        return {
            "base_url": self.base_url.text().strip(),
            "api_key": self.api_key.text(),
            "model": self.model.text().strip(),
            "protocol": self.protocol.currentText(),
            "mock": bool(self.mock.isChecked()),
            "active": self._normalized_active(),
            "presets": self._preset_fingerprints(),
            "context_groups": bool(self.context_groups.isChecked()),
        }

    def count_dirty(self):
        """还没落盘的字段数（页脚那行「有 N 项改动没保存」）。"""
        now = self.state()
        return sum(1 for key in self.STATE_KEYS if now[key] != self._baseline[key])

    def is_dirty(self):
        return self.count_dirty() > 0

    def apply(self):
        """把本页改动写进那份 settings（不写盘）；返回被改的字段名。"""
        changed = [key for key in self.STATE_KEYS if self.state()[key] != self._baseline[key]]
        if not changed:
            return []
        prov = self.settings["provider"]
        prov["base_url"] = self.base_url.text().strip()
        prov["api_key"] = self.api_key.text()
        prov["model"] = self.model.text().strip()
        prov["protocol"] = self.protocol.currentText()
        prov["mock"] = self.mock.isChecked()
        # 单向 schema（#39）：legacy 的 "system" 键永远不写回。
        self.settings["prompt"] = {
            "active": self._normalized_active(),
            "presets": [dict(p) for p in self._presets],
            "context_groups": 1 if self.context_groups.isChecked() else 0,
        }
        return changed

    def snapshot(self):
        """重新取基线，并把控件按那份 settings 落回（打开窗口 / 保存成功 / 取消后）。"""
        prompt = self.settings["prompt"]
        prov = self.settings["provider"]
        self.base_url.setText(prov.get("base_url", ""))
        self.api_key.setText(prov.get("api_key", ""))
        self.model.setText(prov.get("model", ""))
        self.protocol.setCurrentText(prov.get("protocol", "auto"))
        self.mock.setChecked(bool(prov.get("mock")))
        self.context_groups.setChecked(bool(prompt.get("context_groups", 1)))
        self._presets = [dict(p) for p in prompt.get("presets", [])]
        self._active = prompt.get("active") or "default"
        if self._find_custom(self._active) is None and not any(
                b["id"] == self._active for b in S.BUILTIN_PROMPTS):
            self._active = "default"
        self._persisted_active = self._active
        self._rebuild_preset_combo()
        self._load_active_into_editor()
        self._refresh_preview()
        self._baseline = self.state()

    def cancel(self):
        """丢弃本页未落盘的编辑（回到那份 settings 的当前值）。"""
        self.snapshot()

    def cancel_test(self):
        """关窗清理：放弃进行中的测试（#23 决策 19）。幂等。"""
        if self.tester is not None:
            self.tester.cancel()
        self._poll.stop()

    def _on_edited(self, *_):
        """任何一次编辑都要通知窗口刷新页脚（「保存」的可用态与计数）。"""
        self.changed.emit()

    # ---- 预设工作集（#39 / ADR-010） ----

    def _normalized_active(self):
        active = self._current_id() or "default"
        if not self._is_builtin(active) and self._find_custom(active) is None:
            active = "default"
        return active

    def _preset_fingerprints(self):
        return sorted(json.dumps(p, sort_keys=True, ensure_ascii=False)
                      for p in self._presets)

    def _find_custom(self, pid):
        for p in self._presets:
            if p.get("id") == pid:
                return p
        return None

    def _rebuild_preset_combo(self):
        """两组：内置在前（不可改），自定义在后。选中项落回当前活动 id。"""
        keep = self._active
        self.preset.blockSignals(True)
        self.preset.clear()
        self.preset.addItem("——— 内置 ———", None)
        for b in S.BUILTIN_PROMPTS:
            self.preset.addItem(b["name"], b["id"])
        self.preset.insertSeparator(self.preset.count())
        self.preset.addItem("——— 我的预设 ———", None)
        for p in self._presets:
            self.preset.addItem(p.get("name") or p["id"], p["id"])
        idx = self.preset.findData(keep)
        self.preset.setCurrentIndex(idx if idx >= 0 else self.preset.findData("default"))
        self.preset.blockSignals(False)
        self._sync_buttons()

    def _current_id(self):
        return self.preset.currentData()

    def _is_builtin(self, pid=None):
        pid = self._current_id() if pid is None else pid
        return any(b["id"] == pid for b in S.BUILTIN_PROMPTS)

    def _sync_buttons(self):
        builtin = self._is_builtin()
        self.rename_btn.setEnabled(not builtin)
        self.delete_btn.setEnabled(not builtin)
        self.system.setReadOnly(builtin)

    def _active_text(self):
        pid = self._current_id()
        if self._is_builtin(pid):
            for b in S.BUILTIN_PROMPTS:
                if b["id"] == pid:
                    return b["text"]
        custom = self._find_custom(pid)
        return custom["text"] if custom else S.DEFAULT_PROMPT_TEXT

    def _load_active_into_editor(self):
        self.system.blockSignals(True)
        self.system.setPlainText(self._active_text())
        self.system.blockSignals(False)
        self._sync_buttons()

    def _on_preset_changed(self, *_):
        pid = self._current_id()
        if pid is None:
            # 点了分组标题或分隔线：它们不携带预设 id，把选中项弹回真实选择。
            idx = self.preset.findData(self._active)
            if idx >= 0:
                self.preset.blockSignals(True)
                self.preset.setCurrentIndex(idx)
                self.preset.blockSignals(False)
            return
        self._active = pid
        self._load_active_into_editor()
        self._refresh_preview()

    def _on_text_edited(self, *_):
        # 只有自定义预设能改，内置的是只读的。
        if not self._is_builtin():
            custom = self._find_custom(self._current_id())
            if custom is not None:
                custom["text"] = self.system.toPlainText()
        self._refresh_preview()

    def _unique_copy_name(self, base):
        name = base + " \u526f\u672c"   # 副本 - 命名由 #39 固定
        n = 2
        existing = {p.get("name") for p in self._presets}
        while name in existing:
            name = "%s \u526f\u672c %d" % (base, n)
            n += 1
        return name

    def _copy_preset(self):
        """把选中的预设（内置或自定义）复制成一条新的自定义预设并选中它 ——
        这是改内置预设的唯一途径（#39 / ADR-010）。"""
        pid = self._current_id()
        text = self.system.toPlainText()  # 含还没保存的编辑
        base = pid
        for b in S.BUILTIN_PROMPTS:
            if b["id"] == pid:
                base = b["name"]
                break
        else:
            custom = self._find_custom(pid)
            base = (custom.get("name") if custom else pid) or pid
        new_id = "prompt_" + uuid.uuid4().hex[:8]
        self._presets.append({"id": new_id,
                              "name": self._unique_copy_name(base),
                              "text": text})
        self._active = new_id
        self._rebuild_preset_combo()
        self._load_active_into_editor()
        self._refresh_preview()
        self.changed.emit()

    def _rename_preset(self):
        if self._is_builtin():
            return
        custom = self._find_custom(self._current_id())
        if custom is None:
            return
        name = _ask_new_name(self, custom.get("name", ""))
        if name:
            custom["name"] = name
            self._rebuild_preset_combo()
            self._refresh_preview()
            self.changed.emit()

    def _delete_preset(self):
        if self._is_builtin():
            return
        pid = self._current_id()
        self._presets = [p for p in self._presets if p.get("id") != pid]

        def _known(x):
            return any(b["id"] == x for b in S.BUILTIN_PROMPTS) or \
                self._find_custom(x) is not None

        if pid != self._persisted_active and _known(self._persisted_active):
            # 删的是「非活动」预设：选中项回到打开时的活动预设 —— 清理杂物不该
            # 顺手把活动预设换掉。
            self._active = self._persisted_active
        else:
            # 删掉「活动的那条自定义」时落回内置默认 —— 用户永远不该落到
            # 「没有提示词」的空状态（#39 D5）。
            self._active = "default"
        self._rebuild_preset_combo()
        self._load_active_into_editor()
        self._refresh_preview()
        self.changed.emit()

    def _refresh_preview(self, *_):
        """只读的生效预览：由生产环境同一个拼装函数生成（#39 测试决策 5 ——
        预览 == 生产，一个函数，不是两份常量）。窗口里看不到真实上下文，所以
        开关打开时用示例文本演示那两行上下文标签。"""
        on = self.context_groups.isChecked()
        self.preview.setPlainText(
            P.build_instructions(self._active_text(),
                                 PREVIEW_PREV_EXAMPLE if on else "",
                                 PREVIEW_NEXT_EXAMPLE if on else "",
                                 0))
        self.changed.emit()

    # ---- 连接测试（#23） ----

    def _start_connection_test(self):
        # 快照语义（#23）：跑的是点这一下时控件里的输入；不落盘、也不自动触发。
        if self.tester is None:
            return
        snap = {"base_url": self.base_url.text().strip(),
                "api_key": self.api_key.text(),
                "model": self.model.text().strip(),
                "protocol": self.protocol.currentText(),
                "system": self.system.toPlainText(),
                "mock": self.mock.isChecked()}
        if not self.tester.start(snap, on_done=self.report_ready.emit):
            return  # 单飞：已经有一次在跑
        self.test_btn.setEnabled(False)
        self.cancel_btn.setEnabled(True)
        self.progress.setText("启动中……")
        self._poll.start()

    def _cancel_connection_test(self):
        # 取消 = 只是不再等：HTTP 请求不会被打断，额度也不退 —— 这么说，而不是
        # 暗示发生了什么回滚。
        if self.tester is None:
            return
        self.tester.cancel()
        self._poll.stop()
        self.test_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        self.progress.setText(
            "已取消——进行中的请求仍会继续执行，其额度不退还")

    def _poll_progress(self):
        p = self.tester.progress()
        if p["running"]:
            step = max(1, min(2, int(p["step"] or 1)))
            self.progress.setText("第 %d/2 步 - %.1f 秒" % (step, p["elapsed_s"]))
        else:
            self._poll.stop()

    def _show_report(self, report):
        self._poll.stop()
        self.test_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        self.progress.setText("已完成，用时 %s 毫秒" % report.get("duration_ms", 0))
        self._render_report(report)

    def _render_report(self, report):
        """把机器字段翻成人看的标签，同时原样保留报告里的值。"""
        lines = ["结论：" + str(report.get("verdict", "")).upper()]
        for lay in report.get("layers", []):
            passed = lay.get("passed")
            mark = "PASS" if passed is True else ("FAIL" if passed is False else "--")
            code = (" [" + lay["code"] + "]") if lay.get("code") else ""
            lines.append("%s %s %s%s - %s (%s 毫秒)"
                         % (mark, lay.get("id", ""), lay.get("title", ""), code,
                            lay.get("message", ""), lay.get("elapsed_ms", 0)))
        if report.get("skipped"):
            lines.append("跳过：" + ", ".join(report["skipped"]))
        lines.append("尝试次数：%s" % report.get("attempts", 0))
        sample = report.get("sample") or {}
        lines.append("原文：" + str(sample.get("source", "")))
        lines.append("译文：" + (str(sample.get("translation"))
                                if sample.get("translation") else "（无）"))
        ml = report.get("model_list") or {}
        if ml.get("observed"):
            contains = {True: "是", False: "否", None: "未知"}.get(
                ml.get("contains_model"), "未知")
            lines.append("模型列表：%s（包含所配模型：%s）"
                         % (ml.get("total", 0), contains))
        warning_messages = report.get("warning_messages") or {}
        for w in report.get("warnings", []):
            lines.append("警告：" + str(warning_messages.get(w, w)))
        for n in report.get("notes", []):
            lines.append("备注：" + str(n))
        snap = report.get("snapshot") or {}
        lines.append("基于点击时的输入（base_url=%s，model=%s）；未写入任何配置文件。"
                     % (snap.get("base_url", ""), snap.get("model", "")))
        lines.append(str(report.get("quota_notice", "")))
        self.report_view.setPlainText(chr(10).join(lines))

    # ---- 装配 ----

    def _build(self):
        column = QtWidgets.QVBoxLayout(self)
        column.setSpacing(10)
        column.addWidget(self._credentials_card())
        column.addWidget(self._prompt_card())
        column.addWidget(self._test_card())
        column.addStretch(1)

    @staticmethod
    def _row(grid, row, label, widget, hint, span=False):
        """一行 = 标签 | 控件 | 一句说明（长控件把说明挪到下一行）。"""
        caption = BodyLabel(label)
        caption.setObjectName("debugValue")
        grid.addWidget(caption, row, 0)
        if span:
            grid.addWidget(widget, row, 1, 1, 2)
            if hint:
                note = BodyLabel(hint)
                note.setObjectName("debugHint")
                grid.addWidget(note, row + 1, 1, 1, 2)
        else:
            grid.addWidget(widget, row, 1)
            note = BodyLabel(hint)
            note.setObjectName("debugHint")
            grid.addWidget(note, row, 2)

    def _grid(self, card):
        grid = QtWidgets.QGridLayout()
        grid.setVerticalSpacing(6)
        grid.setColumnMinimumWidth(0, 150)
        grid.setColumnStretch(1, 1)
        return grid

    def _card(self, title):
        card = TOKENS.card_frame(self)
        box = QtWidgets.QVBoxLayout(card)
        heading = BodyLabel(title)
        heading.setObjectName("debugSection")
        box.addWidget(heading)
        grid = self._grid(card)
        box.addLayout(grid)
        return card, grid

    def _credentials_card(self):
        prov = self.settings["provider"]
        card, grid = self._card(CARD_CREDENTIALS)
        self.base_url = QtWidgets.QLineEdit(prov.get("base_url", ""))
        self.api_key = QtWidgets.QLineEdit(prov.get("api_key", ""))
        self.api_key.setEchoMode(QtWidgets.QLineEdit.Password)
        self.model = QtWidgets.QLineEdit(prov.get("model", ""))
        self.protocol = QtWidgets.QComboBox()
        self.protocol.addItems(["auto", "responses", "chat-completions"])
        self.protocol.setCurrentText(prov.get("protocol", "auto"))
        self.mock = QtWidgets.QCheckBox("Mock 模式：不真的调用 API，只在试界面时用")
        self.mock.setChecked(bool(prov.get("mock")))
        for widget in (self.base_url, self.api_key, self.model):
            widget.textChanged.connect(self._on_edited)
        self.protocol.currentTextChanged.connect(self._on_edited)
        self.mock.toggled.connect(self._on_edited)
        self._row(grid, 0, "接口地址", self.base_url,
                  "服务商文档里的接口前缀，一般以 /v1 结尾")
        self._row(grid, 1, "密钥", self.api_key,
                  "服务商给你的那串 key，只写在本机设置文件里")
        self._row(grid, 2, "模型名", self.model,
                  "要调用哪个模型，照服务商文档里写的名字填")
        self._row(grid, 3, "接口协议", self.protocol,
                  "不知道就留「auto」；连不通时再照服务商文档换一个")
        self._row(grid, 4, "", self.mock,
                  "勾上就不发真实请求、不花额度：只用来试界面")
        return card

    def _prompt_card(self):
        prompt = self.settings["prompt"]
        card, grid = self._card(CARD_PROMPT)
        self.preset = QtWidgets.QComboBox()
        self.preset.currentIndexChanged.connect(self._on_preset_changed)
        self.preset.currentIndexChanged.connect(self._on_edited)
        self.copy_btn = PushButton("复制为自定义")
        self.rename_btn = PushButton("重命名")
        self.delete_btn = PushButton("删除")
        self.copy_btn.clicked.connect(self._copy_preset)
        self.rename_btn.clicked.connect(self._rename_preset)
        self.delete_btn.clicked.connect(self._delete_preset)
        btn_row = QtWidgets.QHBoxLayout()
        btn_row.addWidget(self.copy_btn)
        btn_row.addWidget(self.rename_btn)
        btn_row.addWidget(self.delete_btn)
        btn_row.addStretch(1)
        self.system = QtWidgets.QPlainTextEdit()
        self.system.setFixedHeight(90)
        self.system.textChanged.connect(self._on_text_edited)
        self.preview = QtWidgets.QPlainTextEdit()
        self.preview.setFixedHeight(90)
        self.preview.setReadOnly(True)
        self.context_groups = QtWidgets.QCheckBox(
            "携带上下文：把上一句、下一句也一起发给模型")
        self.context_groups.setChecked(bool(prompt.get("context_groups", 1)))
        self.context_groups.toggled.connect(self._refresh_preview)
        self._row(grid, 0, "用哪套提示词", self.preset,
                  "内置的三套只读；想改就先「复制为自定义」")
        self._row(grid, 1, "", self._wrap(btn_row), "")
        self._row(grid, 2, "提示词内容", self.system,
                  "这就是发给模型的指令；内置的只读，复制出来的才能改", span=True)
        self._row(grid, 4, "实际发出去的提示词", self.preview,
                  "下面这段就是真正发出去的内容，改上面会立刻跟着变", span=True)
        self._row(grid, 6, "", self.context_groups,
                  "勾上翻译更连贯（模型能看到前后句），每次请求也更大")
        # 最后装配：_rebuild_preset_combo -> _sync_buttons 需要按钮与编辑器已存在。
        self._rebuild_preset_combo()
        self._load_active_into_editor()
        self._refresh_preview()
        return card

    @staticmethod
    def _wrap(layout):
        w = QtWidgets.QWidget()
        w.setLayout(layout)
        return w

    def _test_card(self):
        # #23 的薄 GUI 适配层：这一页只接信号 —— 跑测试的机制与报告契约都在
        # suboverlay/connection_test.py 里，没有窗口服务器也能测。
        card, grid = self._card(CARD_TEST)
        self.test_btn = PrimaryPushButton("测试连接")
        self.cancel_btn = PushButton("取消测试")
        self.cancel_btn.setEnabled(False)
        self.progress = BodyLabel("")
        self.progress.setObjectName("debugHint")
        self.report_view = QtWidgets.QPlainTextEdit("")
        self.report_view.setReadOnly(True)
        self.report_view.setFixedHeight(150)
        buttons = QtWidgets.QHBoxLayout()
        buttons.addWidget(self.test_btn)
        buttons.addWidget(self.cancel_btn)
        buttons.addStretch(1)
        self.report_ready.connect(self._show_report)
        self._poll = QtCore.QTimer(self)
        self._poll.setInterval(200)
        self._poll.timeout.connect(self._poll_progress)
        self.test_btn.clicked.connect(self._start_connection_test)
        self.cancel_btn.clicked.connect(self._cancel_connection_test)
        self._row(grid, 0, "", self._wrap(buttons),
                  "测的是上面填的、还没保存的输入；不落盘、不动浮窗")
        self._row(grid, 1, "测试进度", self.progress, "")
        self._row(grid, 2, "测试报告", self.report_view,
                  "上一次的结果会一直留在这里", span=True)
        if self.tester is not None and self.tester.last_report():
            self._render_report(self.tester.last_report())
            self.progress.setText("上次运行——见下方报告")
        return card
