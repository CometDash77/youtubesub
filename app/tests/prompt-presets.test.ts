// Port of desktop/tests/test_prompt_presets.py (#39 / ADR-010; ticket #203,
// map #181). Every pytest test function maps to exactly one test() below OR
// is already ported elsewhere, registered here (nothing is dropped):
//   - Decision 1 (engine/identity): switching_builtin_preset_forks...,
//     editing_and_deleting_a_custom_preset... -> this file.
//   - test_snapshot_carries_the_preset_to_the_wire -> this file.
//   - Decision 2 (client wire shape): wire_three_segment_order...,
//     wire_same_shape_on_responses_protocol -> this file (translate_group
//     with the injected opts.post transport, per the #202 conversion).
//   - Decision 3 (settings migration, table-driven, 7 functions):
//     already ported 1:1 in tests/settings-storage.test.ts (ticket #199).
//   - test_default_settings_ship_new_schema -> already ported in
//     tests/settings-storage.test.ts (schema + BUILTIN ids + active text).
//   - Decision 5: test_production_goes_through_the_single_assembly_function
//     -> this file; the monkeypatch-spy half is impossible on an ESM module
//     binding, so the call-through is asserted by a source scan and the
//     observable contract (preview == production byte-identical system) is
//     asserted through the wire.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as P from "../lib/provider.ts";
import * as S from "../lib/settings.ts";
import { Engine } from "../lib/engine.ts";
import * as Q from "../lib/queue-cache.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function withTmp(name: string, fn: (dir: string) => void | Promise<void>): void {
  test(name, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "presets-ts-test-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

const GROUP = { text: "Hello world, this is a sentence." };

function mk_preset_engine(dir: string, tag: string,
                          active = "default",
                          presets?: Array<Record<string, unknown>>): Engine {
  const s = S.default_settings();
  Object.assign(s["provider"] as unknown as Record<string, unknown>,
                { base_url: "https://x.test/v1", model: "m", mock: true });
  (s["prompt"] as unknown as Record<string, unknown>)["active"] = active;
  if (presets !== undefined) {
    (s["prompt"] as unknown as Record<string, unknown>)["presets"] = presets;
  }
  return new Engine(s, new Q.TranslationCache(path.join(dir, "t-" + tag + ".db")), 1);
}

// (identity, namespace) the engine would use for GROUP right now.
function ident_ns(e: Engine): [string, string] {
  const [prov, instr] = e._provider_snapshot();
  const ident = e._identity(prov, instr, "video|manual|0|1000|Hello", GROUP, ["", ""]);
  return [ident, e._namespace_of(prov, instr)];
}

// ---------------------------------------------------------------------------
// Testing Decision 1 - identity x preset (engine / identity layer)
// ---------------------------------------------------------------------------

withTmp("switching builtin preset forks identity and namespace", async (dir) => {
  // Every switch forks identity and namespace; returning to default must be
  // byte-identical to the first run (the fork is deterministic, not one-way).
  const e = mk_preset_engine(dir, "a");
  try {
    const [id_def, ns_def] = ident_ns(e);
    (e.settings["prompt"] as unknown as Record<string, unknown>)["active"] = "literal";
    const [id_lit, ns_lit] = ident_ns(e);
    assert.notEqual(id_lit, id_def, "switching preset must change the identity");
    assert.notEqual(ns_lit, ns_def, "switching preset must change the namespace");
    (e.settings["prompt"] as unknown as Record<string, unknown>)["active"] = "natural";
    const [id_nat, ns_nat] = ident_ns(e);
    assert.ok(id_nat !== id_def && id_nat !== id_lit);
    assert.ok(ns_nat !== ns_def && ns_nat !== ns_lit);
    (e.settings["prompt"] as unknown as Record<string, unknown>)["active"] = "default";
    const [id_back, ns_back] = ident_ns(e);
    assert.equal(id_back, id_def,
                 "returning to default must reproduce the first identity byte-for-byte");
    assert.equal(ns_back, ns_def);
  } finally {
    stop(e);
  }
});

withTmp("editing and deleting a custom preset forks identity", async (dir) => {
  // A one-character edit of the active custom text forks identity and
  // namespace; deleting the active custom forks both too (#39 D6).
  const presets = [{ id: "prompt_ab12cd34", name: "Mine", text: "Custom text." }];
  const e = mk_preset_engine(dir, "c", "prompt_ab12cd34", presets);
  try {
    const [id_c, ns_c] = ident_ns(e);
    ((e.settings["prompt"] as unknown as Record<string, unknown>)["presets"] as
      Array<Record<string, unknown>>)[0]!["text"] = "Custom text!"; // one char
    const [id_c2, ns_c2] = ident_ns(e);
    assert.notEqual(id_c2, id_c, "editing the active custom text must fork the identity");
    assert.notEqual(ns_c2, ns_c, "editing the active custom text must fork the namespace");
    // delete the active custom -> dialog falls back to default (#39 D5)
    (e.settings["prompt"] as unknown as Record<string, unknown>)["presets"] = [];
    (e.settings["prompt"] as unknown as Record<string, unknown>)["active"] = "default";
    const [id_d, ns_d] = ident_ns(e);
    assert.notEqual(id_d, id_c2, "deleting the active custom must fork the identity");
    assert.notEqual(ns_d, ns_c2, "deleting the active custom must fork the namespace");
  } finally {
    stop(e);
  }
});

withTmp("snapshot carries the preset to the wire", async (dir) => {
  // The text that shaped the identity is the text put on the wire.
  const e = mk_preset_engine(dir, "w", "literal");
  try {
    const [prov, instr] = e._provider_snapshot();
    assert.equal(instr, S.LITERAL_PROMPT_TEXT);
    assert.equal(prov["system"], instr, "identity text and wire text must match");
    assert.equal(P.build_instructions(prov["system"], "", "", 0), instr);
  } finally {
    stop(e);
  }
});

// ---------------------------------------------------------------------------
// Testing Decision 2 - wire shape (client layer)
// ---------------------------------------------------------------------------

async function capture_wire(cur: string, prev = "", nxt = "", expected_lines = 0,
                            system = "PRESET TEXT",
                            protocol = "chat-completions"): Promise<[string, string]> {
  // Drive translate_group against a stubbed transport; return the (system,
  // user) pair exactly as it would go on the wire.
  const seen: Record<string, unknown>[] = [];
  const fake_post = async (
    _url: string, _headers: Record<string, string>, payload: unknown,
  ): Promise<P.PostResult> => {
    seen.push(payload as Record<string, unknown>);
    const body = ["1|ok", "2|ok"].join("\n");
    return { status: 200, headers: {},
             bodyText: JSON.stringify({ choices: [{ message: { content: body } }],
                                        output_text: body }) };
  };
  const cfg = { base_url: "https://api.example.test/v1", api_key: "k",
                model: "m", protocol, system };
  const r = await P.translate_group(cfg, cur, prev, nxt, expected_lines,
                                    { post: fake_post });
  assert.equal(r["error"], null, JSON.stringify(r));
  const payload = seen[seen.length - 1]!;
  if (protocol === "chat-completions") {
    const messages = payload["messages"] as { content: string }[];
    return [messages[0]!.content, messages[1]!.content];
  }
  const input = payload["input"] as { content: { text: string }[] }[];
  return [payload["instructions"] as string, input[0]!.content[0]!.text];
}

const NLINE_2 = "The input is one sentence split into 2 subtitle lines. Translate " +
  "the whole sentence, then output exactly 2 lines in format " +
  "'N|translation' (N=1..2) matching the original line breaks. No " +
  "other text.";
const PREV_LINE = "Previous line (context only, do not translate): ";
const NEXT_LINE = "Next line (context only, do not translate): ";

test("wire three segment order all four combos", async () => {
  // expected_lines 1/2 x context off/on: preset first, label lines in the
  // middle, N|line instruction last, no stray blank lines, and the user
  // message is always the pure current sentence. Protocol wording is pinned
  // verbatim - it feeds the cache identity.
  const cur = "current sentence here", prev = "previous neighbour", nxt = "next neighbour";

  // (expected_lines=1, context off) -> preset only
  const [sys1, user1] = await capture_wire(cur, "", "", 1);
  assert.equal(sys1, "PRESET TEXT");
  assert.equal(user1, cur);

  // (expected_lines=1, context on) -> preset + two label lines, no N|line
  const [sys2, user2] = await capture_wire(cur, prev, nxt, 1);
  assert.equal(sys2, "PRESET TEXT" + "\n" + PREV_LINE + prev + "\n" + NEXT_LINE + nxt);
  assert.equal(user2, cur);

  // (expected_lines=2, context off) -> preset + N|line instruction at the tail
  const [sys3, user3] = await capture_wire(cur, "", "", 2);
  assert.equal(sys3, "PRESET TEXT" + "\n" + NLINE_2);
  assert.equal(user3, cur);

  // (expected_lines=2, context on) -> all three segments in order
  const [sys4, user4] = await capture_wire(cur, prev, nxt, 2);
  assert.equal(sys4, "PRESET TEXT" + "\n" + PREV_LINE + prev + "\n" + NEXT_LINE + nxt +
               "\n" + NLINE_2);
  assert.equal(user4, cur);

  for (const s of [sys1, sys2, sys3, sys4]) {
    assert.ok(s.startsWith("PRESET TEXT"), "the preset must lead the system");
    assert.ok(!s.includes("\n\n"), "no stray blank lines in the assembled system");
  }
});

test("wire same shape on responses protocol", async () => {
  // The assembly is protocol-independent: byte-identical system and user.
  const cur = "current sentence here", prev = "previous neighbour";
  const [sys_r, user_r] = await capture_wire(cur, prev, "", 2, "PRESET TEXT", "responses");
  const [sys_c, user_c] = await capture_wire(cur, prev, "", 2);
  assert.equal(sys_r, sys_c);
  assert.equal(user_r, user_c);
  assert.equal(user_c, cur);
});

// ---------------------------------------------------------------------------
// Testing Decision 5 (non-UI half) - preview == production, ONE function
// ---------------------------------------------------------------------------

test("production goes through the single assembly function", async () => {
  // translate_group must call P.build_instructions (source scan - an ESM
  // binding cannot be spied), and for identical inputs the assembled system
  // is byte-identical to what the preview path produces by calling the same
  // function directly.
  const preview_out = P.build_instructions("PRESET X", "prev ctx", "next ctx", 2);
  const [wire_sys, wire_user] = await capture_wire("the current sentence", "prev ctx",
                                                   "next ctx", 2, "PRESET X");
  assert.equal(preview_out, wire_sys,
               "preview path and production must emit byte-identical systems");
  assert.equal(wire_user, "the current sentence");
  // File relocated to src/main with #205 (lib path is a re-export shim now).
  const src = fs.readFileSync(new URL("../src/main/provider.ts", import.meta.url), "utf8");
  assert.ok(/translate_group\([\s\S]*?build_instructions/.test(src.replace(/\r\n/g, "\n")) ||
            src.includes("build_instructions(cfg.system"),
            "translate_group must assemble through build_instructions");
});

function stop(e: Engine): void {
  (e._queue as unknown as { shutdown?: () => void }).shutdown?.();
  e._cache.close();
}
