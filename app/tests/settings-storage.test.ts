// Storage-layer semantics port: the "Testing Decision 3 - migration
// (settings layer, table-driven)" block of desktop/tests/test_prompt_presets.py
// (#39 / ADR-010), converted 1:1, PLUS the load/save behaviors the #199
// acceptance names explicitly (load/save, corrupt -> .bak fallback, default
// merge). New coverage beyond existing pytest assertions is marked [补齐].
// All tests operate on temp-dir copies - never the real %APPDATA% config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as S from "../lib/settings.ts";

function withTmp(name: string, fn: (dir: string) => void): void {
  test(name, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "settings-ts-test-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// _write_legacy equivalent: write {"prompt": node} as UTF-8 without ASCII escaping.
function writeLegacy(dir: string, promptNode: S.Json): string {
  const p = path.join(dir, "setting.json");
  writeFileSync(p, JSON.stringify({ prompt: promptNode }), "utf8");
  return p;
}

function readJson(p: string): S.Json {
  return JSON.parse(readFileSync(p, "utf8")) as S.Json;
}

// ---------------------------------------------------------------------
// Migration (test_prompt_presets.py Decision 3, 1:1)
// ---------------------------------------------------------------------

withTmp("migration: custom text becomes prompt_migrated", (dir) => {
  const p = writeLegacy(dir, { system: "  My custom instructions.  ", context_groups: 1 });
  const cfg = S.load(p);
  const pr = cfg["prompt"] as S.JsonObject;
  assert.equal(pr["active"], "prompt_migrated");
  assert.deepEqual(pr["presets"], [
    { id: "prompt_migrated", name: "旧版自定义", text: "My custom instructions." }]);
  assert.equal("system" in pr, false, "no dual source in memory");
  const onDisk = readJson(p) as S.JsonObject;
  const onDiskPrompt = onDisk["prompt"];
  assert.equal(S.isJsonObject(onDiskPrompt) && "system" in onDiskPrompt, false,
    "legacy key removed from disk");
  // idempotent: a second load migrates nothing new
  const cfg2 = S.load(p);
  assert.deepEqual(cfg2, cfg);
  assert.equal(((cfg2["prompt"] as S.JsonObject)["presets"] as S.Json[]).length, 1);
});

for (const legacy of ["", "   ", "\n  ", S.DEFAULT_PROMPT_TEXT]) {
  withTmp("migration: blank or default legacy is discarded: " + JSON.stringify(legacy), (dir) => {
    const p = writeLegacy(dir, { system: legacy, context_groups: 0 });
    const cfg = S.load(p);
    assert.deepEqual(cfg["prompt"], { active: "default", presets: [], context_groups: 0 });
    const onDiskPrompt = (readJson(p) as S.JsonObject)["prompt"];
    assert.equal(S.isJsonObject(onDiskPrompt) && "system" in onDiskPrompt, false);
    assert.deepEqual(S.load(p), cfg); // idempotent
  });
}

withTmp("migration: zero without legacy key (file untouched byte-for-byte)", (dir) => {
  const p = writeLegacy(dir, { active: "natural", presets: [], context_groups: 0 });
  const before = readFileSync(p, "utf8");
  const cfg = S.load(p);
  assert.deepEqual(cfg["prompt"], { active: "natural", presets: [], context_groups: 0 });
  assert.equal(readFileSync(p, "utf8"), before, "no legacy key -> zero migration, file untouched");
});

const DAMAGED: Array<[S.Json, S.Json[], string]> = [
  ["not-a-list", [], "default"],                       // not an array
  [[{ name: "no id", text: "t" }], [], "default"],     // item missing id
  [[{ id: "prompt_x1" }], [], "default"],              // item missing text
  [[{ id: "prompt_ok", text: "t" }, { bad: 1 }], [], "default"], // one bad poisons all
  [[{ id: "prompt_ok", text: "t" }], [{ id: "prompt_ok", text: "t" }], "prompt_ok"],
];
for (const [bad, wantPresets, wantActive] of DAMAGED) {
  withTmp("damaged presets array falls back: " + JSON.stringify(bad), (dir) => {
    const p = writeLegacy(dir, { presets: bad, active: "prompt_ok" });
    const cfg = S.load(p);
    const pr = cfg["prompt"] as S.JsonObject;
    assert.deepEqual(pr["presets"], wantPresets);
    assert.equal(pr["active"], wantActive);
  });
}

withTmp("active pointing at missing id falls back to default", (dir) => {
  const p = writeLegacy(dir,
    { active: "prompt_ghost", presets: [{ id: "prompt_ok", text: "t" }] });
  const cfg = S.load(p);
  assert.equal((cfg["prompt"] as S.JsonObject)["active"], "default");
});

withTmp("non-dict prompt node resets to schema", (dir) => {
  const p = writeLegacy(dir, "garbage");
  const cfg = S.load(p);
  assert.deepEqual(cfg["prompt"], { active: "default", presets: [], context_groups: 1 });
});

withTmp("default settings ship the new schema", () => {
  const pr = (S.default_settings()["prompt"] ?? null) as S.JsonObject | null;
  assert.ok(pr !== null);
  assert.deepEqual({ ...pr }, { active: "default", presets: [], context_groups: 1 });
  assert.equal("system" in pr, false);
  // built-ins exist only in code, never on disk
  assert.deepEqual(S.BUILTIN_PROMPTS.map((b) => b.id), ["default", "literal", "natural"]);
  assert.equal(S.active_prompt_text(S.default_settings()), S.DEFAULT_PROMPT_TEXT);
});

// ---------------------------------------------------------------------
// [补齐] load / save behaviors named by the #199 acceptance:
// 存取 (load/save) / 损坏回退 (corrupt -> .bak) / 默认值合并 (default merge).
// Existing pytest had no direct assertions for these; none are weakened,
// these pin the ported behavior at the same seam.
// ---------------------------------------------------------------------

withTmp("[补齐] load: missing file returns defaults, writes nothing", (dir) => {
  const p = path.join(dir, "setting.json");
  assert.deepEqual(S.load(p), S.default_settings());
  assert.equal(existsSync(p), false);
  assert.equal(existsSync(p + ".bak"), false);
});

withTmp("[补齐] load: corrupt JSON is renamed to .bak, defaults returned", (dir) => {
  const p = path.join(dir, "setting.json");
  writeFileSync(p, "{not valid json", "utf8");
  const cfg = S.load(p);
  assert.deepEqual(cfg, S.default_settings());
  assert.equal(existsSync(p), false, "corrupt file is moved away");
  assert.equal(existsSync(p + ".bak"), true, "corrupt file preserved as .bak");
});

withTmp("[补齐] load: invalid UTF-8 bytes fall back like UnicodeDecodeError", (dir) => {
  const p = path.join(dir, "setting.json");
  writeFileSync(p, Buffer.from([0x7b, 0xff, 0xfe, 0x7d])); // {" + invalid UTF-8 + }
  const cfg = S.load(p);
  assert.deepEqual(cfg, S.default_settings());
  assert.equal(existsSync(p + ".bak"), true);
});

withTmp("[补齐] load: valid JSON but top-level non-dict returns defaults, file kept", (dir) => {
  const p = path.join(dir, "setting.json");
  writeFileSync(p, "[1, 2, 3]", "utf8");
  const cfg = S.load(p);
  assert.deepEqual(cfg, S.default_settings());
  assert.equal(readFileSync(p, "utf8"), "[1, 2, 3]", "not corruption: file stays");
  assert.equal(existsSync(p + ".bak"), false);
});

withTmp("[补齐] load: shallow merge keeps unknown keys and fills missing defaults", (dir) => {
  const p = path.join(dir, "setting.json");
  writeFileSync(p, JSON.stringify({
    display: { font_size: 99, draft: 1 },
    custom_top: "x",
    server: { port: 1234 },
  }), "utf8");
  const cfg = S.load(p);
  const display = cfg["display"] as S.JsonObject;
  assert.equal(display["font_size"], 99);   // file wins over default
  assert.equal(display["mode"], "bilingual"); // default fills the rest
  assert.equal(display["draft"], 1);        // unknown keys inside a section survive
  assert.equal(cfg["custom_top"], "x");     // unknown top-level keys survive
  assert.equal((cfg["server"] as S.JsonObject)["port"], 1234);
  assert.deepEqual(cfg["provider"], (S.default_settings()["provider"] as S.JsonObject));
});

withTmp("[补齐] save: creates the directory, leaves no tmp behind", (dir) => {
  const p = path.join(dir, "nested", "setting.json");
  const returned = S.save(S.default_settings(), p);
  assert.equal(returned, p);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), S.default_settings());
  assert.equal(existsSync(p + ".tmp"), false);
});

withTmp("[补齐] save -> load round trip equals the original config", (dir) => {
  const p = path.join(dir, "setting.json");
  S.save(S.default_settings(), p);
  assert.deepEqual(S.load(p), S.default_settings());
});

test("[补齐] active_prompt_text: builtins, custom, bad custom, non-dict cfg", () => {
  assert.equal(S.active_prompt_text(S.default_settings()), S.DEFAULT_PROMPT_TEXT);
  assert.equal(
    S.active_prompt_text({ prompt: { active: "literal", presets: [] } }),
    S.LITERAL_PROMPT_TEXT);
  assert.equal(
    S.active_prompt_text({ prompt: { active: "natural", presets: [] } }),
    S.NATURAL_PROMPT_TEXT);
  assert.equal(
    S.active_prompt_text({ prompt: { active: "c1", presets: [{ id: "c1", name: "N", text: "Custom!" }] } }),
    "Custom!");
  // custom text that is not a string is skipped -> default
  assert.equal(
    S.active_prompt_text({ prompt: { active: "c1", presets: [{ id: "c1", name: "N", text: 42 }] } }),
    S.DEFAULT_PROMPT_TEXT);
  // non-dict cfg falls back like the Python isinstance guard
  assert.equal(S.active_prompt_text("garbage"), S.DEFAULT_PROMPT_TEXT);
  assert.equal(S.active_prompt_text(undefined), S.DEFAULT_PROMPT_TEXT);
});

test("[补齐] redact: public summary never leaks base_url or api_key", () => {
  assert.deepEqual(
    S.redact({ provider: { base_url: "https://x.test/v1", api_key: "sk", model: "m", protocol: "chat-completions" } }),
    { configured: true, host: "x.test", model: "m", protocol: "chat-completions" });
  assert.deepEqual(S.redact(S.default_settings()),
    { configured: false, host: "", model: "", protocol: "auto" });
  // robustness beyond the Python isinstance guard (registered deviation):
  // a non-dict cfg / provider node yields the empty summary instead of raising
  assert.deepEqual(S.redact(undefined),
    { configured: false, host: "", model: "", protocol: "auto" });
  assert.deepEqual(S.redact({ provider: "broken" }),
    { configured: false, host: "", model: "", protocol: "auto" });
});
