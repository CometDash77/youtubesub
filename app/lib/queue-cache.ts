// Port of desktop/suboverlay/queue_cache.py - persistent translation cache
// (SQLite) + priority translation queue (ticket #201, map #181). Keeps the
// same public names as the Python module so the remaining Phase 1 tickets map
// one-to-one onto it.
//
// Semantic fidelity notes (registered in ticket #201):
// - Python json.dumps(payload, sort_keys=True, ensure_ascii=False) ->
//   python_json_dumps(): sorted keys (ASCII key domain), ", " / ": "
//   separators, Python escaping rules (only quote, backslash and < 0x20 are
//   escaped; U+007F, U+2028/U+2029 and all other non-ASCII stay raw). The
//   sha256 identity must stay byte-identical to rows the Python build already
//   wrote into data/translations.db - asserted against a Python-generated
//   fixture in tests/queue-cache.test.ts.
// - threading.Lock + Condition + N worker threads -> single-threaded event
//   loop: async worker loops with a wakeup-promise equivalent of
//   Condition.wait(0.5); cond.notify()/notify_all() -> notifyOne/notifyAll.
// - one sqlite3 connection per op (Python's thread-safety device) -> one
//   persistent DatabaseSync opened in the constructor; Node serializes sync
//   access on the event loop, close() replaces GC. Python's busy timeout 5.0
//   has no in-process contender here.
// - heapq min-heap keyed on (priority, seq) -> MinHeap; the prefetch-shed
//   filter keeps URGENT entries and preserves heap order (a subset of a
//   heap-ordered array is still heap-ordered, as with Python's list rebuild).
// - translate_fn may return a sync list or a Promise (the Python seam is
//   sync; the Node provider client will be fetch-based async). A missing
//   translate_fn throws inside _run exactly like Python's None-call and lands
//   in the same WORKER error path.
// - time.time() -> Date.now()/1000 (float seconds).
// - result.get("error") truthiness -> JS truthiness on result["error"];
//   "RATE_LIMITED" compared with ===.
// - dict(cached) / dict(first_err) shallow copies -> object spread.
// - type(e).__name__ + ": " + str(e) -> `${e.name}: ${e.message}` for Errors.
// - The default db path mirrors the Python __file__-relative
//   ../../data/translations.db default.
// - resolve_workers (provider.max_concurrent clamp to [1,16]) stays in
//   engine.py and is ported by the engine-assembly ticket; the queue takes
//   `workers` as-is, exactly like the Python constructor. Batch chunking
//   (<=8 groups / <=8000 chars, engine.chunk_fill_items) and the namespace
//   invalidation / in-memory discard mechanics (ADR-008 items 2+3) are
//   engine-side too; this module carries the ProviderContext snapshot +
//   namespace they require.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------
// Cache identity (ADR-008: "mock" is a dimension; api_key never enters)
// ---------------------------------------------------------------------

// Identity-scheme version. 2 = "mock" is a dimension of the provider
// namespace (issue #31); it retires every row written under the old scheme.
export const CACHE_VERSION = 2;
export const TTL_S = 30 * 24 * 3600.0;

type PyJsonValue = null | boolean | number | string | PyJsonValue[] |
                   { [key: string]: PyJsonValue };

// Python json string escaping with ensure_ascii=False: only the quote,
// the backslash and control chars < 0x20 are escaped (lowercase hex);
// everything else - including U+007F and U+2028/U+2029 - stays raw.
function py_json_string(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

// Byte-identical equivalent of json.dumps(v, sort_keys=True,
// ensure_ascii=False) on this payload domain (strings / bools / ints /
// null / nested dicts). Key sort is code-point order on the ASCII key
// domain, where JS default sort and Python agree.
function python_json_dumps(v: PyJsonValue): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  // payload domain carries integers only; no float repr path is needed
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return py_json_string(v);
  if (Array.isArray(v)) return "[" + v.map(python_json_dumps).join(", ") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => py_json_string(k) + ": " + python_json_dumps(v[k]!)).join(", ") + "}";
}

const py_or = (v: PyJsonValue, dflt: string): PyJsonValue => (v ? v : dflt);
const as_py = (v: unknown): PyJsonValue => (v === undefined ? null : v as PyJsonValue);

export function cache_identity(
  provider_cfg: Record<string, unknown> | null | undefined,
  client_key: unknown,
  instructions: unknown,
  prompt: unknown,
): string {
  // "mock" is a dimension of the identity (issue #31): a Mock echo is a
  // stand-in that wears a label, not a translation, so it must not be
  // addressable under the identity a real request would use. The
  // identity-scheme version went 1 -> 2 with it.
  const p = provider_cfg ?? {};
  const payload: Record<string, PyJsonValue> = {
    version: CACHE_VERSION,
    provider: {
      base_url: py_or(as_py(p["base_url"]), ""),
      model: py_or(as_py(p["model"]), ""),
      protocol: py_or(as_py(p["protocol"]), "auto"),
      mock: Boolean(p["mock"]),
    },
    client_key: as_py(client_key),
    instructions: py_or(as_py(instructions), ""),
    prompt: py_or(as_py(prompt), ""),
  };
  const blob = python_json_dumps(payload);
  return createHash("sha256").update(blob, "utf8").digest("hex");
}

// ---------------------------------------------------------------------
// TranslationCache
// ---------------------------------------------------------------------

const DEFAULT_DB = path.join(path.dirname(fileURLToPath(import.meta.url)),
                             "..", "..", "data", "translations.db");

export type CachedResult = Record<string, unknown>;

export class TranslationCache {
  private readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath?: string | null) {
    this.dbPath = path.normalize(dbPath || DEFAULT_DB);
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.init_db();
  }

  close(): void {
    this.db.close();
  }

  private init_db(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS translations ("
               + " identity TEXT PRIMARY KEY, result TEXT NOT NULL,"
               + " created_at REAL NOT NULL)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_t ON translations(created_at)");
  }

  // Return cached result dict or null; expired rows deleted on read.
  get(identity: string): CachedResult | null {
    const now = Date.now() / 1000;
    const row = this.db
      .prepare("SELECT result, created_at FROM translations WHERE identity=?")
      .get(identity) as { result: string; created_at: number } | undefined;
    if (row === undefined) return null;
    if (now - Number(row.created_at) > TTL_S) {
      this.db.prepare("DELETE FROM translations WHERE identity=?").run(identity);
      return null;
    }
    try {
      return JSON.parse(row.result) as CachedResult;
    } catch {
      return null;
    }
  }

  put(identity: string, result: CachedResult): void {
    const blob = JSON.stringify(result);
    this.db
      .prepare("INSERT OR REPLACE INTO translations(identity, result, created_at) VALUES(?,?,?)")
      .run(identity, blob, Date.now() / 1000);
  }

  trim(maxRows = 20000): void {
    this.db
      .prepare("DELETE FROM translations WHERE identity IN ("
             + " SELECT identity FROM translations ORDER BY created_at DESC LIMIT -1 OFFSET ?)")
      .run(maxRows);
  }
}

// ---------------------------------------------------------------------
// Queue types (URGENT > NORMAL; seq from one global counter)
// ---------------------------------------------------------------------

export const URGENT = 0;
export const NORMAL = 1;

const _SEQ: { n: number } = { n: 0 };
function next_seq(): number {
  return _SEQ.n++;
}

export interface TranslateResult extends Record<string, unknown> {}

export type TranslateFn =
  (jobs: TranslationJob[]) => TranslateResult[] | Promise<TranslateResult[]>;
export type OnDoneFn = (job: TranslationJob, result: TranslateResult) => void;

// What a queued job must remember about the provider its identity came
// from. Both halves travel together because a job cannot honour one
// without the other (issue #31).
export class ProviderContext {
  readonly provider: Record<string, unknown>;
  readonly namespace: unknown;
  constructor(provider: Record<string, unknown>, namespace: unknown) {
    this.provider = provider;
    this.namespace = namespace;
  }
}

export class TranslationJob {
  readonly identity: string;
  readonly priority: number;
  readonly source_id: string;
  readonly group_idx: number;
  readonly group_text: string;
  readonly prev: string;
  readonly nxt: string;
  readonly expected: number;
  readonly context: ProviderContext | null;
  readonly seq: number;
  cancelled = false;
  constructor(identity: string, priority: number, source_id: string,
              group_idx: number, group_text: string,
              prev = "", nxt = "", expected = 0,
              context: ProviderContext | null = null) {
    this.identity = identity;
    this.priority = priority;
    this.source_id = source_id;
    this.group_idx = group_idx;
    this.group_text = group_text;
    this.prev = prev;
    this.nxt = nxt;
    this.expected = expected;
    this.context = context;
    this.seq = next_seq();
  }

  sort_key(): [number, number] {
    return [this.priority, this.seq];
  }
}

// A window-fill burst submitted as ONE queue entry (spec #24 / ADR-007).
// A batch has no cache identity of its own: members keep the exact
// identities the single path would compute, so the cache stays per-group.
export class TranslationBatch {
  readonly jobs: TranslationJob[];
  readonly priority: number;
  readonly seq: number;
  readonly source_id: string;
  constructor(jobs: TranslationJob[]) {
    this.jobs = [...jobs];
    this.priority = jobs[0]!.priority;
    this.seq = next_seq();
    this.source_id = jobs[0]!.source_id;
  }

  sort_key(): [number, number] {
    return [this.priority, this.seq];
  }
}

type QueueEntry = TranslationJob | TranslationBatch;

interface HeapItem {
  priority: number;
  seq: number;
  entry: QueueEntry;
}

// Min-heap on (priority, seq) - the heapq of Python's _pending list.
class MinHeap {
  private a: HeapItem[] = [];

  get size(): number {
    return this.a.length;
  }

  entries(): IterableIterator<HeapItem> {
    return this.a.values();
  }

  push(item: HeapItem): void {
    this.a.push(item);
    let i = this.a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.lt(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): HeapItem | undefined {
    const top = this.a[0];
    const last = this.a.pop();
    if (top !== undefined && last !== undefined && last !== top) {
      this.a[0] = last;
      this.sift_down(0);
    }
    return top;
  }

  // Prefetch shedding: keep only URGENT entries. Filtering a heap-ordered
  // array keeps it heap-ordered (same as Python's list comprehension).
  retain_urgent(): void {
    this.a = this.a.filter((it) => it.priority === URGENT);
  }

  private lt(i: number, j: number): boolean {
    const x = this.a[i]!;
    const y = this.a[j]!;
    return x.priority < y.priority || (x.priority === y.priority && x.seq < y.seq);
  }

  private swap(i: number, j: number): void {
    const t = this.a[i]!;
    this.a[i] = this.a[j]!;
    this.a[j] = t;
  }

  private sift_down(i: number): void {
    const n = this.a.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let m = i;
      if (l < n && this.lt(l, m)) m = l;
      if (r < n && this.lt(r, m)) m = r;
      if (m === i) return;
      this.swap(i, m);
      i = m;
    }
  }
}

// ---------------------------------------------------------------------
// TranslationQueue
// ---------------------------------------------------------------------

// Bounded worker pool with priority + in-flight dedup + cancel-by-source.
// submit(job) -> boolean; onDone(job, result) is called after each run.
// cancelSource(source_id) drops every pending (not-yet-started) job of
// that source; in-flight requests are never touched (spec #24 decision 4).
export class TranslationQueue {
  // Provider config snapshot handed in by the engine; stored like the
  // Python _cfg (parity), read by no queue path.
  readonly provider_cfg: Record<string, unknown> | null;
  private readonly cache: TranslationCache;
  private readonly onDone: OnDoneFn | null;
  private readonly translateFn: TranslateFn | undefined;
  private readonly maxPending: number;
  private readonly pending = new MinHeap();
  private readonly inflight = new Map<string, TranslationJob>();
  private backoff_until = 0.0;
  private shutdown_flag = false;
  private readonly waiters: Array<() => void> = [];
  private readonly worker_loops: Promise<void>[] = [];

  constructor(provider_cfg: Record<string, unknown> | null,
              cache: TranslationCache, workers = 5,
              onDone: OnDoneFn | null = null, translateFn?: TranslateFn,
              maxPending = 400) {
    this.provider_cfg = provider_cfg;
    this.cache = cache;
    this.onDone = onDone;
    this.translateFn = translateFn;
    this.maxPending = maxPending;
    const n = Math.max(1, workers);
    for (let i = 0; i < n; i++) this.worker_loops.push(this.worker(i));
  }

  private now(): number {
    return Date.now() / 1000;
  }

  private notifyOne(): void {
    const w = this.waiters.pop();
    if (w) w();
  }

  private notifyAll(): void {
    const ws = this.waiters.splice(0);
    for (const w of ws) w();
  }

  // Condition.wait(timeout=0.5) equivalent: resolved by a notify or after
  // the timeout, whichever comes first.
  private waitWakeup(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const wake = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(() => {
        const i = this.waiters.indexOf(wake);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve();
      }, ms);
      this.waiters.push(wake);
    });
  }

  // Identities queued but not started - singles AND batch members.
  private pending_ids(): Set<string> {
    const ids = new Set<string>();
    for (const it of this.pending.entries()) {
      const entry = it.entry;
      if (entry instanceof TranslationBatch) {
        for (const j of entry.jobs) if (!j.cancelled) ids.add(j.identity);
      } else if (!entry.cancelled) {
        ids.add(entry.identity);
      }
    }
    return ids;
  }

  submit(job: TranslationJob): boolean {
    if (this.inflight.has(job.identity)) return false; // dedup concurrent identical work
    if (this.pending_ids().has(job.identity)) return false;
    if (this.pending.size >= this.maxPending) {
      // shed lowest-priority oldest normal jobs first (prefetch shedding)
      this.pending.retain_urgent();
      if (this.pending.size >= this.maxPending) return false;
    }
    const sk = job.sort_key();
    this.pending.push({ priority: sk[0], seq: sk[1], entry: job });
    this.notifyOne();
    return true;
  }

  // Submit several jobs as one batch entry (spec #24). Members already
  // inflight or pending are dropped up front; a batch that reduces to one
  // member falls back to the single path.
  submit_batch(jobs: TranslationJob[]): boolean {
    if (jobs.length === 0) return false;
    const pendingIds = this.pending_ids();
    const members = jobs.filter((j) =>
      !this.inflight.has(j.identity) && !pendingIds.has(j.identity));
    if (members.length === 0) return false;
    if (members.length === 1) return this.submit(members[0]!);
    const entry = new TranslationBatch(members);
    this.pending.push({ priority: entry.priority, seq: entry.seq, entry });
    this.notifyOne();
    return true;
  }

  // Drop pending (not-yet-started) work for a source. In-flight requests
  // are never touched: their cache identity is playhead-independent, so
  // the result is still worth keeping (spec #24 decision 4).
  cancel_source(source_id: string): number {
    let n = 0;
    for (const it of this.pending.entries()) {
      const jobs = it.entry instanceof TranslationBatch ? it.entry.jobs : [it.entry];
      for (const job of jobs) {
        if (job.source_id === source_id && !job.cancelled) {
          job.cancelled = true;
          n += 1;
        }
      }
    }
    this.notifyAll();
    return n;
  }

  note_rate_limited(cooldown_s = 8.0): void {
    this.backoff_until = this.now() + cooldown_s;
  }

  // Is deep backoff active? The engine watches the True -> False edge to
  // refill the window after shed prefetch ("退避后补课", spec #24).
  in_backoff(): boolean {
    return this.now() < this.backoff_until;
  }

  stats(): { pending: number; inflight: number } {
    return { pending: this.pending.size, inflight: this.inflight.size };
  }

  shutdown(): void {
    this.shutdown_flag = true;
    this.notifyAll();
  }

  private async worker(_i: number): Promise<void> {
    for (;;) {
      if (this.pending.size === 0 && !this.shutdown_flag) {
        await this.waitWakeup(500);
      }
      if (this.shutdown_flag) return;
      const running = this.take();
      if (running === null) continue;
      let results: TranslateResult[];
      try {
        results = await this.run(running);
      } catch (e: unknown) {
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        results = running.map(() => ({ error: "WORKER", message }));
      } finally {
        for (const j of running) this.inflight.delete(j.identity);
        this.notifyOne();
      }
      for (let i = 0; i < running.length; i++) {
        const res = results[i];
        if (res === undefined) continue;
        try {
          this.onDone?.(running[i]!, res);
        } catch {
          // swallow: on_done must never kill a worker
        }
      }
    }
  }

  // Take path (spec #24, decision 12 - batch-aware): pop an entry; a batch
  // first drops cancelled / already-in-flight / already-cached members,
  // then >= 2 members run as ONE translate call and exactly 1 member falls
  // back to the single path. Returns the running job list with every
  // member marked in-flight, or null when nothing is takeable.
  private take(): TranslationJob[] | null {
    let running: TranslationJob[] | null = null;
    while (this.pending.size > 0 && running === null) {
      const item = this.pending.pop();
      if (item === undefined) break;
      const cand = item.entry;
      if (cand instanceof TranslationBatch) {
        let members = cand.jobs.filter((j) => !j.cancelled);
        if (members.length === 0) continue;
        if (cand.priority === NORMAL && this.now() < this.backoff_until) {
          continue; // batches are normal-priority: shed under deep backoff
        }
        members = members.filter((j) => !this.inflight.has(j.identity));
        members = members.filter((j) => this.cache.get(j.identity) === null);
        if (members.length === 0) continue;
        running = members.length === 1 ? [members[0]!] : members;
      } else {
        if (cand.cancelled) continue;
        if (cand.priority === NORMAL && this.now() < this.backoff_until) {
          continue; // shed prefetch under deep backoff
        }
        running = [cand];
      }
    }
    if (running === null) return null;
    for (const j of running) this.inflight.set(j.identity, j);
    return running;
  }

  // Execute one translate call for `jobs` (len 1 = single path) and cache
  // per-group results. Batch failures are ALL-OR-NOTHING: if any member
  // errors, every member is voided with that error - no cache write, no
  // partial landing, no placeholder (spec #24, decision 9).
  private async run(jobs: TranslationJob[]): Promise<TranslateResult[]> {
    if (jobs.length === 1) {
      const job = jobs[0]!;
      const cached = this.cache.get(job.identity);
      if (cached !== null) {
        return [{ ...cached, from_cache: true }];
      }
      const results = coerce_results(await this.translateFn!([job]), jobs);
      const result = results[0]!;
      const err = result["error"];
      if (!err) this.cache.put(job.identity, result);
      if (err === "RATE_LIMITED") this.note_rate_limited();
      return [result];
    }
    // batch path: one translate call, per-group identities written on success
    const results = coerce_results(await this.translateFn!(jobs), jobs);
    const first_err = results.find((r) => r["error"]) ?? null;
    if (first_err !== null) {
      for (let i = 0; i < jobs.length; i++) results[i] = { ...first_err }; // whole batch void
    }
    for (let i = 0; i < jobs.length; i++) {
      const res = results[i]!;
      if (!res["error"]) this.cache.put(jobs[i]!.identity, res);
    }
    if (first_err !== null && first_err["error"] === "RATE_LIMITED") {
      this.note_rate_limited();
    }
    return results;
  }
}

// The translate seam must answer one dict per job, in order.
function coerce_results(results: unknown, jobs: TranslationJob[]): TranslateResult[] {
  if (!Array.isArray(results) || results.length !== jobs.length
      || results.some((r) => typeof r !== "object" || r === null || Array.isArray(r))) {
    return jobs.map(() => ({ error: "WORKER",
                             message: "translate returned no result for the job" }));
  }
  return results as TranslateResult[];
}
