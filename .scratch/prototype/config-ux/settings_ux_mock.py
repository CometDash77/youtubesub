"""Throwaway prototype for wayfinder ticket #4 (配置可信 UX 形态). NOT shipped code.

Renders the *proposed* Settings panel in three provider states (未配置 / Mock /
已配置) plus the overlay's three states. The overlay mock subclasses the real
OverlayWindow so its paint path is the shipping one, not a redraw.

Run:  python .scratch/prototype/config-ux/settings_ux_mock.py
Out:  same dir, 01..04 *.png
"""
import os, sys, datetime

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "desktop"))

from PySide6 import QtCore, QtGui, QtWidgets
from suboverlay.overlay import OverlayWindow
from suboverlay import settings as S

BANNER = {
    "unconfigured": ("未配置 —— 浮窗只显示原文，不显示译文（不会假装翻译）",
                     "#4a3410", "#f6c453", "#2a2a2a"),
    "mock": ("Mock 模式 —— 译文是本地回声（带【译】前缀），不代表真实翻译质量",
             "#0f2f45", "#6fc3f0", "#2a2a2a"),
    "configured": ("已配置 —— 译文来自 {host} · {model}",
                   "#123321", "#6fdc8c", "#2a2a2a"),
}


def provider_state(prov):
    if prov.get("mock"):
        return "mock"
    if (prov.get("base_url") or "").strip() and (prov.get("model") or "").strip():
        return "configured"
    return "unconfigured"


def host_of(base_url):
    b = (base_url or "").strip()
    return b.split("/")[2] if "://" in b else (b or "?")


class ProposedSettingsDialog(QtWidgets.QDialog):
    """The proposed shape: state banner + masked-key replace semantics +
    a footer that answers 'saved where / did it save' + explicit 保存."""

    def __init__(self, settings, saved_at=None, dirty=False):
        super().__init__()
        self.settings = settings
        self.setWindowTitle("AI Translation Settings")
        self.setMinimumWidth(620)
        self._saved_at = saved_at
        self._dirty = dirty
        root = QtWidgets.QVBoxLayout(self)
        root.setSpacing(10)

        # --- (Q3) three-state banner ---
        prov = settings["provider"]
        st = provider_state(prov)
        tmpl, bg, fg, _ = BANNER[st]
        self.banner = QtWidgets.QLabel(tmpl.format(host=host_of(prov.get("base_url", "")),
                                                   model=prov.get("model") or "?"))
        self.banner.setWordWrap(True)
        self.banner.setStyleSheet(
            f"background:{bg}; color:{fg}; border:1px solid {fg}; border-radius:6px;"
            "padding:8px 10px; font-weight:600;")
        root.addWidget(self.banner)

        form = QtWidgets.QFormLayout()
        form.setLabelAlignment(QtCore.Qt.AlignRight)
        self.base_url = QtWidgets.QLineEdit(prov.get("base_url", ""))
        self.base_url.setPlaceholderText("https://api.example.com/v1  （未设置）")
        self.model = QtWidgets.QLineEdit(prov.get("model", ""))
        self.model.setPlaceholderText("gpt-4o-mini  （未设置）")

        # --- (Q2) credential echo: never plaintext, replace-by-typing, explicit clear ---
        key_row = QtWidgets.QWidget()
        kl = QtWidgets.QHBoxLayout(key_row)
        kl.setContentsMargins(0, 0, 0, 0)
        self.api_key = QtWidgets.QLineEdit("")
        self.api_key.setEchoMode(QtWidgets.QLineEdit.Password)
        n = len(prov.get("api_key") or "")
        self.api_key.setPlaceholderText(
            f"••••••••••••  已保存 {n} 字符 · 留空 = 不改动 · 输入 = 覆盖" if n
            else "尚未设置（明文不会回显）")
        self.clear_key = QtWidgets.QToolButton()
        self.clear_key.setText("清除")
        kl.addWidget(self.api_key, 1)
        kl.addWidget(self.clear_key)

        self.protocol = QtWidgets.QComboBox()
        self.protocol.addItems(["auto", "responses", "chat-completions"])
        self.protocol.setCurrentText(prov.get("protocol", "auto"))
        self.system = QtWidgets.QPlainTextEdit(settings["prompt"].get("system", ""))
        self.system.setFixedHeight(74)
        self.mock = QtWidgets.QCheckBox("Mock mode (no real API) —— 本地回声，用于验证链路")
        self.mock.setChecked(bool(prov.get("mock")))
        self.font_size = QtWidgets.QSpinBox()
        self.font_size.setRange(6, 40)
        self.font_size.setValue(int(settings["display"].get("font_size", 10)))

        form.addRow("Base URL", self.base_url)
        form.addRow("Model", self.model)
        form.addRow("API Key", key_row)
        form.addRow("Protocol", self.protocol)
        form.addRow("System Prompt", self.system)
        form.addRow("", self.mock)
        form.addRow("Font size", self.font_size)
        root.addLayout(form)

        # --- (Q1/Q4) footer: where it saves, whether it saved ---
        foot = QtWidgets.QHBoxLayout()
        self.save_state = QtWidgets.QLabel("")
        foot.addWidget(self.save_state)
        foot.addStretch(1)
        self.path_label = QtWidgets.QLabel(settings_path_for_display())
        self.path_label.setTextInteractionFlags(QtCore.Qt.TextSelectableByMouse)
        self.path_label.setStyleSheet("color:#9aa0a6; font-family:Consolas; font-size:11px;")
        self.open_dir = QtWidgets.QToolButton()
        self.open_dir.setText("打开配置目录")
        foot.addWidget(self.path_label)
        foot.addWidget(self.open_dir)
        root.addLayout(foot)

        # --- actions ---
        bar = QtWidgets.QHBoxLayout()
        self.test_conn = QtWidgets.QPushButton("测试连接…")
        self.test_conn.setToolTip("两步契约（探端点/鉴权 → 最小翻译）在 ticket #5 定；此按钮位置先占位")
        bar.addWidget(self.test_conn)
        bar.addStretch(1)
        self.save_btn = QtWidgets.QPushButton("保存")
        self.save_btn.setDefault(True)
        self.close_btn = QtWidgets.QPushButton("关闭")
        bar.addWidget(self.save_btn)
        bar.addWidget(self.close_btn)
        root.addLayout(bar)

        self._refresh_footer()

    def _refresh_footer(self):
        if self._dirty:
            self.save_state.setText("● 有未保存的改动")
            self.save_state.setStyleSheet("color:#f6c453; font-weight:600;")
        elif self._saved_at:
            self.save_state.setText(f"✔ 已保存 {self._saved_at}")
            self.save_state.setStyleSheet("color:#6fdc8c; font-weight:600;")
        else:
            self.save_state.setText("无改动")
            self.save_state.setStyleSheet("color:#9aa0a6;")


def settings_path_for_display():
    return S.settings_path()


class ProposedOverlay(OverlayWindow):
    """Real paint path + the proposed three-state status line."""

    def set_display(self, d):
        super().set_display(d)
        st = provider_state(self.settings["provider"])
        if st == "unconfigured":
            self.status_text = "未配置翻译 · 右键 → 设置"
        elif st == "mock" and "Mock" not in self.status_text:
            self.status_text = (self.status_text + "   " if self.status_text else "") + \
                "Mock 模式 · 译文为本地回声"
        self.update()


def shot(widget, name):
    widget.show()
    QtWidgets.QApplication.processEvents()
    pm = widget.grab()
    p = os.path.join(HERE, name)
    pm.save(p)
    widget.hide()
    print("saved", p, pm.width(), "x", pm.height())
    return pm


def make_settings(base_url="", model="", key="", mock=False, sp="", at=None):
    s = S.default_settings()
    s["provider"].update({"base_url": base_url, "model": model, "api_key": key, "mock": mock})
    s["prompt"]["system"] = sp or s["prompt"]["system"]
    return s


def dialog_shot(name, settings, saved_at=None, dirty=False):
    d = ProposedSettingsDialog(settings, saved_at=saved_at, dirty=dirty)
    d.resize(640, d.sizeHint().height())
    return shot(d, name)


def overlay_composite():
    """Three overlay states stacked, composited over a mid-gray backdrop so the
    translucent ARGB box is visible."""
    W, H, PAD, LABEL = 680, 118, 26, 22
    canvas = QtGui.QPixmap(W + PAD * 2, (H + LABEL) * 3 + PAD)
    canvas.fill(QtGui.QColor(58, 58, 62))
    p = QtGui.QPainter(canvas)
    p.setRenderHint(QtGui.QPainter.Antialiasing)
    cases = [
        ("未配置（现状 issue #1 的根因：没有译文，却看不出为什么）",
         make_settings(), {"state": "ok", "orig": "FIXTURE ALPHA one", "trans": "", "playing": True},),
        ("Mock 模式（用户主动开启的验证替身）",
         make_settings(mock=True),
         {"state": "ok", "orig": "FIXTURE ALPHA one", "trans": "【译】FIXTURE ALPHA one", "playing": True},),
        ("已配置（真实译文，无状态行打扰）",
         make_settings("https://api.example.com/v1", "gpt-4o-mini", "sk-" + "x" * 48),
         {"state": "ok", "orig": "FIXTURE ALPHA one",
          "trans": "夹具阿尔法一号", "playing": True},),
    ]
    for i, (label, st, disp) in enumerate(cases):
        y = PAD + i * (H + LABEL)
        p.setPen(QtGui.QColor(210, 210, 214))
        f = QtGui.QFont("Microsoft YaHei UI", 10)
        p.setFont(f)
        p.drawText(PAD, y - 6, label)
        w = ProposedOverlay(st)
        w.resize(W, H)
        w.set_display(disp)
        QtWidgets.QApplication.processEvents()
        p.drawPixmap(PAD, y + 4, w.grab())
        w.deleteLater()
    p.end()
    out = os.path.join(HERE, "04-overlay-three-states.png")
    canvas.save(out)
    print("saved", out, canvas.width(), "x", canvas.height())


def main():
    QtWidgets.QApplication([])
    empty = make_settings()
    configured = make_settings("https://api.example.com/v1", "gpt-4o-mini", "sk-" + "x" * 48)
    mock = make_settings(mock=True)
    dialog_shot("01-unconfigured.png", empty)
    dialog_shot("02-configured-just-saved.png", configured,
                saved_at=datetime.datetime.now().strftime("%H:%M:%S"))
    dialog_shot("03-mock-mode-dirty.png", mock, dirty=True)
    overlay_composite()


if __name__ == "__main__":
    main()
