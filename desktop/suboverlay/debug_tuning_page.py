"""调参页：把「有键无 UI」的 15 个参数按三组呈现（spec #161）。

控件层不产生非法值（枚举下拉 / 有范围的数字框 / 取色器），写回只夹**本次动过
的键**；点「确定」才把改动合并回内存并一次落盘，「取消」全丢。编辑与生效解耦：
编辑期间不写内存里引擎正在读的那份设置，因此拖控件不会让运行中的预取/批量抖动。

页面不认识任何具体字段：它整张从 `settings.TUNING_FIELDS` 长出来，范围/默认/
单位/文案都来自那张唯一权威表。
"""
from PySide6 import QtCore, QtWidgets

from qfluentwidgets import (BodyLabel, ComboBox, DoubleSpinBox,
                            PrimaryPushButton, PushButton, Slider, SpinBox)

from . import debug_tokens as TOKENS
from . import settings as S

GROUP_TITLES = {"display": "显示", "network": "网络与服务",
                "experimental": "实验（未校准）"}

_ORDER_PATH = ("display", "order")
_MODE_PATH = ("display", "mode")


def _decimals(step):
    text = "%g" % float(step)
    return len(text.split(".")[1]) if "." in text else 0


def _normalize(field, value):
    """Round a UI value through the authority table (clamp + unit) and back."""
    section, key = field["path"]
    stored = S.stored_value(field, value)
    return S.display_value(field, {section: {key: stored}})


class TuningPage(QtWidgets.QWidget):
    def __init__(self, settings, overlay=None, save=None, pick_color=None, parent=None):
        super().__init__(parent)
        self.setObjectName("debugTuningPage")
        self.settings = settings
        self.overlay = overlay
        self._save = save or S.save
        self._pick_color = pick_color or self._ask_color
        self._initial = S.tuning_ui_state(settings)
        self._controls = {}
        self._colors = {}
        self._pairs = {}
        self._group_titles = dict(GROUP_TITLES)
        self._build()

    # ---- page surface (what the tests and the window use) ----

    def group_title(self, group):
        return self._group_titles[group]

    def hint_for(self, path):
        field = S.field_by_path(path)
        parts = [field["hint"]] if field["hint"] else []
        if field["uncalibrated"]:
            parts.append("未校准")
        return " · ".join(parts)

    def is_field_enabled(self, path):
        if path == _ORDER_PATH:
            return self.field_value(_MODE_PATH) == "bilingual"
        return self._controls[path].isEnabled()

    def field_value(self, path):
        control = self._controls[path]
        if path in self._colors:
            return list(self._colors[path])
        if path in self._pairs:
            return int(self._pairs[path][1].value())
        field = S.field_by_path(path)
        if field["control"] == "choice":
            return control.currentData()
        if field["control"] == "int":
            return int(control.value())
        return float(control.value())

    def set_field_value(self, path, value):
        """Set a control as a user would, clamped by the authority table."""
        field = S.field_by_path(path)          # KeyError outside the table
        value = _normalize(field, value)
        if field["control"] == "choice":
            self._controls[path].setCurrentIndex(list(field["choices"]).index(value))
        elif field["control"] == "color":
            self._colors[path] = list(value)
            self._controls[path].setText(self._color_text(value))
        elif field["control"] == "slider":
            self._pairs[path][1].setValue(int(value))
        elif field["control"] == "int":
            self._controls[path].setValue(int(value))
        else:
            self._controls[path].setValue(float(value))
        self._sync_enabled()

    # ---- buttons ----

    def ok(self):
        edits = S.collect_edits(self._ui_state(), self._initial)
        applied = S.apply_edits(self.settings, edits)
        if applied:
            self._save(self.settings)          # 一次原子写盘（settings.save）
        if self.overlay is not None and any(S.field_by_path(p)["notify_overlay"]
                                            for p in applied):
            self.overlay.reread_settings()     # mode/order 是浮窗的启动快照
        self._initial = S.tuning_ui_state(self.settings)
        self._load_controls()
        return applied

    def cancel(self):
        self._initial = S.tuning_ui_state(self.settings)
        self._load_controls()

    # ---- construction ----

    def _build(self):
        layout = QtWidgets.QVBoxLayout(self)
        for group in S.TUNING_GROUPS:
            layout.addWidget(self._group_card(group))
        layout.addStretch(1)
        footer = QtWidgets.QHBoxLayout()
        footer.addStretch(1)
        self.cancel_button = PushButton("取消")
        self.ok_button = TOKENS.apply_primary_button(PrimaryPushButton("确定"))
        self.cancel_button.clicked.connect(self.cancel)
        self.ok_button.clicked.connect(self.ok)
        footer.addWidget(self.cancel_button)
        footer.addWidget(self.ok_button)
        layout.addLayout(footer)
        self._sync_enabled()

    def _group_card(self, group):
        card = TOKENS.card_frame(self)
        column = QtWidgets.QVBoxLayout(card)
        title = BodyLabel(self._group_titles.get(group, group))
        title.setObjectName("debugSection")
        column.addWidget(title)
        grid = QtWidgets.QGridLayout()
        grid.setVerticalSpacing(6)
        grid.setColumnMinimumWidth(0, 130)
        grid.setColumnStretch(1, 1)
        row = 0
        for field in S.TUNING_FIELDS:
            if field["group"] != group:
                continue
            label = BodyLabel(self._label_text(field))
            label.setObjectName("debugValue")
            grid.addWidget(label, row, 0)
            grid.addWidget(self._control(field), row, 1)
            hint = BodyLabel(self.hint_for(field["path"]))
            hint.setObjectName("debugHint")
            grid.addWidget(hint, row, 2)
            row += 1
        column.addLayout(grid)
        return card

    @staticmethod
    def _label_text(field):
        return field["label"] + ("（%s）" % field["unit"] if field["unit"] else "")

    def _control(self, field):
        path, kind = field["path"], field["control"]
        if kind == "choice":
            control = ComboBox()
            for value, label in zip(field["choices"], field["labels"]):
                control.addItem(label, userData=value)
            control.setCurrentIndex(list(field["choices"]).index(self._initial[path]))
            if path == _MODE_PATH:
                control.currentIndexChanged.connect(self._sync_enabled)
        elif kind == "int":
            control = SpinBox()
            control.setRange(int(field["min"]), int(field["max"]))
            control.setSingleStep(int(field["step"] or 1))
            control.setValue(int(self._initial[path]))
        elif kind == "float":
            step = float(field["step"] or 0.1)
            control = DoubleSpinBox()
            control.setRange(float(field["min"]), float(field["max"]))
            control.setSingleStep(step)
            control.setDecimals(_decimals(step))
            control.setValue(float(self._initial[path]))
        elif kind == "slider":
            control = self._slider_row(field)
        elif kind == "color":
            control = PushButton(self._color_text(self._initial[path]))
            control.clicked.connect(lambda _=False, p=path: self._pick_color_for(p))
            self._colors[path] = list(self._initial[path])
        self._controls[path] = control
        return control

    def _slider_row(self, field):
        """滑条 + 数字框（spec #161 字段表：背景不透明度）。两者永远同值：改谁
        都同步另一个，`field_value` 读数字框（整数语义，滑条不会给出小数）。"""
        path = field["path"]
        row = QtWidgets.QWidget()
        box = QtWidgets.QHBoxLayout(row)
        box.setContentsMargins(0, 0, 0, 0)
        box.setSpacing(8)
        slider = Slider(QtCore.Qt.Horizontal)
        spin = SpinBox()
        for widget in (slider, spin):
            widget.setRange(int(field["min"]), int(field["max"]))
            widget.setSingleStep(int(field["step"] or 1))
        value = int(self._initial[path])
        slider.setValue(value)
        spin.setValue(value)
        busy = []

        def from_slider(number):
            if busy:
                return
            busy.append(True)
            spin.setValue(int(number))
            busy.pop()

        def from_spin(number):
            if busy:
                return
            busy.append(True)
            slider.setValue(int(number))
            busy.pop()

        slider.valueChanged.connect(from_slider)
        spin.valueChanged.connect(from_spin)
        box.addWidget(slider, 1)
        box.addWidget(spin)
        self._pairs[path] = (slider, spin)
        return row

    # ---- internals ----

    def _ui_state(self):
        return {field["path"]: self.field_value(field["path"]) for field in S.TUNING_FIELDS}

    def _load_controls(self):
        for field in S.TUNING_FIELDS:
            path = field["path"]
            value = self._initial[path]
            control = self._controls[path]
            if path in self._colors:
                self._colors[path] = list(value)
                control.setText(self._color_text(value))
            elif path in self._pairs:
                self._pairs[path][1].setValue(int(value))
            elif field["control"] == "choice":
                control.setCurrentIndex(list(field["choices"]).index(value))
            elif field["control"] == "int":
                control.setValue(int(value))
            else:
                control.setValue(float(value))
        self._sync_enabled()

    def _sync_enabled(self):
        if _ORDER_PATH in self._controls:
            self._controls[_ORDER_PATH].setEnabled(self.is_field_enabled(_ORDER_PATH))

    def _pick_color_for(self, path):
        field = S.field_by_path(path)
        current = self._colors[path]
        chosen = self._pick_color("选择背景色", current)
        if chosen is not None:
            self.set_field_value(path, [chosen.red(), chosen.green(), chosen.blue()])

    def _ask_color(self, title, current):
        from PySide6 import QtGui
        color = QtGui.QColor(*current)
        chosen = QtWidgets.QColorDialog.getColor(color, self, title)
        return chosen if chosen.isValid() else None

    @staticmethod
    def _color_text(rgb):
        return "#%02X%02X%02X" % tuple(int(c) for c in rgb)
