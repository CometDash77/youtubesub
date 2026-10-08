// 1:1 port of desktop/tests/test_engine.py (ticket #203, map #181). Every
// pytest test function maps to exactly one test() below (the two
// parametrized functions expand to one test() per case); assertions are
// converted assertion-for-assertion (equivalence criteria #1, #191).
// Registered behavior conversions (criteria #2):
//   - worker THREADS + time.sleep gating -> the #201 async queue; fixed
//     sleeps are KEPT where the assertion means "still inside the window"
//     (same margins) and completion states are waitFor-polled.
//   - RecordingQueue attribute swap (e._queue = RecordingQueue()) -> the
//     same field swap against the EngineQueue structural seam.
//   - monkeypatch.setattr(P, "translate_group", fake) -> Engine constructor
//     deps.translateGroup injection (ESM bindings cannot be patched); the
//     default stays the real provider function (same-path invariant).
//   - job.priority mutation (test sets a submitted job to NORMAL) -> a cast;
//     TranslationJob keeps Python's mutable field semantics at runtime.
//   - len(e._queue._threads) -> TranslationQueue.worker_count (added in
//     ticket #203; same observable: the pool size actually built).
//   - sqlite3.connect(db) row count -> node:sqlite DatabaseSync.
//   - GC-closed sqlite connections -> explicit cache.close() before the
//     tmpdir removal (Windows rmSync needs handles released, per #201).
//   - CI hang run 37730730854 adaptations: withTmp cleanup rethrows the
//     body's error after best-effort rmSync (EBUSY retried) so cleanup
//     never masks the real failure; wait budgets 5s -> 15s. Runner level
//     (package.json): --test-concurrency=1 (4-way concurrent spawns left
//     whole files unexecuted on that run), --test-force-exit and
//     --test-timeout=60000 (a leaked worker timer / stalled test can no
//     longer hang the step).
//   - lambda jobs: ... -> sync arrow functions (the queue accepts both).
//   - time.time() in sync events -> Date.now(); wall-clock assertions keep
//     the Python margins (< 0.4s urgent, > 0.45s debounce).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine, resolve_workers } from "../lib/engine.ts";
import type { EngineQueue, EngineSource } from "../lib/engine.ts";
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

// Shut the queue (when it has one) and release the cache handle.
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
  // An engine over a SQLite cache in dir. Mock on *and* a real endpoint
  // configured is the overlap issue #31 is about. The settings dict belongs
  // to that engine, so a test can edit it in place like the dialog does.
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
  // Tick until the display satisfies want (default: any translation arrives).
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
  // One cue per line, every line >5 chars: the zh quality gate keeps each
  // line its own group, so neighbour positions are deterministic (#38).
  return lines.map((t, i) => ({ start_ms: i * 1100.0, end_ms: i * 1100.0 + 1000.0, text: t }));
}

const ZH3 = ["这是一行比较长的字幕", "另一行同样很长的字", "第三行也相当的长啊"];
const ZH5 = [...ZH3, "第四行继续写长一点呢", "第五行还是那么长啊嘿"];

class RecordingQueue implements EngineQueue {
  // Stand-in for TranslationQueue that records every submitted job and runs
  // nothing - scheduling tests assert the exact submitted set without
  // workers racing results back in (#38). Batch members are recorded
  // individually, in order (#24).
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
    return false; // never in backoff: a refill must never be deferred here
  }

  cancel_source(source_id: string): number {
    this.cancelled_sources.push(source_id);
    return 0; // nothing runs here, so nothing is pending to cancel
  }
}

function swap_recording(e: Engine): { real: EngineQueue; rec: RecordingQueue } {
  const real = e._queue;
  const rec = new RecordingQueue();
  e._queue = rec;
  (real as Q.TranslationQueue).shutdown();
  return { real, rec };
}

function flat_groups(src: EngineSource): Array<[number, number]> {
  return src.groups.map(g => [g.start_idx, g.end_idx]);
}

// ---- Chinese-source pre-skip (#128) --------------------------------------

withTmp("chinese tracks skip translation with provider on or off", async (dir) => {
  const tracks: Array<[string, string[]]> = [
    ["zh-Hans", ["这是一段简体中文字幕", "再来一行简体字幕", "第三行简体字幕"]],
    ["zh-Hant-TW", ["這是一段繁體中文字幕", "再來一行繁體字幕", "第三行繁體字幕"]],
  ];
  for (const provider_on of [false, true]) {
    for (const display_mode of ["bilingual", "orig"]) {
      for (const [track_lang, lines] of tracks) {
        const db = path.join(dir, "provider-" + provider_on + "-" + display_mode + "-" + track_lang + ".db");
        const translated_calls: Q.TranslationJob[][] = [];
        const e = mk_engine(dir, {
          mock: false,
          base_url: provider_on ? CFG_URL : "",
          model: provider_on ? CFG_MODEL : "",
          db,
          translate_fn: async (jobs) => { translated_calls.push(jobs); return []; },
        });
        (e.settings["display"] as unknown as Record<string, unknown>)["mode"] = display_mode;
        const { real, rec } = swap_recording(e);
        void real;
        e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                         track_lang, cues: zh_cues(lines) });
        e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 500.0,
                         playing: true, playback_rate: 1.0, timestamp: Date.now() });

        const display = e.tick() as Record<string, unknown>;
        const src = e.sources["s1"]!;
        assert.equal(display["orig"], lines[0]);
        assert.equal(display["trans"], "");
        assert.equal(display["trans_state"], "idle");
        assert.equal(display["trans_available"], provider_on);
        assert.deepEqual(rec.jobs, []);
        assert.deepEqual(rec.batches, []);
        assert.deepEqual(translated_calls, []);
        assert.deepEqual(new Set(Object.values(src.group_states)), new Set(["idle"]));
        assert.deepEqual(src.group_failures, {});
        const con = new DatabaseSync(db);
        const row = con.prepare("SELECT COUNT(*) AS n FROM translations").get() as { n: number };
        con.close();
        assert.equal(row.n, 0);
        stop(e);
      }
    }
  }
});

const CJK_CASES: Array<[string, boolean]> = [
  ["中中文ABCDEFG", true],       // 3/10 letters: exactly the agreed threshold
  ["中文ABCDEF", false],         // 2/8 letters: below the threshold
  ["中文ABC", true],             // Chinese-English mixed line above threshold
  ["今日は学校へ行く", false],   // Japanese Kana keeps CJK-only fallback conservative
  ["ｶﾀｶﾅ", false],               // halfwidth Katakana is also Japanese
  ["中中文ｶﾀﾅ", false],           // Kana exclusion wins despite >=30% Han
  ["ﾻﾾ", false],                 // halfwidth Hangul is not Chinese
  ["中文ﾻ", false],               // Hangul exclusion wins despite >=30% Han
  ["한국어 자막", false],        // Korean is not mistaken for Chinese
  ["ordinary English", false],
];

for (const [text, should_skip] of CJK_CASES) {
  withTmp("missing track language uses local CJK ratio fallback: " + JSON.stringify(text),
          async (dir) => {
    const e = mk_engine(dir, { mock: true });
    swap_recording(e);
    e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                     cues: zh_cues([text]) });
    e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 500.0,
                     playing: false, playback_rate: 1.0, timestamp: Date.now() });

    const display = e.tick() as Record<string, unknown>;
    assert.equal(display["orig"], text);
    if (should_skip) {
      assert.equal(display["trans_state"], "idle");
      assert.deepEqual((e._queue as RecordingQueue).jobs, []);
      assert.deepEqual(e.sources["s1"]!.group_states, { 0: "idle" });
    } else {
      assert.equal(display["trans_state"], "translating");
      const jobs = (e._queue as RecordingQueue).jobs;
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]!.group_text, text);
    }
    stop(e);
  });
}

withTmp("declared non-Chinese language overrides CJK text", async (dir) => {
  const e = mk_engine(dir, { mock: true });
  swap_recording(e);
  e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                   track_lang: "en", cues: zh_cues(["中文ABC"]) });
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 500.0,
                   playing: false, playback_rate: 1.0, timestamp: Date.now() });

  const display = e.tick() as Record<string, unknown>;
  assert.equal(display["trans_state"], "translating");
  assert.equal((e._queue as RecordingQueue).jobs.length, 1);
  stop(e);
});

for (const result of [
  { text: "late English translation", error: null },
  { text: "", error: "RATE_LIMITED", status: 429 },
]) {
  withTmp("inflight result from previous track does not translate new Chinese track: " +
          JSON.stringify(result), async (dir) => {
    const e = mk_engine(dir, { mock: true });
    swap_recording(e);
    e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                     track_lang: "en", cues: zh_cues(["hello there friend"]) });
    e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 500.0,
                     playing: false, playback_rate: 1.0, timestamp: Date.now() });
    assert.equal((e.tick() as Record<string, unknown>)["trans_state"], "translating");
    const old_job = (e._queue as RecordingQueue).jobs[0]!;

    e.handle_event({ type: "cues", source_id: "s1", video_id: "v1",
                     track_lang: "zh-Hans", cues: zh_cues(["这是一段中文原文"]) });
    e._on_done(old_job, result as Q.TranslateResult);

    const display = e.tick() as Record<string, unknown>;
    const src = e.sources["s1"]!;
    assert.equal(display["orig"], "这是一段中文原文");
    assert.equal(display["trans"], "");
    assert.equal(display["trans_state"], "idle");
    assert.deepEqual(src.group_trans, {});
    assert.deepEqual(src.group_states, { 0: "idle" });
    assert.deepEqual(src.group_failures, {});
    stop(e);
  });
}

// ---- pipeline / trans_state ----------------------------------------------

withTmp("engine full pipeline with mock translation", async (dir) => {
  const e = mk_engine(dir);
  e.ingest_json3("s1", { video_id: "v1", track_kind: "asr", tab_title: "T" }, JSON3);
  const src = e.sources["s1"]!;
  assert.equal(src.cues.length, 3);
  assert.ok(src.groups.length >= 1);
  // play at t=1500ms -> first group urgent
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                   playing: true, playback_rate: 1.0, timestamp: Date.now() });
  let d = e.tick() as Record<string, unknown>;
  assert.equal(d["state"], "ok");
  assert.ok(String(d["orig"]).startsWith("the cat"));
  assert.equal(d["trans"], ""); // not yet translated
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    d = e.tick() as Record<string, unknown>;
    if (d["trans"]) break;
    await sleep(50);
  }
  assert.ok(d["trans"], "mock translation should arrive");
  // #151 方案 A: an aligned result renders cue-by-cue - at t=1500 cue0 shows
  // its own slice, never the whole group text.
  assert.equal(d["trans"], "\u3010\u8bd1\u3011the");
  // the aligned remainder still reaches the display, on its own later cue
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 5500.0,
                   playing: true, playback_rate: 1.0, timestamp: Date.now() });
  d = e.tick() as Record<string, unknown>;
  assert.ok(String(d["trans"]).includes("the cat"));
  const qstats = (e._queue as Q.TranslationQueue).stats();
  assert.equal(typeof qstats, "object");
  stop(e);
});

withTmp("translation state tracks current sentence failure and recovery", async (dir) => {
  const e = mk_engine(dir);
  swap_recording(e);
  e.ingest_json3("s1", { video_id: "v1", track_kind: "manual" }, ONE_GROUP);
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                   playing: false, playback_rate: 1.0, timestamp: Date.now() });
  const d = e.tick() as Record<string, unknown>;
  const src = e.sources["s1"]!;
  const job = (e._queue as RecordingQueue).jobs[0]!;
  assert.equal(d["trans_state"], "translating");

  e._on_done(job, { error: "RATE_LIMITED", status: 402,
                    message: "provider supplied text must not be shown" } as Q.TranslateResult);
  assert.equal((e.tick() as Record<string, unknown>)["trans_state"], "failed:额度不足");

  // Seeking away and back must preserve the sentence's terminal verdict.
  src.last_group_idx = null;
  assert.equal((e.tick() as Record<string, unknown>)["trans_state"], "failed:额度不足");
  e._on_done(job, { text: "译文", error: null } as Q.TranslateResult);
  assert.equal((e.tick() as Record<string, unknown>)["trans_state"], "ready");
  stop(e);
});

withTmp("translation state ignores batch failure until urgent result", async (dir) => {
  const e = mk_engine(dir);
  swap_recording(e);
  e.ingest_json3("s1", { video_id: "v1", track_kind: "manual" }, ONE_GROUP);
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                   playing: false, playback_rate: 1.0, timestamp: Date.now() });
  e.tick();
  const job = (e._queue as RecordingQueue).jobs[0]!;
  (job as unknown as { priority: number }).priority = Q.NORMAL;
  e._on_done(job, { error: "BAD_REQUEST" } as Q.TranslateResult);
  assert.equal((e.tick() as Record<string, unknown>)["trans_state"], "translating");
  assert.deepEqual(
    (e._queue as RecordingQueue).jobs.map(j => [j.group_idx, j.priority]),
    [[0, Q.NORMAL], [0, Q.URGENT]]);
  stop(e);
});

withTmp("translation state waiting and idle boundaries", async (dir) => {
  const e = mk_engine(dir, { mock: false });
  e.handle_event({ type: "register", source_id: "s1", video_id: "v1" });
  assert.equal((e.tick() as Record<string, unknown>)["trans_state"], "unconfigured");
  const prov = e.settings["provider"] as unknown as Record<string, unknown>;
  prov["base_url"] = CFG_URL;
  prov["model"] = CFG_MODEL;
  assert.equal((e.tick() as Record<string, unknown>)["trans_state"], "waiting");
  stop(e);
});

withTmp("engine seek cancels pending and reschedules", async (dir) => {
  const e = mk_engine(dir);
  e.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1000.0,
                   playing: true, playback_rate: 1.0, timestamp: Date.now() });
  e.tick();
  await sleep(100);
  void (e._queue as Q.TranslationQueue).stats();
  // seek far ahead
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 5500.0,
                   playing: true, playback_rate: 1.0, timestamp: Date.now() });
  const d = e.tick() as Record<string, unknown>;
  assert.equal(d["orig"], "next thought"); // resynced to new position
  stop(e);
});

withTmp("engine paused and rate changes", async (dir) => {
  const e = mk_engine(dir);
  e.ingest_json3("s1", { video_id: "v1", track_kind: "manual" }, JSON3);
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1200.0,
                   playing: false, playback_rate: 1.0, timestamp: Date.now() });
  const d1 = e.tick() as Record<string, unknown>;
  await sleep(150);
  const d2 = e.tick() as Record<string, unknown>;
  assert.equal(d1["orig"], d2["orig"]); // paused: frozen
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1200.0,
                   playing: true, playback_rate: 2.0, timestamp: Date.now() });
  await sleep(200);
  const d3 = e.tick() as Record<string, unknown>;
  assert.ok(d3["playing"]);
  assert.equal(d3["rate"], 2.0);
  stop(e);
});

withTmp("engine surfaces a page hook failure", async (dir) => {
  // "Connected but blind" is not "no captions on this video".
  const e = mk_engine(dir);
  e.handle_event({ type: "register", source_id: "s1", video_id: "v1",
                   tab_title: "T", hook_error: "script element: TypeError: TrustedScript" });
  const d = e.tick() as Record<string, unknown>;
  assert.equal(d["state"], "no_cues");
  assert.equal(d["hook_error"], "script element: TypeError: TrustedScript");
  stop(e);
});

withTmp("engine surfaces an empty caption body", async (dir) => {
  const e = mk_engine(dir);
  e.handle_event({ type: "register", source_id: "s1", video_id: "v1",
                   tab_title: "T", hook_error: "",
                   capture_error: "caption response was empty (status 200)" });
  const d = e.tick() as Record<string, unknown>;
  assert.equal(d["state"], "no_cues");
  assert.equal(d["capture_error"], "caption response was empty (status 200)");
  stop(e);
});

withTmp("cues refresh keeps a live clock", async (dir) => {
  // Regression (real-browser E2E): re-sending cues for an existing source
  // must not reset the playback clock to zero.
  const e = mk_engine(dir);
  e.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  e.handle_event({ type: "sync", source_id: "s1", video_time_ms: 5500.0,
                   playing: false, playback_rate: 1.0, timestamp: Date.now() });
  assert.equal((e.tick() as Record<string, unknown>)["orig"], "next thought");
  // same video, another track arrives while paused
  e.ingest_json3("s1", { video_id: "v1", track_kind: "manual" }, JSON3);
  assert.equal((e.tick() as Record<string, unknown>)["orig"], "next thought",
               "a cues refresh must not reset the clock");
  // a brand new source still starts clean (fresh clock, no stale position)
  e.ingest_json3("s2", { video_id: "v2", track_kind: "asr" }, JSON3);
  assert.equal((e.tick() as Record<string, unknown>)["orig"], "",
               "a new source must not inherit the old clock");
  stop(e);
});

withTmp("engine translation persists in cache across restart", async (dir) => {
  const db = path.join(dir, "t.db");
  const s = S.default_settings();
  (s["provider"] as unknown as Record<string, unknown>)["mock"] = true;
  const e1 = new Engine(s, new Q.TranslationCache(db), 2);
  e1.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  e1.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                    playing: true, playback_rate: 1.0, timestamp: Date.now() });
  let got = false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((e1.tick() as Record<string, unknown>)["trans"]) { got = true; break; }
    await sleep(50);
  }
  assert.ok(got);
  stop(e1);

  // new engine, same db: translation must come from cache quickly
  const e2 = new Engine(s, new Q.TranslationCache(db), 1);
  e2.ingest_json3("s1", { video_id: "v1", track_kind: "asr" }, JSON3);
  e2.handle_event({ type: "sync", source_id: "s1", video_time_ms: 1500.0,
                    playing: true, playback_rate: 1.0, timestamp: Date.now() });
  const t0 = Date.now();
  got = false;
  while (Date.now() - t0 < 1000) {
    if ((e2.tick() as Record<string, unknown>)["trans"]) { got = true; break; }
    await sleep(20);
  }
  assert.ok(got, "cache hit should be immediate");
  stop(e2);
});
