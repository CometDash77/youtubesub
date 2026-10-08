// Continuation of the desktop/tests/test_engine.py port (ticket #203,
// map #181) - see engine.test.ts for the shared conversion notes; the split
// across two files is purely mechanical (node --test discovers both).
// The CI hang run 37730730854 adaptations (withTmp error-preserving cleanup
// with rmSync EBUSY retries, wait budgets 5s -> 15s, runner flags in
// package.json) are registered in the engine.test.ts header too.
// This file: issue #31 identity/namespace, /status authority, segmentation
// inputs, identity forks, prefetch scheduling (spec #24) and the display
// contract (#151 方案 A).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine, resolve_workers } from "../lib/engine.ts";
import type { EngineSource } from "../lib/engine.ts";
import * as Q from "../lib/queue-cache.ts";
import * as S from "../lib/settings.ts";
import * as P from "../lib/provider.ts";

const CFG_URL = "https://api.example.test/v1";
const CFG_MODEL = "test-model";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function withTmp(name: string, fn: (dir: string) => void | Promise<void>): void {
  test(name, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "engine-ts-test-"));
    // Cleanup must never mask the body's real error (CI run 37730730854: a
    // wait timeout surfaced as a misleading EBUSY from this rmSync) and must
    // ride out Windows locks on a handle not yet released (per #201).
    let failure: unknown;
    try {
      await fn(dir);
    } catch (e) {
      failure = e;
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch {
        // The dir is per-test throwaway; a stubborn lock is not a verdict.
      }
    }
    if (failure !== undefined) throw failure;
  });
}

function stop(e: Engine): void {
  (e._queue as unknown as { shutdown?: () => void }).shutdown?.();
  e._cache.close();
}

interface MkOpts {
  mock?: boolean;
  base_url?: string;
  model?: string;
  db?: string;
  workers?: number;
  translate_fn?: Q.TranslateFn;
  translateGroup?: typeof P.translate_group;
}

function mk_engine(dir: string, o: MkOpts = {}): Engine {
  const s = S.default_settings();
  const prov = s["provider"] as unknown as Record<string, unknown>;
  prov["mock"] = o.mock ?? true;
  prov["base_url"] = o.base_url ?? "";
  prov["model"] = o.model ?? "";
  if (o.base_url) prov["api_key"] = "sk-test";
  const cache = new Q.TranslationCache(o.db ?? path.join(dir, "t.db"));
  return new Engine(s, cache, o.workers ?? 2, o.translate_fn,
                    o.translateGroup ? { translateGroup: o.translateGroup } : undefined);
}

async function wait_trans(e: Engine, want?: (d: Record<string, unknown>) => boolean,
                          // 15s: cold CI disks ran these polls 9s+; 5s fired
                          // once (run 37730730854) and manufactured a failure.
                          timeout = 15000): Promise<Record<string, unknown>> {
  const ok = want ?? ((d: Record<string, unknown>) => Boolean(d["trans"]));
  const deadline = Date.now() + timeout;
  let d = e.tick() as Record<string, unknown>;
  while (Date.now() < deadline && !ok(d)) {
    await sleep(20);
    d = e.tick() as Record<string, unknown>;
  }
  return d;
}

const JSON3 = { events: [
  { tStartMs: 1000, dDurationMs: 3000,
    segs: [{ utf8: "the cat ", tOffsetMs: 500 }, { utf8: "sat", tOffsetMs: 900 }] },
  { tStartMs: 2000, dDurationMs: 3000,
    segs: [{ utf8: "the cat sat down", tOffsetMs: 1500 }] },
  { tStartMs: 5000, dDurationMs: 2000,
    segs: [{ utf8: "next thought", tOffsetMs: 5100 }] },
] };

// A single cue and nothing after it: with prefetch decoupled (#38) an exact
// translate-call count can only come from having no lookahead groups.
const ONE_GROUP = { events: [
  { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: "hello there friend" }] },
] };

function zh_cues(lines: string[]): Array<Record<string, unknown>> {
  return lines.map((t, i) => ({ start_ms: i * 1100.0, end_ms: i * 1100.0 + 1000.0, text: t }));
}

const ZH3 = ["这是一行比较长的字幕", "另一行同样很长的字", "第三行也相当的长啊"];
const ZH5 = [...ZH3, "第四行继续写长一点呢", "第五行还是那么长啊嘿"];

class RecordingQueue {
  jobs: Q.TranslationJob[] = [];
  batches: Q.TranslationJob[][] = [];
  cancelled_sources: string[] = [];

  submit(job: Q.TranslationJob): boolean {
    this.jobs.push(job);
    return true;
  }

  submit_batch(jobs: Q.TranslationJob[]): boolean {
    this.batches.push([...jobs]);
    this.jobs.push(...jobs);
    return true;
  }

  in_backoff(): boolean {
    return false;
  }

  cancel_source(source_id: string): number {
    this.cancelled_sources.push(source_id);
    return 0;
  }
}

function swap_recording(e: Engine): { real: Engine["_queue"]; rec: RecordingQueue } {
  const real = e._queue;
  const rec = new RecordingQueue();
  e._queue = rec;
  (real as unknown as { shutdown?: () => void }).shutdown?.();
  return { real, rec };
}

function flat_groups(src: EngineSource): Array<[number, number]> {
  return src.groups.map(g => [g.start_idx, g.end_idx]);
}

async function wait_for(pred: () => boolean, timeout = 15000,
                        tick?: () => void): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return true;
    if (tick !== undefined) tick();
    await sleep(20);
  }
  return false;
}

// ---- issue #31: mock vs real identity / namespace -------------------------

withTmp("mock echo is never served as a real translation", async (dir) => {
  const calls: string[] = [];
  const fake: typeof P.translate_group = async (cfg, text) => {
    void cfg;
    calls.push(text);
    return { aligned: false, text: "REAL:" + text, error: null };
  };
  const db = path.join(dir, "t.db");

  const e1 = mk_engine(dir, { mock: true, base_url: CFG_URL, model: CFG_MODEL, db,
                              translateGroup: fake });
  const s = e1.settings;
  e1.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  e1.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                    playing: true, playback_rate: 1.0, timestamp: Date.now() });
  const d = await wait_trans(e1);
  assert.ok(String(d["trans"]).startsWith("\u3010\u8bd1\u3011"),
            "Mock is the verification stand-in");
  assert.deepEqual(calls, [], "Mock must not touch the provider");
  stop(e1);

  // the user unchecks Mock in Settings and comes back to the same sentence
  (s["provider"] as unknown as Record<string, unknown>)["mock"] = false;
  const e2 = new Engine(s, new Q.TranslationCache(db), 2, undefined,
                        { translateGroup: fake });
  e2.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  e2.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                    playing: true, playback_rate: 1.0, timestamp: Date.now() });
  const d2 = await wait_trans(e2);
  assert.ok(!String(d2["trans"]).startsWith("\u3010\u8bd1\u3011"),
            "the cached Mock echo was served as a real translation");
  assert.ok(String(d2["trans"]).startsWith("REAL:"), String(d2["trans"]));
  assert.ok(calls.length > 0, "unchecking Mock must issue a real request");
  const real = d2["trans"];
  const n_calls = calls.length;
  stop(e2);

  // the real translation keeps its own cache behaviour: same sentence, no wire
  const e3 = new Engine(s, new Q.TranslationCache(db), 2, undefined,
                        { translateGroup: fake });
  e3.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  e3.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                    playing: true, playback_rate: 1.0, timestamp: Date.now() });
  assert.equal((await wait_trans(e3))["trans"], real,
               "a real translation must still hit the cache");
  assert.equal(calls.length, n_calls, "a cache hit must not reach the provider again");
  stop(e3);
});

withTmp("pure mock translation is still cached", async (dir) => {
  const db = path.join(dir, "t.db");
  const calls: string[] = [];
  let def: ((jobs: Q.TranslationJob[]) => Q.TranslateResult[] |
            Promise<Q.TranslateResult[]>) | null = null;

  const counting = (jobs: Q.TranslationJob[]): Q.TranslateResult[] | Promise<Q.TranslateResult[]> => {
    calls.push(...jobs.map(j => j.identity));
    return def!(jobs); // the real Mock translator (job list)
  };

  const run = async (): Promise<Record<string, unknown>> => {
    // no base_url, no model: pure Mock; one group and no following group.
    const e = mk_engine(dir, { mock: true, db, translate_fn: counting });
    def = (jobs) => e._default_translate(jobs);
    e.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, ONE_GROUP);
    e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                     playing: true, playback_rate: 1.0, timestamp: Date.now() });
    const d = await wait_trans(e);
    stop(e);
    return d;
  };

  assert.ok(String((await run())["trans"]).startsWith("\u3010\u8bd1\u3011"),
            "Mock is still the stand-in");
  assert.equal(calls.length, 1, "the first run must actually translate");
  assert.ok(String((await run())["trans"]).startsWith("\u3010\u8bd1\u3011"),
            "same sentence, second engine + same db");
  assert.equal(calls.length, 1, "pure Mock must still be served from the cache");
});

withTmp("turning mock off retranslates the current sentence", async (dir) => {
  const calls: string[] = [];
  const fake: typeof P.translate_group = async (cfg, text) => {
    void cfg;
    calls.push(text);
    return { aligned: false, text: "REAL:" + text, error: null };
  };
  const e = mk_engine(dir, { mock: true, base_url: CFG_URL, model: CFG_MODEL,
                             translateGroup: fake });
  const s = e.settings;
  e.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                   playing: true, playback_rate: 1.0, timestamp: Date.now() });
  assert.ok(String((await wait_trans(e))["trans"]).startsWith("\u3010\u8bd1\u3011"));

  (s["provider"] as unknown as Record<string, unknown>)["mock"] = false;
  const d = await wait_trans(e, (x) => String(x["trans"]).startsWith("REAL:"));
  assert.ok(String(d["trans"]).startsWith("REAL:"), "the same sentence must be re-requested");
  assert.ok(calls.length > 0, "a real request must have been made");
  stop(e);
});

withTmp("a queued job uses the provider its identity was computed from", async (dir) => {
  const e = mk_engine(dir, { mock: true, base_url: CFG_URL, model: CFG_MODEL });
  const s = e.settings;
  const job = new Q.TranslationJob("id", Q.URGENT, "s1", 0, "hello", "", "", 0,
                                   new Q.ProviderContext(
                                     { ...(s["provider"] as unknown as Record<string, unknown>) }, "ns"));
  (s["provider"] as unknown as Record<string, unknown>)["mock"] = false;
  const r = (await e._default_translate([job]))[0]!; // the seam takes a job list (#24)
  assert.equal(r["text"], "\u3010\u8bd1\u3011hello",
               "the worker must translate with the provider its identity describes");
  // a job submitted without a snapshot falls back to live settings
  const prov = s["provider"] as unknown as Record<string, unknown>;
  prov["base_url"] = "";
  prov["model"] = "";
  const bare = new Q.TranslationJob("bare", Q.URGENT, "s1", 0, "hello");
  assert.equal((await e._default_translate([bare]))[0]!["error"], "NOT_CONFIGURED",
               "the fallback must read live settings, not the job's old snapshot");
  stop(e);
});

withTmp("system prompt from settings reaches the provider", async (dir) => {
  const captured: Record<string, unknown>[] = [];
  const fake: typeof P.translate_group = async (cfg) => {
    captured.push({ ...cfg });
    return { aligned: false, text: "T", error: null };
  };
  const e = mk_engine(dir, { mock: false, base_url: CFG_URL, model: CFG_MODEL,
                             translateGroup: fake });
  const prompt = e.settings["prompt"] as unknown as Record<string, unknown>;
  prompt["presets"] = [{ id: "prompt_cafe0000", name: "Form", text: "CUSTOM PROMPT LINE" }];
  prompt["active"] = "prompt_cafe0000";
  e.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                   playing: true, playback_rate: 1.0, timestamp: Date.now() });
  const d = await wait_trans(e);
  assert.equal(d["trans"], "T");
  assert.ok(captured.length > 0, "the real provider path must have been taken");
  assert.equal(captured[0]!["system"], "CUSTOM PROMPT LINE",
               "the form prompt must reach the wire, not just the cache identity");
  stop(e);
});

withTmp("a result from the previous provider namespace is dropped", async (dir) => {
  const s = S.default_settings();
  const prov = s["provider"] as unknown as Record<string, unknown>;
  prov["base_url"] = CFG_URL;
  prov["api_key"] = "sk-test";
  prov["model"] = CFG_MODEL;
  prov["mock"] = true;
  const e = new Engine(s, new Q.TranslationCache(path.join(dir, "t.db")), 2,
                       async (jobs) => jobs.map(() => ({ error: "STUB" })));
  e.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                   playing: true, playback_rate: 1.0, timestamp: Date.now() });
  e.tick(); // stamps the Mock namespace and submits this group
  const src = e.sources["s1"]!;
  const gi = src.last_group_idx;
  assert.ok(gi !== null && e._provider_ns, "a tick must have established the namespace");
  const stale = new Q.TranslationJob("stale", Q.URGENT, "s1", gi!, "x", "", "", 0,
                                     new Q.ProviderContext({ ...prov }, "OLD-NS"));
  e._on_done(stale, { aligned: false, text: "OLD", error: null } as Q.TranslateResult);
  assert.ok(!src.group_trans[gi!], "the old namespace's result must be dropped");
  const fresh = new Q.TranslationJob("fresh", Q.URGENT, "s1", gi!, "x", "", "", 0,
                                     new Q.ProviderContext({ ...prov }, e._provider_ns!));
  e._on_done(fresh, { aligned: false, text: "REAL", error: null } as Q.TranslateResult);
  assert.equal(src.group_trans[gi!], "REAL", "the current namespace must still land");
  stop(e);
});

// ---- /status authority + segmentation inputs ------------------------------

withTmp("unconfigured provider never fabricates a translation", async (dir) => {
  const s = S.default_settings();
  const prov = s["provider"] as unknown as Record<string, unknown>;
  assert.equal(prov["base_url"], "");
  assert.equal(prov["model"], "");
  assert.ok(!prov["mock"], "mock must be off unless the user turns it on");
  const e = new Engine(s, new Q.TranslationCache(path.join(dir, "t.db")), 2);
  e.ingest_json3("s1", { video_id: "v1", track_kind: "asr", tab_title: "T" }, JSON3);
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                   playing: true, playback_rate: 1.0, timestamp: Date.now() });
  const deadline = Date.now() + 800;
  let d = e.tick() as Record<string, unknown>;
  while (Date.now() < deadline) {
    d = e.tick() as Record<string, unknown>;
    await sleep(50);
  }
  assert.equal(d["state"], "ok");
  assert.ok(String(d["orig"]).startsWith("the cat"), "the original must still be shown");
  assert.equal(d["trans"], "", "an unconfigured provider must not produce a translation");
  stop(e);
});

withTmp("engine reports whether a translation is possible at all", async (dir) => {
  const display_with = async (provider_update: Record<string, unknown>) => {
    const s = S.default_settings();
    Object.assign(s["provider"] as unknown as Record<string, unknown>, provider_update);
    // stub translator: this test is about the flag, never about the wire
    const e = new Engine(s, new Q.TranslationCache(path.join(dir, "t.db")), 1,
                         async (jobs) => jobs.map(() => ({ aligned: false, text: "", error: "STUB" })));
    e.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
    e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                     playing: true, playback_rate: 1.0, timestamp: Date.now() });
    const d = e.tick() as Record<string, unknown>;
    stop(e);
    return d;
  };

  assert.equal((await display_with({}))["trans_available"], false);
  assert.equal((await display_with({ mock: true }))["trans_available"], true);
  assert.equal((await display_with({ base_url: "https://api.example.test/v1",
                                     model: "test-model" }))["trans_available"], true);
});

withTmp("status always carries a translation authority", async (dir) => {
  const s = S.default_settings();
  const e = new Engine(s, new Q.TranslationCache(path.join(dir, "t.db")), 1);
  assert.equal(e.last_display, null);
  assert.equal((e.status()["display"] as Record<string, unknown>)["trans_available"], false);
  (s["provider"] as unknown as Record<string, unknown>)["mock"] = true;
  assert.equal((e.status()["display"] as Record<string, unknown>)["trans_available"], true);
  // the no_cues display state carries it too
  e.handle_event({ type: "register", source_id: "s1", video_id: "v1", tab_title: "T" });
  const d = e.tick() as Record<string, unknown>;
  assert.equal(d["state"], "no_cues");
  assert.equal(d["trans_available"], true);
  assert.equal((e.status()["display"] as Record<string, unknown>)["trans_available"], true);
  stop(e);
});

withTmp("track language from register frame reaches segmentation", async (dir) => {
  const e = mk_engine(dir);
  e.handle_event({ type: "register", source_id: "s1", video_id: "v1",
                   track_kind: "manual", track_lang: "zh" });
  e.handle_event({ type: "cues", source_id: "s1", video_id: "v1", cues: zh_cues(ZH3) });
  assert.deepEqual(flat_groups(e.sources["s1"]!), [[0, 0], [1, 1], [2, 2]]);
  stop(e);
});

withTmp("track language from the cues frame selects the branch", async (dir) => {
  const e = mk_engine(dir);
  e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                   track_kind: "manual", track_lang: "zh", cues: zh_cues(ZH3) });
  assert.deepEqual(flat_groups(e.sources["s1"]!), [[0, 0], [1, 1], [2, 2]]);
  stop(e);
});

withTmp("missing track language defaults to space criteria", async (dir) => {
  const e = mk_engine(dir);
  e.handle_event({ type: "cues", source_id: "s1", video_id: "v1", cues: zh_cues(ZH3) });
  assert.deepEqual(flat_groups(e.sources["s1"]!), [[0, 2]]);
  stop(e);
});

withTmp("non-speech cue gets no translation and group ranges stay contiguous", async (dir) => {
  const e = mk_engine(dir);
  e.ingest_json3("s1", { video_id: "v1", track_kind: "manual", track_lang: "en" },
                 { events: [
                     { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "spoken one line" }] },
                     { tStartMs: 1100, dDurationMs: 1000, segs: [{ utf8: "spoken two line" }] },
                     { tStartMs: 2200, dDurationMs: 800, segs: [{ utf8: "[Music]" }] },
                     { tStartMs: 3300, dDurationMs: 1000, segs: [{ utf8: "spoken three line" }] }] });
  const src = e.sources["s1"]!;
  assert.equal(src.cues.length, 4);
  assert.deepEqual(flat_groups(src), [[0, 1], [3, 3]]);
  assert.deepEqual(src.cue_to_group, { 0: 0, 1: 0, 3: 1 });
  // group0 goes out with expected lines == cues in the group
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 500.0,
                   playing: true, playback_rate: 1.0, timestamp: Date.now() });
  const d = await wait_trans(e);
  assert.ok(d["trans"], "the speech group must still be translated");
  assert.ok(src.cues[0]!.trans && src.cues[1]!.trans, "row count == group cues");
  assert.equal(src.cues[2]!.trans, "", "the non-speech cue must get no translation");
  // at the music's own time: original text, no translation
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 2500.0,
                   playing: true, playback_rate: 1.0, timestamp: Date.now() });
  const d2 = e.tick() as Record<string, unknown>;
  assert.equal(d2["state"], "ok");
  assert.equal(d2["orig"], "[Music]");
  assert.equal(d2["trans"], "");
  // prefetch walks the dense group list across the gap
  assert.ok(await wait_for(() => 1 in src.group_trans, 5000, () => { e.tick(); }),
            "prefetch must cross the non-speech gap");
  stop(e);
});

withTmp("track kind does not change the criteria", async (dir) => {
  const e = mk_engine(dir);
  const groups_by_kind: Record<string, Array<[number, number, string]>> = {};
  for (const kind of ["manual", "asr"]) {
    e.ingest_json3("k-" + kind, { video_id: "v1", track_kind: kind, track_lang: "en" }, JSON3);
    groups_by_kind[kind] = e.sources["k-" + kind]!.groups
      .map(g => [g.start_idx, g.end_idx, g.text] as [number, number, string]);
  }
  assert.deepEqual(groups_by_kind["manual"], groups_by_kind["asr"]);
  assert.ok(groups_by_kind["manual"]!.length > 0, "the shared criteria still group something");
  stop(e);
});

// ---- identity & prefetch scheduling (#38 / ADR-009, spec #24) --------------

withTmp("identity forks on context and is byte-identical when unchanged", async (dir) => {
  const e = mk_engine(dir);
  e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                   track_kind: "manual", track_lang: "ja", cues: zh_cues(ZH3) });
  const src = e.sources["s1"]!;
  assert.deepEqual(flat_groups(src), [[0, 0], [1, 1], [2, 2]]);
  const { real, rec } = swap_recording(e);
  try {
    // (1) the prompt switch alone forks the identity
    (e.settings["prompt"] as unknown as Record<string, unknown>)["context_groups"] = 1;
    e._submit_group(src, 1, Q.URGENT);
    const id_on = rec.jobs[rec.jobs.length - 1]!.identity;
    (e.settings["prompt"] as unknown as Record<string, unknown>)["context_groups"] = 0;
    e._submit_group(src, 1, Q.URGENT);
    const id_off = rec.jobs[rec.jobs.length - 1]!.identity;
    assert.notEqual(id_on, id_off, "context on vs off must produce different identities");

    // (2) neighbour original text changed (rest identical) -> identity forks
    (e.settings["prompt"] as unknown as Record<string, unknown>)["context_groups"] = 1;
    src.groups[0]!.text += "\u6539"; // prev neighbour
    e._submit_group(src, 1, Q.URGENT);
    const id_prev = rec.jobs[rec.jobs.length - 1]!.identity;
    assert.notEqual(id_prev, id_on, "prev neighbour text must fork the identity");
    src.groups[2]!.text += "\u6539"; // next neighbour
    e._submit_group(src, 1, Q.URGENT);
    const id_next = rec.jobs[rec.jobs.length - 1]!.identity;
    assert.notEqual(id_next, id_prev, "next neighbour text must fork the identity");

    // (3) unchanged inputs -> byte-identical identity across submissions
    e._submit_group(src, 1, Q.URGENT);
    const again = rec.jobs[rec.jobs.length - 1]!.identity;
    assert.equal(again, id_next,
                 "same group, same neighbours: identity must be byte-identical");
  } finally {
    e._queue = real;
    stop(e);
  }
});

withTmp("prefetch submission set does not follow the context switch", async (dir) => {
  // #38 / ADR-009 - prefetch is scheduling, not prompting.
  const submitted = async (context_groups: number):
      Promise<[Array<[number, number]>, string[]]> => {
    const e = mk_engine(dir, { db: path.join(dir, "pf" + context_groups + ".db") });
    (e.settings["prompt"] as unknown as Record<string, unknown>)["context_groups"] = context_groups;
    e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                     track_kind: "manual", track_lang: "ja", cues: zh_cues(ZH5) });
    assert.equal(e.sources["s1"]!.groups.length, 5, "one group per no-space-language line");
    const { real, rec } = swap_recording(e);
    try {
      e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 100.0,
                       playing: true, playback_rate: 1.0, timestamp: Date.now() });
      const d = e.tick() as Record<string, unknown>;
      assert.equal(d["state"], "ok");
      assert.equal(d["orig"], ZH5[0]);
    } finally {
      e._queue = real;
      stop(e);
    }
    return [rec.jobs.map(j => [j.group_idx, j.priority] as [number, number]),
            rec.jobs.map(j => j.identity)];
  };

  const [on, ids_on] = await submitted(1);
  const [off, ids_off] = await submitted(0);
  const want: Array<[number, number]> = [[0, Q.URGENT],
    [1, Q.NORMAL], [2, Q.NORMAL], [3, Q.NORMAL], [4, Q.NORMAL]];
  assert.deepEqual(on, want, "context on: current URGENT + 4 lookahead NORMAL");
  assert.deepEqual(off, want, "context off must not gate the prefetch");
  assert.notDeepEqual(ids_on, ids_off,
                      "identities still differ - the switch only shapes the prompt");
});

// ---- spec #24: prefetch window (seconds), fill chunking, debounce ----------

function sentence_cues(count: number, gap_ms: number, chars = 0, prefix = "Line"):
    Array<Record<string, unknown>> {
  // One sentence-final cue per group: every text ends with a period, which
  // fires the sentence-final criterion, so count cues produce count groups.
  const tail = chars > 0 ? "W".repeat(chars) : "";
  return Array.from({ length: count }, (_, i) => ({
    start_ms: i * gap_ms, end_ms: i * gap_ms + gap_ms - 50.0,
    text: tail + prefix + " " + i + " ends here.",
  }));
}

function sync_at(e: Engine, sid: string, ms: number, playing = true): void {
  e.handle_event({ type: "sync", source_id: sid, video_time_ms: ms,
                   playing, playback_rate: 1.0, timestamp: Date.now() });
}

function recorded_fill(e: Engine, cues: Array<Record<string, unknown>>, t_ms: number):
    [Q.TranslationJob[], Q.TranslationJob[][]] {
  // ONE tick against a RecordingQueue: the submission shape is observed at
  // the queue boundary, so no worker can reorder anything first.
  e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                   track_kind: "manual", track_lang: "en", cues });
  sync_at(e, "s1", t_ms, true);
  const real_q = e._queue;
  const rec = new RecordingQueue();
  e._queue = rec;
  try {
    const d = e.tick() as Record<string, unknown>;
    assert.equal(d["state"], "ok");
  } finally {
    e._queue = real_q;
    (real_q as Q.TranslationQueue).shutdown();
  }
  return [rec.jobs, rec.batches];
}

function recording_engine(dir: string, o: MkOpts = {}):
    { e: Engine; calls: Q.TranslationJob[][] } {
  // Engine whose translate seam records every job LIST, then runs the real
  // Mock translator (the widened #24 seam).
  const calls: Q.TranslationJob[][] = [];
  let def: ((jobs: Q.TranslationJob[]) => Q.TranslateResult[] |
            Promise<Q.TranslateResult[]>) | null = null;
  const rec = (jobs: Q.TranslationJob[]): Q.TranslateResult[] | Promise<Q.TranslateResult[]> => {
    calls.push([...jobs]);
    return def!(jobs);
  };
  const e = mk_engine(dir, { ...o, translate_fn: rec });
  def = (jobs) => e._default_translate(jobs);
  return { e, calls };
}

withTmp("prefetch window is measured in seconds", async (dir) => {
  // US1: the lead is 90 SECONDS of video time, whatever the subtitle density.
  const e = mk_engine(dir);
  const [jobs] = recorded_fill(e, sentence_cues(6, 30000), 0);
  const got = jobs.map(j => j.group_idx);
  assert.deepEqual(got, [0, 1, 2, 3], "window = playhead + 90s, got " + JSON.stringify(got));
  stop(e);
});

withTmp("prefetch window group cap truncates dense subtitles", async (dir) => {
  // US2: the hard group cap bounds a dense window before the seconds do.
  const e = mk_engine(dir);
  const [jobs] = recorded_fill(e, sentence_cues(100, 200), 0);
  const got = jobs.map(j => j.group_idx);
  assert.equal(got.length, 20, "cap must truncate the submission to 20, got " + got.length);
  assert.deepEqual(got, Array.from({ length: 20 }, (_, i) => i));
  stop(e);
});

withTmp("steady state cross submits exactly one group", async (dir) => {
  // US3 + US11: the window advances with playback; crossing into the next
  // group submits ONLY the one group the advancing window just swept in.
  const { e, calls } = recording_engine(dir);
  // Groups every 2400ms: crossing the boundary is a plain progress step
  // (< the 2500ms seek threshold); the 20-group cap binds before 90s.
  e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                   track_kind: "manual", track_lang: "en",
                   cues: sentence_cues(30, 2400) });
  sync_at(e, "s1", 0, true);
  e.tick();
  // burst fill: current URGENT + groups 1..19 (cap-bounded window)
  assert.ok(await wait_for(
    () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
      .every(i => i in e.sources["s1"]!.group_trans), 5000, () => { e.tick(); }),
    "the first window must fill");
  const burst_calls = calls.length;
  // cross into group 1: the window slides by one - exactly one new group (20)
  sync_at(e, "s1", 2400, true);
  e.tick();
  assert.ok(await wait_for(() => 20 in e.sources["s1"]!.group_trans, 5000, () => { e.tick(); }),
            "the advancing window must sweep in group 20");
  const new_calls = calls.slice(burst_calls);
  const flat = new_calls.flatMap(c => c.map(j => j.group_idx));
  assert.deepEqual(flat, [20], "a steady cross submits exactly one group: " + JSON.stringify(flat));
  assert.equal(new_calls[new_calls.length - 1]!.length, 1,
               "steady state must stay one-request-per-group");
  const seen = calls.flatMap(c => c.map(j => j.group_idx));
  assert.equal(seen.length, new Set(seen).size,
               "a finished group must never be submitted twice: " + JSON.stringify(seen));
  stop(e);
});

withTmp("seek debounces the window refill but never the urgent path", async (dir) => {
  // US4 + US5 + decisions 2/3/4: the WINDOW refill is silenced for the
  // debounce; URGENT goes out immediately; in-flight is never interrupted.
  const gate = { hold: true };
  const calls: Q.TranslationJob[][] = [];
  let def: ((jobs: Q.TranslationJob[]) => Q.TranslateResult[] |
            Promise<Q.TranslateResult[]>) | null = null;
  const rec = async (jobs: Q.TranslationJob[]): Promise<Q.TranslateResult[]> => {
    calls.push([...jobs]); // record on entry, before blocking
    while (gate.hold) await sleep(10);
    return def!(jobs);
  };
  const e = mk_engine(dir, { workers: 4, translate_fn: rec });
  def = (jobs) => e._default_translate(jobs);
  e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                   track_kind: "manual", track_lang: "en",
                   cues: sentence_cues(10, 30000) });
  sync_at(e, "s1", 0, true);
  e.tick(); // burst fill: urgent(0) + batch(1,2,3) - workers now blocked
  assert.ok(await wait_for(() => calls.length >= 2), "the first window must be submitted");

  const seek_wall = Date.now();
  sync_at(e, "s1", 180000, true); // jump 180s, far beyond 2500ms
  e.tick();
  assert.ok(await wait_for(
    () => calls.some(c => c.some(j => j.group_idx === 6))),
    "URGENT at the seek target must go out immediately (never debounced)");
  assert.ok(Date.now() - seek_wall < 400,
            "the urgent path must not wait out the debounce");

  // still inside the quiet period: no window refill may happen
  e.tick();
  await sleep(150);
  e.tick();
  const early = new Set(calls.flatMap(c => c.map(j => j.group_idx)));
  assert.ok(![7, 8, 9].some(i => early.has(i)),
            "the window must stay silent during the debounce");

  // quiet period over: the refill lands (US5 - immediately on the next tick)
  assert.ok(await wait_for(() => Date.now() - seek_wall > 450, 2000));
  e.tick();
  assert.ok(await wait_for(
    () => [7, 8, 9].every(i => calls.some(c => c.some(j => j.group_idx === i)))),
    "the window must refill right after the quiet period");

  // in-flight is never interrupted (decision 4)
  gate.hold = false;
  assert.ok(await wait_for(() => 0 in e.sources["s1"]!.group_trans, 5000, () => { e.tick(); }),
            "an in-flight request must survive the seek and still land");
  stop(e);
});

withTmp("paused playback starts no prefetch", async (dir) => {
  // US6: paused, the on-screen sentence may still be requested, but no NEW
  // prefetch leaves the queue.
  const { e, calls } = recording_engine(dir);
  e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                   track_kind: "manual", track_lang: "en",
                   cues: sentence_cues(6, 30000) });
  sync_at(e, "s1", 0, false);
  const deadline = Date.now() + 400;
  while (Date.now() < deadline) {
    e.tick();
    await sleep(20);
  }
  const submitted = calls.flatMap(c => c.map(j => j.group_idx));
  assert.ok(submitted.every(i => i === 0),
            "paused playback must not prefetch: " + JSON.stringify(submitted));
  // playing again: the window fills
  sync_at(e, "s1", 0, true);
  e.tick();
  assert.ok(await wait_for(
    () => [1, 2, 3].every(i => calls.some(c => c.some(j => j.group_idx === i))), 5000,
    () => { e.tick(); }), "resuming playback must fill the window");
  stop(e);
});

withTmp("context switch off does not gate prefetch", async (dir) => {
  // US17: prompt.context_groups only shapes the prompt.
  const { e, calls } = recording_engine(dir);
  (e.settings["prompt"] as unknown as Record<string, unknown>)["context_groups"] = 0;
  e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                   track_kind: "manual", track_lang: "en",
                   cues: sentence_cues(6, 30000) });
  sync_at(e, "s1", 0, true);
  e.tick();
  assert.ok(await wait_for(() => 1 in e.sources["s1"]!.group_trans, 5000, () => { e.tick(); }),
            "prefetch must run with the context switch off");
  const prefetched = calls.flatMap(c => c).filter(j => j.group_idx !== 0);
  assert.ok(prefetched.length > 0, "the window must have submitted ahead groups");
  assert.ok(prefetched.every(j => j.prev === "" && j.nxt === ""),
            "context off must still shape the prompt (no neighbour context)");
  stop(e);
});

withTmp("fill chunks respect both caps", async (dir) => {
  // US10 + decision 5: at the burst point the pending groups are chunked.
  // (a) group cap binds
  const e = mk_engine(dir);
  const [jobs, batches] = recorded_fill(e, sentence_cues(30, 200), 0);
  assert.deepEqual(jobs.map(j => j.group_idx), Array.from({ length: 20 }, (_, i) => i));
  const pending = jobs.slice(1);
  assert.equal(batches.length, Math.ceil(pending.length / 8),
               "batch count must be ceil(groups / batch.max_groups)");
  for (const b of batches) {
    assert.ok(b.length >= 2 && b.length <= 8, "every batch must respect the group cap");
    const chars = b.reduce((a, j) => a + j.group_text.length + j.prev.length + j.nxt.length, 0);
    assert.ok(chars <= 8000, "every batch must respect the char cap");
  }
  stop(e);

  // (b) char cap binds: group 0 goes URGENT alone; the four pending
  // ~3017-char groups chunk 2+2 under the 8000-char budget.
  const e2 = mk_engine(dir, { db: path.join(dir, "b.db") });
  (e2.settings["prompt"] as unknown as Record<string, unknown>)["context_groups"] = 0;
  const [, batches2] = recorded_fill(e2, sentence_cues(5, 2000, 3000), 0);
  assert.deepEqual(batches2.map(b => b.length), [2, 2],
                   "3001*2 = 6002 <= 8000 but 3001*3 > 8000: the char cap must split 2+2");
  for (const b of batches2) {
    assert.ok(b.reduce((a, j) => a + j.group_text.length, 0) <= 8000);
  }
  stop(e2);
});

withTmp("batch failure voids the batch and urgent recovers", async (dir) => {
  // US12-14 + decision 9: a failed batch writes NOTHING, and the playhead
  // reaching a member later re-translates it through the urgent single path
  // under the byte-identical identity the batch job carried (decision 11).
  const calls: Q.TranslationJob[][] = [];
  let def: ((jobs: Q.TranslationJob[]) => Q.TranslateResult[] |
            Promise<Q.TranslateResult[]>) | null = null;
  const fail_batches = (jobs: Q.TranslationJob[]):
      Q.TranslateResult[] | Promise<Q.TranslateResult[]> => {
    calls.push([...jobs]);
    if (jobs.length > 1) {
      return jobs.map(() => ({ aligned: false, text: "", error: "SHAPE_MISS",
                               message: "contract miss" }));
    }
    return def!(jobs);
  };
  const e = mk_engine(dir, { translate_fn: fail_batches });
  def = (jobs) => e._default_translate(jobs);
  e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                   track_kind: "manual", track_lang: "en",
                   cues: sentence_cues(6, 30000) });
  sync_at(e, "s1", 0, true);
  e.tick();
  assert.ok(await wait_for(() => calls.some(c => c.length > 1)), "the fill must batch");
  const batch_jobs = calls.find(c => c.length > 1)!;
  assert.ok(await wait_for(() => {
    const st = (e._queue as Q.TranslationQueue).stats();
    return st.pending === 0 && st.inflight === 0;
  }, 5000, () => { e.tick(); }), "the failed batch must finish (it writes nothing)");
  const src = e.sources["s1"]!;
  // group 0 went out URGENT (single path, succeeded); the batch members must
  // have landed NOTHING - no translation, no placeholder.
  assert.ok([1, 2, 3].every(i => !(i in src.group_trans)),
            "a failed batch must not land anything");
  assert.ok([1, 2, 3].every(i => !src.cues[i]!.trans),
            "no placeholders may be left behind");
  for (const j of batch_jobs) {
    assert.equal(e._cache.get(j.identity), null, "a failed batch must not write the cache");
  }
  // playhead reaches group 1: the urgent single path recovers it
  sync_at(e, "s1", 30050, true);
  e.tick();
  assert.ok(await wait_for(() => 1 in src.group_trans, 5000, () => { e.tick(); }),
            "the urgent path must re-translate what the batch dropped");
  const member = batch_jobs.find(j => j.group_idx === 1)!;
  assert.notEqual(e._cache.get(member.identity), null,
                  "the urgent result lands under the SAME identity the batch job carried");
  stop(e);
});

withTmp("batch then single hits the same cache", async (dir) => {
  // US15 + US23 + decisions 10/11: a batch-translated group is cached under
  // its single-path identity; a fresh engine serves it with zero calls.
  const db = path.join(dir, "t.db");
  // 4 groups: the first fill covers ALL of them.
  const e1 = mk_engine(dir, { db });
  e1.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                    track_kind: "manual", track_lang: "en",
                    cues: sentence_cues(4, 30000) });
  sync_at(e1, "s1", 0, true);
  e1.tick();
  assert.ok(await wait_for(
    () => [1, 2, 3].every(i => i in e1.sources["s1"]!.group_trans), 5000,
    () => { e1.tick(); }), "the first window must fill (through a batch)");
  stop(e1);

  // second engine, same cache, same settings: playhead INSIDE group 1
  const { e: e2, calls } = recording_engine(dir, { db });
  e2.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                    track_kind: "manual", track_lang: "en",
                    cues: sentence_cues(4, 30000) });
  sync_at(e2, "s1", 30050, true);
  e2.tick();
  assert.ok(await wait_for(() => 1 in e2.sources["s1"]!.group_trans, 5000,
                           () => { e2.tick(); }),
            "the batch-cached translation must be served to the new session");
  assert.deepEqual(calls, [], "a cache hit must not produce any translate call");
  stop(e2);
});

withTmp("worker pool reads max concurrent with clamp", async (dir) => {
  // US21 + decision 13: the Engine worker pool is provider.max_concurrent
  // clamped to [1, 16], default 5 (restart-effective, read at construction).
  assert.equal(resolve_workers({}), 5);
  assert.equal(resolve_workers({ provider: {} }), 5);
  assert.equal(resolve_workers({ provider: { max_concurrent: 1 } }), 1);
  assert.equal(resolve_workers({ provider: { max_concurrent: 16 } }), 16);
  assert.equal(resolve_workers({ provider: { max_concurrent: 0 } }), 1);    // clamp low
  assert.equal(resolve_workers({ provider: { max_concurrent: 99 } }), 16);  // clamp high
  assert.equal(resolve_workers({ provider: { max_concurrent: "x" } }), 5);
  assert.equal(resolve_workers({ provider: { max_concurrent: null } }), 5);
  const s = S.default_settings();
  const prov = s["provider"] as unknown as Record<string, unknown>;
  prov["mock"] = true;
  prov["max_concurrent"] = 3;
  const e = new Engine(s, new Q.TranslationCache(path.join(dir, "w.db")));
  assert.equal(e._workers, 3);
  assert.equal((e._queue as Q.TranslationQueue).worker_count, 3,
               "the pool must be built from the configured limit");
  stop(e);
});

withTmp("switching away drops the old sources pending prefetch", async (dir) => {
  // US9: the old source's PENDING fill is dropped on takeover; the request
  // already in flight still lands (decision 4).
  const gate = { hold: true };
  const calls: Q.TranslationJob[][] = [];
  let def: ((jobs: Q.TranslationJob[]) => Q.TranslateResult[] |
            Promise<Q.TranslateResult[]>) | null = null;
  const rec = async (jobs: Q.TranslationJob[]): Promise<Q.TranslateResult[]> => {
    calls.push([...jobs]);
    while (gate.hold) await sleep(10);
    return def!(jobs);
  };
  const e = mk_engine(dir, { workers: 1, translate_fn: rec });
  def = (jobs) => e._default_translate(jobs);
  e.handle_event({ type: "cues", source_id: "old", video_id: "vA",
                   track_kind: "manual", track_lang: "en",
                   cues: sentence_cues(6, 30000) });
  sync_at(e, "old", 0, true);
  e.tick(); // workers=1: urgent(old, 0) runs and blocks; batch(old, 1..3) PENDS
  assert.ok(await wait_for(() => calls.length === 1), "the urgent job must be in flight");

  // another video takes over: the old source's pending fill is dropped
  e.handle_event({ type: "register", source_id: "new", video_id: "vB",
                   track_kind: "manual" });
  assert.equal(e.active_source, "new");
  gate.hold = false;
  assert.ok(await wait_for(() => {
    const st = (e._queue as Q.TranslationQueue).stats();
    return st.pending === 0 && st.inflight === 0;
  }, 5000, () => { e.tick(); }), "the old pending fill must be cancelled, not run");
  assert.ok(e.sources["old"]!.group_trans[0] !== undefined,
            "the in-flight request must still land (never interrupted)");
  assert.equal(calls.length, 1,
    "the old source's pending window fill must never be paid for: " +
    JSON.stringify(calls.map(c => c.map(j => j.group_idx))));
  stop(e);
});

// ---- original-only mode edges (#61) ---------------------------------------

withTmp("original only blocks all scheduling and translation mode starts at playhead",
        async (dir) => {
  const e = mk_engine(dir);
  const { real, rec } = swap_recording(e);
  try {
    (e.settings["display"] as unknown as Record<string, unknown>)["mode"] = "orig";
    e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                     track_kind: "manual", track_lang: "en",
                     cues: sentence_cues(8, 2000) });
    sync_at(e, "s1", 5000, true); // current sentence is group 2

    const display = e.tick() as Record<string, unknown>;
    assert.equal(display["trans_state"], "idle");
    // (length checks: deepEqual's asserts-signature would narrow the arrays)
    assert.equal(rec.jobs.length, 0);
    assert.equal(rec.batches.length, 0,
                 "original-only must not submit urgent, prefetch, or batch work");

    // Enabling translation starts at the live playhead; earlier groups stay
    // untouched.
    (e.settings["display"] as unknown as Record<string, unknown>)["mode"] = "bilingual";
    const display2 = e.tick() as Record<string, unknown>;
    assert.equal(display2["trans_state"], "translating");
    assert.deepEqual(rec.jobs.map(j => [j.group_idx, j.priority]),
                     [[2, Q.URGENT], [3, Q.NORMAL], [4, Q.NORMAL], [5, Q.NORMAL],
                      [6, Q.NORMAL], [7, Q.NORMAL]]);
    assert.ok(rec.jobs.every(j => j.group_idx >= 2),
              "switching modes must not backfill already-played groups");

    const submitted = rec.jobs.length;
    (e.settings["display"] as unknown as Record<string, unknown>)["mode"] = "orig";
    const display3 = e.tick() as Record<string, unknown>;
    assert.equal(display3["trans_state"], "idle");
    assert.equal(rec.jobs.length, submitted);
    assert.equal(rec.cancelled_sources[rec.cancelled_sources.length - 1], "s1");
  } finally {
    e._queue = real;
    stop(e);
  }
});

withTmp("original only transition preserves inflight and cancels pending", async (dir) => {
  const gate = { hold: true };
  const calls: Q.TranslationJob[][] = [];
  let def: ((jobs: Q.TranslationJob[]) => Q.TranslateResult[] |
            Promise<Q.TranslateResult[]>) | null = null;
  const rec = async (jobs: Q.TranslationJob[]): Promise<Q.TranslateResult[]> => {
    calls.push([...jobs]);
    while (gate.hold) await sleep(10);
    return def!(jobs);
  };
  const e = mk_engine(dir, { workers: 1, translate_fn: rec });
  def = (jobs) => e._default_translate(jobs);
  e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                   track_kind: "manual", track_lang: "en",
                   cues: sentence_cues(8, 2000) });
  sync_at(e, "s1", 5000, true);
  e.tick();
  assert.ok(await wait_for(() => calls.length === 1),
            "current urgent request must be in flight");
  assert.ok((e._queue as Q.TranslationQueue).stats().pending > 0,
            "the lookahead must be pending behind urgent");

  (e.settings["display"] as unknown as Record<string, unknown>)["mode"] = "orig";
  const display = e.tick() as Record<string, unknown>;
  assert.equal(display["trans_state"], "idle");
  assert.equal((e._queue as Q.TranslationQueue).stats().inflight, 1,
               "mode switch must never interrupt the in-flight request");
  gate.hold = false;
  assert.ok(await wait_for(() => {
    const st = (e._queue as Q.TranslationQueue).stats();
    return st.pending === 0 && st.inflight === 0;
  }, 5000, () => { e.tick(); }), "the in-flight translation must be allowed to finish");
  assert.ok(e.sources["s1"]!.group_trans[2] !== undefined,
            "an in-flight result remains useful and may populate the translation model");
  assert.equal(calls.length, 1, "no queued prefetch batch may start after the mode switch");
  stop(e);
});

withTmp("prefetch failure callback cannot resubmit after original only switch", async (dir) => {
  const e = mk_engine(dir);
  const { real, rec } = swap_recording(e);
  try {
    e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                     track_kind: "manual", track_lang: "en",
                     cues: sentence_cues(5, 2000) });
    sync_at(e, "s1", 500, true);
    e.tick(); // group 1 is submitted as NORMAL while group 0 is current
    const prefetched = rec.jobs.find(j => j.group_idx === 1 && j.priority === Q.NORMAL)!;

    sync_at(e, "s1", 2500, true);
    e.tick(); // group 1 becomes current while its prefetch is conceptually in flight
    assert.equal(e.sources["s1"]!.last_group_idx, 1);
    const submitted = rec.jobs.length;

    // This is the race window: mode changes before the next tick sees the edge.
    (e.settings["display"] as unknown as Record<string, unknown>)["mode"] = "orig";
    e._on_done(prefetched, { error: "NETWORK" } as Q.TranslateResult);
    assert.equal(rec.jobs.length, submitted,
      "a prefetch failure callback must not start an urgent retry after the mode switch");
  } finally {
    e._queue = real;
    stop(e);
  }
});

// ---- display contract (#151 方案 A / map #149) ----------------------------

function display_contract_engine(dir: string): { e: Engine; real: Engine["_queue"];
                                                  rec: RecordingQueue; src: EngineSource } {
  const e = mk_engine(dir);
  const { real, rec } = swap_recording(e);
  e.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  const src = e.sources["s1"]!;
  // Fixture self-check: JSON3's three repaired cues must be one group (0, 2).
  assert.deepEqual(flat_groups(src), [[0, 2]]);
  return { e, real, rec, src };
}

withTmp("display contract: aligned result shows only current cue translation", async (dir) => {
  // Contract #1: an aligned result lives cue-by-cue in cue.trans.
  const { e, real, rec } = display_contract_engine(dir);
  try {
    sync_at(e, "s1", 1500);
    e.tick();
    const job = rec.jobs[0]!; // URGENT, group 0
    e._on_done(job, { aligned: true, values: ["译甲", "译乙", "译丙"], error: null } as Q.TranslateResult);
    for (const [t_ms, want] of [[1500.0, "译甲"], [3000.0, "译乙"], [6000.0, "译丙"]] as const) {
      sync_at(e, "s1", t_ms);
      const d = e.tick() as Record<string, unknown>;
      assert.equal(d["trans"], want, t_ms + " -> " + d["trans"]);
      assert.notEqual(d["trans"], "译甲 译乙 译丙"); // whole-group leak canary
      assert.equal((e.status()["display"] as Record<string, unknown>)["trans"], want,
                   "/status shares the seam");
    }
    assert.equal(rec.jobs.length, 1); // display never produces per-cue requests
  } finally {
    e._queue = real;
    stop(e);
  }
});

withTmp("display contract: unaligned result shows whole text only on group first cue",
        async (dir) => {
  // Contract #2 + #5: a whole-line result renders only on the group's first
  // cue, and landing it clears stale per-cue residue.
  const { e, real, rec, src } = display_contract_engine(dir);
  try {
    sync_at(e, "s1", 1500);
    e.tick();
    const job = rec.jobs[0]!; // URGENT, group 0
    src.cues[1]!.trans = "陈旧值"; // stale per-cue residue from an older aligned result
    e._on_done(job, { aligned: false, text: "整组译文", error: null } as Q.TranslateResult);

    const d = e.tick() as Record<string, unknown>; // still at 1500: first cue
    assert.equal(d["trans"], "整组译文");
    assert.equal(d["trans_state"], "ready");
    assert.equal(src.cues[1]!.trans, "", "mutual exclusion: the stale cue value must be cleared");

    sync_at(e, "s1", 3000); // a group-member cue
    const d2 = e.tick() as Record<string, unknown>;
    assert.equal(d2["trans"], "");
    assert.equal(d2["trans_state"], "ready");

    sync_at(e, "s1", 1500); // seek back: same rule through the single seam
    const d3 = e.tick() as Record<string, unknown>;
    assert.equal(d3["trans"], "整组译文");

    sync_at(e, "s1", 6000);
    const d4 = e.tick() as Record<string, unknown>;
    assert.equal(d4["trans"], "");
  } finally {
    e._queue = real;
    stop(e);
  }
});

withTmp("display contract: cached unaligned result follows same cue rule", async (dir) => {
  // Contract #4: a cache hit lands through the same _on_done seam, with
  // zero provider work.
  const db = path.join(dir, "t.db");
  const e1 = mk_engine(dir, { mock: false, base_url: CFG_URL, model: CFG_MODEL, db,
                              translate_fn: async (jobs) => jobs.map(() =>
                                ({ aligned: false, text: "整组译文", error: null })) });
  e1.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  sync_at(e1, "s1", 1500);
  const d = await wait_trans(e1);
  assert.equal(d["trans"], "整组译文");
  stop(e1);

  const calls: number[] = [];
  const e2 = mk_engine(dir, { mock: false, base_url: CFG_URL, model: CFG_MODEL, db,
                              translate_fn: async (jobs) => {
                                calls.push(1);
                                return jobs.map(() => ({ error: "STUB" }));
                              } });
  e2.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  sync_at(e2, "s1", 1500);
  const d2 = await wait_trans(e2);
  assert.equal(d2["trans"], "整组译文"); // cache hit renders through the same seam
  assert.deepEqual(calls, []);           // a cache hit does zero provider work

  sync_at(e2, "s1", 3000); // group-member cue
  assert.equal((e2.tick() as Record<string, unknown>)["trans"], "");
  sync_at(e2, "s1", 1500); // back to the group's first cue
  assert.equal((e2.tick() as Record<string, unknown>)["trans"], "整组译文");
  stop(e2);
});

withTmp("display contract: failed group shows no translation on any cue", async (dir) => {
  // Contract #3: the verdict stays the whitelisted failed:<reason> (#64)
  // with the sticky semantics (#65).
  const e = mk_engine(dir);
  const { real, rec } = swap_recording(e);
  e.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  sync_at(e, "s1", 1500);
  e.tick();
  const job = rec.jobs[0]!;
  e._on_done(job, { error: "RATE_LIMITED", status: 429,
                    message: "provider text must not leak" } as Q.TranslateResult);

  const d = e.tick() as Record<string, unknown>;
  assert.equal(d["trans"], "");
  assert.equal(d["trans_state"], "failed:请求受限");

  sync_at(e, "s1", 3000);
  const d2 = e.tick() as Record<string, unknown>;
  assert.equal(d2["trans"], "");
  assert.equal(d2["trans_state"], "failed:请求受限");

  sync_at(e, "s1", 1500); // seek back: verdict persists on every cue
  const d3 = e.tick() as Record<string, unknown>;
  assert.equal(d3["trans"], "");
  assert.equal(d3["trans_state"], "failed:请求受限");
  e._queue = real;
  stop(e);
});

withTmp("display contract: aligned result drops the whole group representation",
        async (dir) => {
  // Contract #5 (gap A): one representation per group at any moment.
  const { e, real, rec, src } = display_contract_engine(dir);
  try {
    sync_at(e, "s1", 1500);
    e.tick();
    const job = rec.jobs[0]!; // URGENT, group 0
    // first landing: a whole-line result (contract #2 baseline)
    e._on_done(job, { aligned: false, text: "整组译文", error: null } as Q.TranslateResult);
    assert.ok(0 in src.group_trans);
    const d = e.tick() as Record<string, unknown>;
    assert.equal(d["trans"], "整组译文");
    sync_at(e, "s1", 3000);
    assert.equal((e.tick() as Record<string, unknown>)["trans"], "");
    sync_at(e, "s1", 6000);
    assert.equal((e.tick() as Record<string, unknown>)["trans"], "");
    // second landing: an aligned result takes over the same group
    e._on_done(job, { aligned: true, values: ["译甲", "译乙", "译丙"], error: null } as Q.TranslateResult);
    assert.ok(!(0 in src.group_trans),
              "contract #5: the whole-group representation must be gone after an aligned landing");
    for (const [t_ms, want] of [[1500.0, "译甲"], [3000.0, "译乙"], [6000.0, "译丙"]] as const) {
      sync_at(e, "s1", t_ms);
      const d2 = e.tick() as Record<string, unknown>;
      assert.equal(d2["trans"], want, t_ms + " -> " + d2["trans"]);
      assert.notEqual(d2["trans"], "整组译文", t_ms + " -> " + d2["trans"]);
      assert.ok(!String(d2["trans"]).includes("整组译文"), t_ms + " -> " + d2["trans"]);
    }
  } finally {
    e._queue = real;
    stop(e);
  }
});

withTmp("display contract: failure after aligned result clears every cue", async (dir) => {
  // Contract #3 (gap B, aligned values): the verdict clears the visible
  // aligned result - trans == "" and failed:<reason> on every cue.
  const { e, real, rec } = display_contract_engine(dir);
  try {
    sync_at(e, "s1", 1500);
    e.tick();
    const job = rec.jobs[0]!; // URGENT, group 0
    e._on_done(job, { aligned: true, values: ["译甲", "译乙", "译丙"], error: null } as Q.TranslateResult);
    for (const [t_ms, want] of [[1500.0, "译甲"], [3000.0, "译乙"], [6000.0, "译丙"]] as const) {
      sync_at(e, "s1", t_ms);
      assert.equal((e.tick() as Record<string, unknown>)["trans"], want,
                   t_ms + " (sanity: values were visible)");
    }
    // the same group's URGENT job fails (the existing URGENT-job pattern)
    e._on_done(job, { error: "RATE_LIMITED", status: 429,
                      message: "provider text must not leak" } as Q.TranslateResult);
    for (const t_ms of [1500.0, 3000.0, 6000.0, 1500.0]) { // incl. seek back replay
      sync_at(e, "s1", t_ms);
      const d = e.tick() as Record<string, unknown>;
      assert.equal(d["trans"], "", t_ms + " -> " + d["trans"]);
      assert.equal(d["trans_state"], "failed:请求受限", t_ms + " -> " + d["trans_state"]);
    }
  } finally {
    e._queue = real;
    stop(e);
  }
});

withTmp("display contract: failure after whole line result clears group", async (dir) => {
  // Contract #3 (gap B, whole-line value): a URGENT failure after an
  // unaligned landing must clear the stored group text too.
  const { e, real, rec, src } = display_contract_engine(dir);
  try {
    sync_at(e, "s1", 1500);
    e.tick();
    const job = rec.jobs[0]!; // URGENT, group 0
    e._on_done(job, { aligned: false, text: "整组译文", error: null } as Q.TranslateResult);
    assert.equal((e.tick() as Record<string, unknown>)["trans"], "整组译文",
                 "sanity: the group text was visible");
    // the same group's URGENT job fails
    e._on_done(job, { error: "RATE_LIMITED", status: 429,
                      message: "provider text must not leak" } as Q.TranslateResult);
    assert.ok(!(0 in src.group_trans),
              "contract #3: a failed group keeps no stored translation");
    for (const t_ms of [1500.0, 3000.0, 6000.0, 1500.0]) { // incl. seek back replay
      sync_at(e, "s1", t_ms);
      const d = e.tick() as Record<string, unknown>;
      assert.equal(d["trans"], "", t_ms + " -> " + d["trans"]);
      assert.equal(d["trans_state"], "failed:请求受限", t_ms + " -> " + d["trans_state"]);
    }
  } finally {
    e._queue = real;
    stop(e);
  }
});
