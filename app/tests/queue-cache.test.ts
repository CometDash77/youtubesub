// 1:1 port of the cache/queue assertions in desktop/tests/test_provider_and_queue.py
// (ticket #201, map #181). The provider-* tests in that pytest file belong to
// the provider ticket (#202) and the settings-redaction test to the settings
// ticket (#199); they are intentionally NOT here. Every cache/queue pytest
// test function maps to exactly one test() below; assertions are converted
// assertion-for-assertion (equivalence criteria #1, #191). Registered
// behavior conversions (criteria #2):
//   - pytest fixed time.sleep for completion states
//                                       -> waitFor polling (same asserted
//                                          states, CI-safe deadline); fixed
//                                          sleeps are KEPT where the
//                                          assertion means "still inside the
//                                          backoff window" (same margins).
//   - fake translate gates via time.sleep polling
//                                       -> promise gate (the event loop must
//                                          stay free; the worker awaits).
//   - q.stats()["inflight"]            -> q.stats().inflight.
//   - tempfile.mkdtemp + GC-closed sqlite conn
//                                       -> mkdtemp + explicit cache.close()
//                                          (Windows rmSync needs the handle
//                                          released before the dir removal).
// The cache_identity fixture block is Python ground truth (ticket #201): the
// identities in cache_identity_cases.json were produced by running
// desktop/suboverlay/queue_cache.py cache_identity - the TS port must hit the
// rows the Python build already wrote into data/translations.db, so the hash
// has to be byte-identical. Regenerate via .scratch/generate-identity-fixture.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Q from "../lib/queue-cache.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await sleep(stepMs);
  }
}

function withTmpDb(name: string, fn: (dbPath: string) => void | Promise<void>): void {
  test(name, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "queue-cache-ts-test-"));
    try {
      await fn(path.join(dir, "t.db"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Promise gate replacing the pytest "while gate["hold"]: time.sleep(0.01)"
// blocking loop - the result resolves once the gate opens.
function gateWait(gate: { hold: boolean }): Promise<void> {
  return waitFor(() => !gate.hold, 10000, 5);
}

// ---------------------------------------------------------------------
// cache_identity
// ---------------------------------------------------------------------

test("cache_identity excludes api_key and is stable", () => {
  const a = Q.cache_identity({ base_url: "u", model: "m", api_key: "SECRET-A" }, "k", "i", "p");
  const b = Q.cache_identity({ base_url: "u", model: "m", api_key: "SECRET-B" }, "k", "i", "p");
  assert.equal(a, b);
  assert.ok(!a.includes("SECRET"));
  const c = Q.cache_identity({ base_url: "u", model: "m2", api_key: "SECRET-A" }, "k", "i", "p");
  assert.notEqual(a, c);
  const d = Q.cache_identity({ base_url: "u", model: "m", protocol: "auto" }, "k", "i", "p");
  const e = Q.cache_identity({ model: "m", protocol: "auto", base_url: "u" }, "k", "i", "p");
  assert.equal(d, e); // key-order insensitive
});

test("cache_identity separates mock from real", () => {
  // Issue #31 (bug): the Mock translator echoes the original behind a label -
  // a different product from a real translation. Sharing one cache identity
  // made unchecking Mock serve the echo as the real translation, so "this run
  // was Mock" has to be a dimension of the identity.
  const real = Q.cache_identity({ base_url: "u", model: "m", mock: false }, "k", "i", "p");
  const mocked = Q.cache_identity({ base_url: "u", model: "m", mock: true }, "k", "i", "p");
  assert.notEqual(real, mocked, "a Mock product must not be addressable as the real one");
  // an absent mock key means "off": a plain config is a real config
  assert.equal(Q.cache_identity({ base_url: "u", model: "m" }, "k", "i", "p"), real);
  // and the API key still never enters the identity on either side
  assert.equal(
    Q.cache_identity({ base_url: "u", model: "m", mock: true, api_key: "SECRET-A" }, "k", "i", "p"),
    mocked);
  assert.equal(
    Q.cache_identity({ base_url: "u", model: "m", mock: true, api_key: "SECRET-B" }, "k", "i", "p"),
    mocked);
});

// Python ground truth for the identity scheme: the TS port must reproduce the
// exact sha256 the Python implementation computes (and wrote into the real
// data/translations.db rows), across CJK / emoji / control chars / U+2028 /
// quote-backslash / defaults. [补齐] beyond pytest: cross-stack parity.
interface IdentityCase {
  name: string;
  provider_cfg: Record<string, unknown> | null;
  client_key: string;
  instructions: string;
  prompt: string;
  expected: string;
}
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, "fixtures", "cache_identity_cases.json");
const IDENTITY_CASES: IdentityCase[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

for (const c of IDENTITY_CASES) {
  test("cache_identity matches Python fixture: " + c.name, () => {
    assert.equal(Q.cache_identity(c.provider_cfg, c.client_key, c.instructions, c.prompt),
                 c.expected);
  });
}

test("cache_identity fixture pair-equality groups hold", () => {
  // Same groups the pytest asserts pin: api-key-a == api-key-b (api_key
  // excluded), order-1 == order-2 (key-order insensitive), mock-on-key-a ==
  // mock-on-key-b, extra-keys == bare-for-extra, mock-off == mock-absent.
  const by = new Map(IDENTITY_CASES.map((c) => [c.name, c.expected]));
  assert.equal(by.get("api-key-a"), by.get("api-key-b"));
  assert.equal(by.get("order-1"), by.get("order-2"));
  assert.equal(by.get("mock-on-key-a"), by.get("mock-on-key-b"));
  assert.equal(by.get("extra-keys"), by.get("bare-for-extra"));
  assert.equal(by.get("mock-off"), by.get("mock-absent"));
  assert.notEqual(by.get("mock-off"), by.get("mock-on-key-a"));
  assert.notEqual(by.get("api-key-a"), by.get("model-m2"));
});

// ---------------------------------------------------------------------
// TranslationCache
// ---------------------------------------------------------------------

withTmpDb("translation cache roundtrip (pytest test_translation_cache_roundtrip_and_ttl)",
  (dbPath) => {
    const c = new Q.TranslationCache(dbPath);
    try {
      assert.equal(c.get("x"), null);
      c.put("x", { aligned: true, values: ["a"] });
      assert.deepEqual(c.get("x"), { aligned: true, values: ["a"] });
      c.put("x", { aligned: false, text: "b" });
      assert.equal(c.get("x")!["text"], "b");
    } finally {
      c.close();
    }
  });

// ---------------------------------------------------------------------
// TranslationQueue
// ---------------------------------------------------------------------

const mkJobs = (specs: Array<[string, number, number, string]>): Q.TranslationJob[] =>
  specs.map(([ident, pr, gi, text]) => new Q.TranslationJob(ident, pr, "s1", gi, text));

withTmpDb("queue priority, dedup and cancel-by-source (pytest test_queue_priority_dedup_and_cancel)",
  async (dbPath) => {
    const cache = new Q.TranslationCache(dbPath);
    const done: Array<[Q.TranslationJob, Q.TranslateResult]> = [];
    const gate = { hold: true };
    // spec #24: the seam takes a job LIST; length 1 = pre-batch behaviour.
    const fakeTranslate = (jobs: Q.TranslationJob[]): Promise<Q.TranslateResult[]> =>
      gateWait(gate).then(() => jobs.map((j) =>
        ({ aligned: false, text: "T:" + j.group_text, error: null })));

    const q = new Q.TranslationQueue({}, cache, 1,
      (j, r) => done.push([j, r]), fakeTranslate, 10);
    try {
      const jobs: Q.TranslationJob[] = [];
      for (let i = 0; i < 4; i++) {
        const pr = i === 0 ? Q.URGENT : Q.NORMAL;
        const j = new Q.TranslationJob("id" + i, pr, "s1", i, "text" + i);
        jobs.push(j);
        q.submit(j);
      }
      q.submit(new Q.TranslationJob("id0", Q.URGENT, "s1", 0, "text0")); // dedup no-op
      await waitFor(() => q.stats().inflight >= 1);
      assert.ok(q.stats().inflight <= 1);
      // cancel pending normals of s1, then release
      const n = q.cancel_source("s1");
      assert.equal(n, 3);
      gate.hold = false;
      await waitFor(() => done.length === 1);
      q.shutdown();
      assert.equal(done.length, 1);
      assert.equal(done[0]![1]["text"], "T:text0");
    } finally {
      q.shutdown();
      cache.close();
    }
  });

withTmpDb("queue sheds normal jobs under deep backoff (pytest test_queue_sheds_normal_under_backoff)",
  async (dbPath) => {
    const cache = new Q.TranslationCache(dbPath);
    const done: Q.TranslationJob[] = [];
    const fakeTranslate = (jobs: Q.TranslationJob[]): Q.TranslateResult[] =>
      jobs.map(() => ({ aligned: false, text: "T", error: null }));
    const q = new Q.TranslationQueue({}, cache, 1, (j) => done.push(j), fakeTranslate, 10);
    try {
      q.note_rate_limited(0.3);
      q.submit(new Q.TranslationJob("n1", Q.NORMAL, "s1", 1, "x"));
      await sleep(100);
      assert.equal(done.length, 0); // shed while in backoff
      await sleep(300);
      q.submit(new Q.TranslationJob("n2", Q.NORMAL, "s1", 2, "y"));
      await waitFor(() => done.length === 1);
      q.shutdown();
      assert.equal(done.length, 1);
    } finally {
      q.shutdown();
      cache.close();
    }
  });

withTmpDb("batch take drops cached and inflight, one survivor falls back "
          + "(pytest test_queue_batch_take_drops_cached_and_inflight_then_falls_back)",
  async (dbPath) => {
    // Decision 12: at take time a batch drops members that are already
    // cached or already in flight; what remains runs - >= 2 as ONE call,
    // exactly 1 falling back to the single path. A cached member is never
    // translated again.
    const cache = new Q.TranslationCache(dbPath);
    cache.put("idA", { aligned: false, text: "CA", error: null });
    const gate = { hold: true };
    const calls: string[][] = [];
    const fake = (jobs: Q.TranslationJob[]): Promise<Q.TranslateResult[]> => {
      calls.push(jobs.map((j) => j.identity));
      return gateWait(gate).then(() => jobs.map((j) =>
        ({ aligned: false, text: "T:" + j.group_text, error: null })));
    };

    const q = new Q.TranslationQueue({}, cache, 1, null, fake, 50);
    try {
      q.submit(new Q.TranslationJob("idB", Q.URGENT, "s1", 1, "b"));
      await waitFor(() => q.stats().inflight >= 1);
      assert.equal(q.stats().inflight, 1, "B must be in flight (blocked)");
      // A is cached, B is in flight: neither may reach the translator
      const accepted = q.submit_batch(mkJobs([["idA", Q.NORMAL, 0, "a"],
                                              ["idB", Q.NORMAL, 1, "b"],
                                              ["idC", Q.NORMAL, 2, "c"]]));
      assert.equal(accepted, true);
      gate.hold = false;
      await waitFor(() => calls.length >= 2);
      assert.deepEqual(calls, [["idB"], ["idC"]]);
      assert.ok(!calls[0]!.concat(calls[1]!).includes("idA"),
                "a cached member must be dropped, not re-translated");
      assert.equal(calls[1]!.length, 1, "one surviving member -> single path");
    } finally {
      q.shutdown();
      cache.close();
    }
  });

withTmpDb("batch runs as one call and dedups pending members "
          + "(pytest test_queue_batch_runs_as_one_call_and_dedups_pending_members)",
  async (dbPath) => {
    // Steady contract: >= 2 surviving members = exactly ONE translate call
    // carrying the whole batch; members already in flight are deduplicated -
    // never translated twice.
    const cache = new Q.TranslationCache(dbPath);
    const gate = { hold: true };
    const calls: string[][] = [];
    const fake = (jobs: Q.TranslationJob[]): Promise<Q.TranslateResult[]> => {
      calls.push(jobs.map((j) => j.identity));
      return gateWait(gate).then(() => jobs.map(() =>
        ({ aligned: false, text: "T", error: null })));
    };

    const q = new Q.TranslationQueue({}, cache, 1, null, fake, 50);
    try {
      assert.equal(q.submit_batch(mkJobs([["idX", Q.NORMAL, 0, "x"],
                                          ["idY", Q.NORMAL, 1, "y"]])), true);
      await waitFor(() => q.stats().inflight >= 2);
      assert.equal(q.stats().inflight, 2, "the whole batch must go out together");
      // X and Y are in flight now: resubmitting them must be a no-op.
      assert.equal(q.submit_batch(mkJobs([["idX", Q.NORMAL, 0, "x"],
                                          ["idY", Q.NORMAL, 1, "y"]])), false);
      gate.hold = false;
      await waitFor(() => calls.length >= 1);
      q.shutdown();
      assert.deepEqual(calls, [["idX", "idY"]],
                       "exactly one call for the whole batch, nothing else");
    } finally {
      q.shutdown();
      cache.close();
    }
  });

withTmpDb("batches shed under deep backoff but urgent is never shed "
          + "(pytest test_batches_shed_under_deep_backoff_but_urgent_is_never_shed)",
  async (dbPath) => {
    // US20 + decision 14: batches are NORMAL priority, so deep backoff
    // (rate limiting) sheds them - while URGENT, the sentence on screen,
    // always goes through. Rate limiting cuts prefetch, never the visible
    // line.
    const cache = new Q.TranslationCache(dbPath);
    const calls: string[][] = [];
    const done: Q.TranslationJob[] = [];
    const fake = (jobs: Q.TranslationJob[]): Q.TranslateResult[] => {
      calls.push(jobs.map((j) => j.identity));
      return jobs.map(() => ({ aligned: false, text: "T", error: null }));
    };

    const q = new Q.TranslationQueue({}, cache, 1, (j) => done.push(j), fake, 50);
    try {
      q.note_rate_limited(0.4);
      assert.equal(q.submit_batch(mkJobs([["idN1", Q.NORMAL, 1, "n1"],
                                          ["idN2", Q.NORMAL, 2, "n2"]])), true);
      q.submit(new Q.TranslationJob("idU", Q.URGENT, "s1", 0, "u"));
      await sleep(200); // still inside the backoff window
      assert.deepEqual(calls, [["idU"]],
                       "URGENT must pass through deep backoff; batch must be shed");
      await sleep(400); // backoff over - the shed batch never comes back
      assert.deepEqual(calls, [["idU"]], "a shed batch must not resurrect itself");
      assert.deepEqual(done.map((j) => j.identity), ["idU"]);
      assert.equal(q.in_backoff(), false);
    } finally {
      q.shutdown();
      cache.close();
    }
  });
