// 1:1 port of desktop/tests/test_parse_parity.py (ticket #200, map #181).
// Cross-language parity for cue decoding: the browser userscript
// (userscript/youtubesub.user.js :: parseJson3), the desktop parser
// (desktop/suboverlay/protocol.py :: parse_json3) and this TS port
// (app/lib/protocol.ts) must agree exactly, otherwise the overlay renders
// cues at different times than the page. This file is the TS half; the
// Python half (desktop/tests/test_parse_parity.py) stays green until the
// Python retirement ticket, and userscript/tests/userscript.test.mjs holds
// the browser half (shared fixture per ticket #200 <-> #208 linkage).
// Registered behavior conversions (criteria #2):
//   - Python round(x, 3) is decimal half-even; Math.round(x*1000)/1000 is
//     used here. Fixture values carry at most 2 decimals and x*1000 is
//     exact in binary float, so no rounding midpoint can occur.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../lib/protocol.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, "..", "..", "userscript", "tests",
                               "fixtures", "parse_cases.json");

interface ParseCase {
  name: string;
  json3: unknown;
  expected: Array<{ start_ms: number; end_ms: number; text: string; last_off_ms: number }>;
}

const CASES: ParseCase[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

const norm_cues = (cues: P.Cue[]): Array<[number, number, string, number]> =>
  cues.map((c) => [round3(c.start_ms), round3(c.end_ms), c.text, round3(c.last_off_ms)]);

const norm_expected = (items: ParseCase["expected"]): Array<[number, number, string, number]> =>
  items.map((e) => [round3(e.start_ms), round3(e.end_ms), e.text, round3(e.last_off_ms)]);

for (const c of CASES) {
  test("parse_json3 matches shared fixture: " + c.name, () => {
    assert.deepEqual(norm_cues(P.parse_json3(c.json3)), norm_expected(c.expected));
  });
}

test("shared fixture is not trivially empty", () => {
  assert.ok(CASES.length >= 8);
  assert.ok(CASES.some((c) => c.expected.length > 0));
  assert.ok(CASES.some((c) => c.expected.length === 0));
});
