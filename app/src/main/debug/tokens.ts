// Port of desktop/suboverlay/debug_tokens.py - visual tokens for the settings
// / debug window: the palette and the window-surface recipe. The one source is
// wayfinder/debug-window-style-tokens.md ("role mapping" table: cream paper +
// indigo primary + pine secondary + terracotta danger + mustard highlight).
// This module only maps; per that document's section 4 it must not leak into
// any surface outside the debug window.
//
// Conversion notes (ticket #205): Qt object-name selectors (QFrame#debugCard,
// QLabel#debugHint, ...) become plain CSS classes (.debugCard, .debugHint,
// ...) consumed by the bare-DOM renderer; primary_button_qss() pins the
// indigo button look on a .debugPrimary class instead of appending to a
// widget stylesheet (Fluent's widget-level sheet has no Electron equivalent).
export const PAPER = "#E6E3DA";
export const CARD = "#E0DDD2";
export const INDIGO = "#343E68";
export const PINE = "#38544D";
export const TERRACOTTA = "#B94D37";
export const MUSTARD = "#CCA13D";

export const TEXT_PRIMARY = "#2D3662";      // main text (indigo, one step deeper)
export const TEXT_SECONDARY = "#355044";    // secondary text / hints (pine, deeper)
export const TERRACOTTA_DARK = "#8F3A29";   // body-level error text (3.92:1 needs the darker step)
export const BORDER = "#C9C4B6";            // separators / strokes: soft but visible on paper

// Status badges (pine = ok / mustard = warn / terracotta = error)
export const OK = PINE;
export const WARN = MUSTARD;
export const ERROR = TERRACOTTA;

// Window surface: OPAQUE cream. The outer layer is never translucent/frosted
// (user ruling 2026-10-03: "the frosted-glass effect is not necessary"); the
// visual structure lives in the inner cards. Recipe = cream + 24 radius +
// 1px inner stroke + 48px soft shadow.
export const WINDOW_RGBA: readonly [number, number, number, number] = [246, 243, 235, 255];
export const WINDOW_STROKE_RGBA: readonly [number, number, number, number] = [255, 255, 255, 110];
export const RADIUS = 24;
export const SHADOW_BLUR = 48;

// Hover/pressed steps of the primary button: one step lighter/darker of the
// indigo primary (the token document only pins the static colors).
export const INDIGO_HOVER = "#3F4B7D";
export const INDIGO_PRESSED = "#2A3355";

export function window_sheet(): string {
  // Frameless window's radius / inner stroke / surface (token doc section 3).
  const [r, g, b, a] = WINDOW_RGBA;
  const [sr, sg, sb, sa] = WINDOW_STROKE_RGBA;
  return "#debugWindow {\n" +
    "    background: rgba(" + r + ", " + g + ", " + b + ", " + a + ");\n" +
    "    border: 1px solid rgba(" + sr + ", " + sg + ", " + sb + ", " + sa + ");\n" +
    "    border-radius: " + RADIUS + "px;\n" +
    "}";
}

export function primary_button_qss(): string {
  // Primary button (Save / Refresh now) in indigo. Python had to pin it on
  // the button itself because Fluent buttons carry a widget-level stylesheet;
  // the DOM equivalent is a dedicated class the renderer puts on the button.
  return ".debugPrimary { color: " + PAPER + "; background: " + INDIGO + ";\n" +
    "    border: 1px solid " + INDIGO + "; border-radius: 6px; padding: 6px 18px; }\n" +
    ".debugPrimary:hover { background: " + INDIGO_HOVER + ";\n" +
    "    border: 1px solid " + INDIGO_HOVER + "; }\n" +
    ".debugPrimary:pressed, .debugPrimary:active { background: " + INDIGO_PRESSED + ";\n" +
    "    border: 1px solid " + INDIGO_PRESSED + "; }\n" +
    ".debugPrimary:disabled { color: " + TEXT_SECONDARY + ";\n" +
    "    background: " + BORDER + "; border: 1px solid " + BORDER + "; }";
}

export function apply_primary_button(): string {
  // Class the renderer must add to a primary button (see primary_button_qss).
  return "debugPrimary";
}

export function qss(): string {
  // Window and card styles. Mustard is a fill only, never a text color
  // (contrast 1.87:1). Every rule has a consumer (window / tuning page /
  // diag page): status bar uses the badge trio; body values debugValue;
  // secondary copy debugHint; stale values debugStale; error values
  // debugError. Primary buttons go through primary_button_qss().
  return window_sheet() + "\n" +
    ".debugCard { background: " + CARD + "; border: 1px solid " + BORDER + "; border-radius: 12px; }\n" +
    "#debugTitle { color: " + TEXT_PRIMARY + "; font-size: 15px; font-weight: bold; }\n" +
    ".debugSection { color: " + TEXT_PRIMARY + "; font-weight: bold; }\n" +
    ".debugValue { color: " + TEXT_PRIMARY + "; }\n" +
    ".debugHint { color: " + TEXT_SECONDARY + "; }\n" +
    ".debugStale { color: " + TEXT_SECONDARY + "; }\n" +
    ".debugError { color: " + TERRACOTTA_DARK + "; }\n" +
    ".debugBadgeOk { color: white; background: " + OK + "; border-radius: 7px; padding: 1px 8px; }\n" +
    ".debugBadgeWarn { color: " + TEXT_PRIMARY + "; background: " + WARN + "; border-radius: 7px; padding: 1px 8px; }\n" +
    ".debugBadgeError { color: white; background: " + ERROR + "; border-radius: 7px; padding: 1px 8px; }\n";
}
