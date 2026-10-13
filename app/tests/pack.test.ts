// #196 packaging self-checks: version_label (injected vs default) and the
// default-DB resolver (dev tree keeps repo-root data/, packaged run lands in
// %APPDATA%/SubOverlay beside setting.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DebugWindow } from "../src/main/debug/window.ts";
import type { Settings } from "../src/main/settings.ts";
import { resolve_default_db } from "../src/main/queue-cache.ts";

function makeWindow(opts: ConstructorParameters<typeof DebugWindow>[1] = {}): DebugWindow {
  return new DebugWindow(({} as Settings), {
    save: () => {},
    ask_unsaved_changes: () => "save",
    ...opts,
  } as ConstructorParameters<typeof DebugWindow>[1]);
}

test("version_label: injected app_version renders with v prefix", () => {
  const w = makeWindow({ app_version: "1.2.3" });
  assert.equal(w.version_label(), "v1.2.3");
});

test("version_label: no injection renders empty (headless tests stay quiet)", () => {
  const w = makeWindow();
  assert.equal(w.version_label(), "");
});

test("resolve_default_db: dev tree keeps the #207 repo-root data/ layout", () => {
  const here = "D:/repo/app/dist/main/queue-cache.js";
  const p = resolve_default_db(here).replace(/\\/g, "/");
  // path.join normalizes the ".." climbs: app/dist/main -> up three -> repo root.
  assert.ok(p.endsWith("/repo/data/translations.db"), p);
});

test("resolve_default_db: packaged run lands beside setting.json", () => {
  const here = "D:/inst/resources/app.asar/dist/main/queue-cache.js";
  const p = resolve_default_db(here).replace(/\\/g, "/");
  assert.ok(p.endsWith("/SubOverlay/translations.db"), p);
  assert.ok(!p.includes("app.asar"), p);
});
