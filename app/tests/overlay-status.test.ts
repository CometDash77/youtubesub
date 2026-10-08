// Equivalence port of desktop/tests/test_overlay_status.py (ticket #204).
//
// The overlay's status line must distinguish "no captions here" from "the
// script is connected but its page hook never installed". Conversion register:
// set_display status lines are read from the state's status_text field
// directly (the plan carries the same value for rendering).
import assert from "node:assert/strict";
import { test } from "node:test";
import { OverlayDisplay } from "../lib/overlay.ts";
import { default_settings } from "../lib/settings.ts";

function mk(): OverlayDisplay {
  return new OverlayDisplay(default_settings() as { [k: string]: unknown });
}

test("hook failure is visible in the status line", () => {
  const w = mk();
  w.set_display({ state: "no_cues", title: "Some video",
    hook_error: "script element: TypeError: TrustedScript" });
  assert.ok(w.status_text.toLowerCase().includes("hook"), w.status_text);
  assert.ok(!w.status_text.includes("waiting for subtitles"), w.status_text);
});

test("no cues without a hook error still says waiting", () => {
  const w = mk();
  w.set_display({ state: "no_cues", title: "Some video", hook_error: "" });
  assert.ok(w.status_text.startsWith("waiting for subtitles"), w.status_text);
  assert.ok(w.status_text.includes("Some video"), w.status_text);
});

test("an empty caption body has its own status line", () => {
  // A hook that installed fine but got no caption body is a different failure
  // from a hook that never installed; the user must see which one they have.
  const w = mk();
  w.set_display({ state: "no_cues", title: "Some video", hook_error: "",
    capture_error: "caption response was empty (status 200)" });
  assert.ok(w.status_text.toLowerCase().includes("caption body"), w.status_text);
  assert.ok(!w.status_text.includes("waiting for subtitles"), w.status_text);
});

test("a missing page hook outranks an empty caption body", () => {
  const w = mk();
  w.set_display({ state: "no_cues", title: "Some video",
    hook_error: "script element: TypeError: TrustedScript",
    capture_error: "caption response was empty (status 200)" });
  assert.ok(w.status_text.toLowerCase().includes("hook"), w.status_text);
});
