// Shared overlay menu model - the TS equivalent of desktop/app.py building
// ONE QMenu object that the tray and the overlay right-click both pop (#172).
// Python mutates action texts on that single object; Electron menus are
// immutable, so the model is a pure function of the two state bits and both
// consumers (tray native Menu here, renderer DOM menu via IPC) rebuild from
// the same source of truth. Copy is byte-exact from app.py _menu().
export type OverlayMenuAction =
  | "toggle-overlay"
  | "cycle-mode"
  | "swap-order"
  | "font-up"
  | "font-down"
  | "bg-denser"
  | "bg-lighter"
  | "click-through"
  | "open-settings"
  | "open-debug"
  | "quit";

export type OverlayMenuEntry =
  | { kind: "separator" }
  | { kind: "action"; id: OverlayMenuAction; label: string; checkable: boolean; checked: boolean };

export interface OverlayMenuState {
  overlay_visible: boolean;
  click_through: boolean;
}

export function overlay_menu_model(s: OverlayMenuState): OverlayMenuEntry[] {
  return [
    { kind: "action", id: "toggle-overlay", label: s.overlay_visible ? "隐藏浮窗" : "显示浮窗", checkable: false, checked: false },
    { kind: "separator" },
    { kind: "action", id: "cycle-mode", label: "显示内容：原文 / 译文 / 双语（点一下换下一种）", checkable: false, checked: false },
    { kind: "action", id: "swap-order", label: "上下顺序：原文 ↔ 译文（点一下对调）", checkable: false, checked: false },
    { kind: "separator" },
    { kind: "action", id: "font-up", label: "字号调大", checkable: false, checked: false },
    { kind: "action", id: "font-down", label: "字号调小", checkable: false, checked: false },
    { kind: "action", id: "bg-denser", label: "背景调浓", checkable: false, checked: false },
    { kind: "action", id: "bg-lighter", label: "背景调淡", checkable: false, checked: false },
    { kind: "separator" },
    { kind: "action", id: "click-through", checkable: true, checked: s.click_through,
      label: s.click_through
        ? "鼠标穿透：已开启（Ctrl+Alt+U 解锁）"
        : "鼠标穿透（开启后点不到浮窗，Ctrl+Alt+U 解锁）" },
    { kind: "action", id: "open-settings", label: "设置……", checkable: false, checked: false },
    { kind: "action", id: "open-debug", label: "调试……", checkable: false, checked: false },
    { kind: "separator" },
    { kind: "action", id: "quit", label: "退出程序", checkable: false, checked: false },
  ];
}
