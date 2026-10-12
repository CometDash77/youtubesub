// 1:1 port of desktop/suboverlay/engine.py - sources + clock + sentence
// groups + translation queue wiring (ticket #203, map #181; ADR-009/010).
// Pure logic (no Qt / no Electron) so the whole pipeline stays testable.
//
// Registered port conversions (ticket #203) - the thread/lock mapping table:
// - threading.RLock -> nothing: the event loop serializes every synchronous
//   span; engine methods hold no await across a mutated invariant span
//   (the Python "with self._lock" bodies are straight-line sync code here).
// - TranslationQueue worker THREADS (blocking translate_fn) -> the #201
//   async queue: translate_fn may return a Promise; _default_translate /
//   _translate_single are async; time.sleep(0.02) mock latency -> awaited
//   setTimeout. Results still land through _on_done off the tick path.
// - time.time() (wall) -> Date.now()/1000; time.monotonic() lives inside
//   the clock port (#200).
// - unicodedata.name(ch) -> unicode_name_prefix(): the CJK/Kana/Hangul
//   block classifier the heuristic actually reads (Han unify/compat,
//   Hiragana, Katakana, halfwidth Katakana, Hangul, halfwidth Hangul);
//   every other letter is "" exactly like a non-matching name. isalpha()
//   -> /\p{L}/u per code point.
// - str(float) on client_key numbers ("1000.0") -> py_float_str() so the
//   cache identity stays byte-compatible with rows the Python build wrote.
// - str.split(" ", maxsplit) -> py_split_maxsplit() (JS split(limit)
//   truncates instead of keeping the remainder).
// - int()/float() junk -> default: as_int/as_float (int("3.5") raises in
//   Python, so it falls back instead of truncating).
// - dict.pop(k, None) / .get(k, d) -> delete / ?? chains.
// - None -> null for "no display"; dict(self.last_display or {}) ->
//   spread of last_display ?? {}.
// - monkeypatch.setattr(P, "translate_group", fake) -> constructor
//   deps.translateGroup / deps.translateBatch injection (ESM module
//   bindings cannot be patched); defaults are the real module functions.
// - hasattr(raw[0], "start_ms") wire-vs-model check -> is_cue_instance()
//   brand set filled by make_cue (protocol.ts).
// - config readers .get(key, default) + _as_int/_as_float keep the
//   Python junk-tolerant semantics (registered above).
import * as Clock from "./clock.ts";
import type { SyncState } from "./clock.ts";
import * as P from "./provider.ts";
import * as proto from "./protocol.ts";
import type { Cue } from "./protocol.ts";
import * as Q from "./queue-cache.ts";
import type { TranslationCache, TranslationJob, TranslateResult } from "./queue-cache.ts";
import * as S from "./settings.ts";
import * as S2 from "./sentences.ts";
import type { SentenceGroup } from "./sentences.ts";

export const SEEK_JUMP_MS = 2500.0;

// Fallbacks for the config defaults that now live in the debug window's
// tuning page "experimental" group (spec #24 decision 15). Calibration
// against a real Key is milestone M.
export const DEFAULT_PREFETCH = { lead_s: 90.0, max_groups: 20, seek_debounce_ms: 400 };
export const DEFAULT_BATCH = { max_groups: 8, max_chars: 8000 };
export const CJK_FALLBACK_THRESHOLD = 0.30;

export const URGENT = Q.URGENT;
export const NORMAL = Q.NORMAL;

function get_obj(settings: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = settings[key];
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown> : {};
}

function as_float(v: unknown, d: number): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : d;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (t !== "") {
      const f = Number(t);
      if (Number.isFinite(f)) return f;
    }
    return d;
  }
  return d;
}

function as_int(v: unknown, d: number): number {
  // int() semantics: floats truncate, int-strings parse, "3.5" is junk.
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : d;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    return /^[+-]?[0-9]+$/.test(t) ? parseInt(t, 10) : d;
  }
  return d;
}

// Python str(float): integers keep one decimal ("1000.0"); the client_key
// feeding the cache identity must match the Python build byte-for-byte.
function py_float_str(n: number): string {
  return Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(1) : String(n);
}

function str_(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

// Python str.split(sep, maxsplit): the remainder stays in the last field.
function py_split_maxsplit(s: string, sep: string, maxsplit: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (out.length < maxsplit) {
    const i = rest.indexOf(sep);
    if (i === -1) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  out.push(rest);
  return out;
}

const sleepS = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

export function resolve_workers(settings: Record<string, unknown>): number {
  // provider.max_concurrent -> worker pool size (spec #24 decision 13):
  // clamped to [1, 16], default 5, read once at Engine construction -
  // restart-effective, no hot-reload.
  const raw = get_obj(settings, "provider")["max_concurrent"];
  const n = raw === undefined || raw === null || raw === "" ? 5 : as_int(raw, 5);
  return Math.max(1, Math.min(16, n));
}

export function chunk_fill_items(items: Array<readonly [number, number]>,
                                 max_groups: number, max_chars: number): number[][] {
  // Fill-time chunking (spec #24 decision 5): greedy sequential split of
  // (key, chars) items into chunks of <= max_groups keys and <= max_chars
  // total. A single item over the char cap forms its own chunk - a group is
  // never split.
  const chunks: number[][] = [];
  let cur: number[] = [];
  let cur_chars = 0;
  for (const [key, chars] of items) {
    if (cur.length > 0 && (cur.length >= max_groups || cur_chars + chars > max_chars)) {
      chunks.push(cur);
      cur = [];
      cur_chars = 0;
    }
    cur.push(key);
    cur_chars += chars;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

export function provider_usable(prov: unknown): boolean {
  // Can a translation actually be produced? Either the user explicitly
  // turned Mock mode on, or there is a base URL *and* a model. Anything
  // else means there is nothing to translate with.
  const p = prov !== null && typeof prov === "object" && !Array.isArray(prov)
    ? prov as Record<string, unknown> : {};
  if (p["mock"]) return true;
  return Boolean(str_(p["base_url"]).trim()) && Boolean(str_(p["model"]).trim());
}

// unicodedata.name() prefix classifier over the blocks the heuristic reads.
// Every assigned letter outside them returns "" - neither Han nor an
// exclusion signal - exactly like a non-matching unicodedata name.
function unicode_name_prefix(ch: string): string {
  const cp = ch.codePointAt(0)!;
  if ((cp >= 0x3041 && cp <= 0x3096) || cp === 0x309D || cp === 0x309E) return "HIRAGANA";
  if ((cp >= 0x30A1 && cp <= 0x30FA) || cp === 0x30FD || cp === 0x30FE) return "KATAKANA";
  if (cp >= 0xFF66 && cp <= 0xFF9D) return "HALFWIDTH KATAKANA";
  if ((cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0x1100 && cp <= 0x11FF) ||
      (cp >= 0x3130 && cp <= 0x318F)) return "HANGUL";
  if (cp >= 0xFFA0 && cp <= 0xFFDC) return "HALFWIDTH HANGUL";
  if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x20000 && cp <= 0x2FA1F)) return "CJK UNIFIED IDEOGRAPH";
  if ((cp >= 0xF900 && cp <= 0xFA6D) || (cp >= 0xFA70 && cp <= 0xFAD9) ||
      (cp >= 0x2F800 && cp <= 0x2FA1D)) return "CJK COMPATIBILITY IDEOGRAPH";
  return "";
}

function is_alpha(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

export function _is_chinese_group(src: EngineSource, gi: number): boolean {
  // Use track metadata first, then a small local heuristic if it is absent.
  if (gi < 0 || gi >= src.groups.length) return false;
  const language = str_(src.meta["track_lang"]).trim().toLowerCase();
  if (language) return language.startsWith("zh");

  const text = src.groups[gi]!.text;
  const letters: string[] = [];
  for (const ch of text) {
    if (is_alpha(ch)) letters.push(ch);
  }
  if (letters.length === 0) return false;
  const names = letters.map(unicode_name_prefix);
  // Han-only text is ambiguous between Chinese and Japanese. Kana and
  // Hangul are cheap local signals that keep this fallback conservative.
  const EXCLUDE = ["HIRAGANA", "KATAKANA", "HANGUL", "HALFWIDTH KATAKANA", "HALFWIDTH HANGUL"];
  if (names.some(n => EXCLUDE.some(p => n.startsWith(p)))) return false;
  const HAN = ["CJK UNIFIED IDEOGRAPH", "CJK COMPATIBILITY IDEOGRAPH"];
  const han_count = names.filter(n => HAN.some(p => n.startsWith(p))).length;
  return han_count / letters.length >= CJK_FALLBACK_THRESHOLD;
}

function _mark_original_only(src: EngineSource, gi: number): void {
  // Discard any provider-derived state when this group is Chinese.
  delete src.group_trans[gi];
  delete src.group_failures[gi];
  src.group_states[gi] = "idle";
  const group = src.groups[gi]!;
  for (let ci = group.start_idx; ci <= group.end_idx; ci++) {
    src.cues[ci]!.trans = "";
  }
}

export interface EngineQueue {
  submit(job: TranslationJob): boolean;
  submit_batch(jobs: TranslationJob[]): boolean;
  in_backoff(): boolean;
  cancel_source(source_id: string): number;
}

export class EngineSource {
  source_id: string;
  meta: Record<string, unknown>;
  cues: Cue[] = [];
  groups: SentenceGroup[] = [];
  cue_to_group: Record<number, number> = {};
  group_trans: Record<number, string> = {};   // group_idx -> whole-line translation
  group_states: Record<number, string> = {};  // group_idx -> translating / ready
  // Per-group terminal provider failures. Kept across seeks, removed only
  // when that group succeeds or provider-derived state is reset.
  group_failures: Record<number, string> = {}; // group_idx -> failed:<reason>
  sync: SyncState = Clock.make_sync_state();
  last_group_idx: number | null = null;
  window_anchor: number | null = null;        // group idx the window was last filled from
  prefetch_quiet_until = 0.0;                 // seek debounce wall time

  constructor(source_id: string, meta: Record<string, unknown> = {}) {
    this.source_id = source_id;
    this.meta = meta;
  }

  reset_translations(): void {
    // Drop everything a provider produced; keep the cues and the live clock.
    this.group_trans = {};
    this.group_states = {};
    this.group_failures = {};
    for (const c of this.cues) c.trans = "";
    this.last_group_idx = null;
    // Everything provider-derived is gone, so the window must refill from
    // scratch on the next tick - but a refresh is not a seek drag, so no
    // debounce is owed (spec #24).
    this.window_anchor = null;
    this.prefetch_quiet_until = 0.0;
  }
}

export interface EngineDeps {
  translateGroup?: typeof P.translate_group;
  translateBatch?: typeof P.translate_batch;
}

export class Engine {
  settings: Record<string, unknown>;
  sources: Record<string, EngineSource> = {};
  active_source: string | null = null;
  _queue: EngineQueue;
  _cache: TranslationCache;
  _workers: number;
  _backoff_seen = false;   // True->False edge triggers a window refill
  _translate_fn: Q.TranslateFn;
  _translation_enabled: boolean;
  display_cb: (() => void) | null = null;  // called on translation arrivals
  last_display: Record<string, unknown> | null = null;
  _provider_ns: string | null = null;  // namespace the in-memory translations belong to
  private readonly _deps: { translateGroup: typeof P.translate_group;
                            translateBatch: typeof P.translate_batch };

  constructor(settings: Record<string, unknown>, cache?: TranslationCache,
              workers?: number, translate_fn?: Q.TranslateFn, deps: EngineDeps = {}) {
    this.settings = settings;
    this._cache = cache ?? new Q.TranslationCache();
    // workers omitted -> provider.max_concurrent (clamped), restart-effective.
    this._workers = workers === undefined ? resolve_workers(settings) : workers;
    this._translate_fn = translate_fn ?? ((jobs: TranslationJob[]) => this._default_translate(jobs));
    this._deps = {
      translateGroup: deps.translateGroup ?? P.translate_group,
      translateBatch: deps.translateBatch ?? P.translate_batch,
    };
    this._queue = new Q.TranslationQueue(get_obj(settings, "provider"), this._cache,
                                         this._workers,
                                         (job, result) => this._on_done(job, result),
                                         this._translate_fn);
    this._translation_enabled = this._translation_mode_enabled();
  }

  // ---- event ingestion (called from the WS side via the queue) ----
  _stamp_meta(src: EngineSource, ev: Record<string, unknown>): void {
    for (const k of ["provider", "video_id", "tab_title", "track_kind",
                     "hook_error", "capture_error"]) {
      src.meta[k] = ev[k];
    }
    // Optional since protocol v1: an older cues frame must not erase a
    // description delivered by a newer register frame.
    if ("video_description" in ev) {
      const value = ev["video_description"];
      src.meta["video_description"] = typeof value === "string" ? value : "";
    }
    // track_lang (#25): segmentation reads the STORED track language, so a
    // frame that omits the key must not erase what an earlier frame carried.
    if ("track_lang" in ev) src.meta["track_lang"] = ev["track_lang"];
  }

  handle_event(ev: Record<string, unknown>): void {
    const t = ev["type"];
    const sid = ev["source_id"];
    if (!sid) return;
    if (t === "register") {
      const src = this.sources[sid as string] ?? (this.sources[sid as string] = new EngineSource(sid as string, ev));
      this._stamp_meta(src, ev);
      this._switch_active(sid as string);
    } else if (t === "cues") {
      const src = this.sources[sid as string] ?? (this.sources[sid as string] = new EngineSource(sid as string, ev));
      this._stamp_meta(src, ev);
      const raw = ev["cues"];
      const cues = Array.isArray(raw) && raw.length > 0 && proto.is_cue_instance(raw[0])
        ? raw as Cue[]
        : proto.coerce_cues(raw);
      this._set_cues(src, cues);
      // Do NOT reset src.sync here: the same source is the same video, so a
      // cues refresh (track switch, SPA reload) must keep the live clock.
      this._switch_active(sid as string);
    } else if (t === "sync") {
      const src = this.sources[sid as string];
      if (src === undefined) return;
      const prev_est = Clock.estimate_ms(src.sync);
      const ts = Number(ev["timestamp"] || 0);
      const now_ms = Date.now();
      Clock.apply_sync(src.sync, Number(ev["video_time_ms"] || 0),
                       Boolean(ev["playing"]), Number(ev["playback_rate"] || 1),
                       ts, now_ms);
      const new_est = Clock.estimate_ms(src.sync);
      if (Math.abs(new_est - prev_est) > SEEK_JUMP_MS) {
        // Pending prefetch is dropped and the window refill waits out the
        // debounce; in-flight requests are never touched (decision 4).
        this._queue.cancel_source(sid as string);
        src.last_group_idx = null; // force urgent resubmit at the new spot
        src.window_anchor = null;
        src.prefetch_quiet_until = Date.now() / 1000 + this._seek_debounce_s();
      }
    } else if (t === "deactivate") {
      const src = this.sources[sid as string];
      if (src !== undefined) src.sync.playing = false;
    }
  }

  _switch_active(sid: string): void {
    // Make sid the watched source (spec #24 US9): every OTHER source's
    // PENDING work is dropped; in-flight requests are never touched.
    if (this.active_source !== sid) {
      for (const other of Object.keys(this.sources)) {
        if (other !== sid) this._queue.cancel_source(other);
      }
    }
    this.active_source = sid;
  }

  _set_cues(src: EngineSource, cues: Cue[]): void {
    // A cues refresh is a track switch or a reload (spec #24 US9): drop
    // queued work built from the OLD grouping - only pending jobs, never
    // in-flight ones. The window refills from the next tick.
    this._queue.cancel_source(src.source_id);
    const repaired = proto.repair_cue_ends(cues);
    src.cues = repaired;
    // The segmentation branch is keyed on the stored track language (#25).
    src.groups = S2.compute_sentence_groups(repaired, str_(src.meta["track_lang"]));
    src.cue_to_group = {};
    for (let gi = 0; gi < src.groups.length; gi++) {
      const g = src.groups[gi]!;
      for (let ci = g.start_idx; ci <= g.end_idx; ci++) src.cue_to_group[ci] = gi;
    }
    src.reset_translations();
  }

  ingest_json3(source_id: string, meta: Record<string, unknown>, json3: unknown): void {
    // Helper for tests/tools: parse a timedtext payload, feed as cues event.
    const cues = proto.parse_json3(json3);
    this.handle_event({ type: "cues", source_id, ...meta, cues });
  }

  // ---- translation scheduling ----
  _translation_mode_enabled(): boolean {
    // Bilingual and translation-only translate; original-only leaves the
    // provider pipeline dormant (#61).
    return (get_obj(this.settings, "display")["mode"] || "bilingual") !== "orig";
  }

  _sync_translation_mode(): boolean {
    // Apply a display-mode edge at the scheduling boundary. Re-enabling
    // begins from the live playhead.
    const enabled = this._translation_mode_enabled();
    if (enabled === this._translation_enabled) return enabled;
    const sid = this.active_source;
    if (!enabled && sid !== null) this._queue.cancel_source(sid);
    const src = sid !== null ? this.sources[sid] : undefined;
    if (src !== undefined) {
      src.last_group_idx = null;
      src.window_anchor = null;
      // A mode switch starts its own current-window fill immediately; it
      // must not inherit a seek debounce from an earlier mode.
      src.prefetch_quiet_until = 0.0;
    }
    this._translation_enabled = enabled;
    return enabled;
  }

  _client_key(src: EngineSource, g: SentenceGroup): string {
    return [str_(src.meta["video_id"] ?? ""), str_(src.meta["track_kind"] ?? ""),
            py_float_str(g.start_ms), py_float_str(g.end_ms),
            g.text.slice(0, 400)].join("|");
  }

  // ---- prefetch / batch parameters (read-only config, decision 15) ----
  _window_lead_ms(): number {
    const p = get_obj(this.settings, "prefetch");
    return Math.max(0.0, as_float(p["lead_s"] ?? DEFAULT_PREFETCH.lead_s,
                                  DEFAULT_PREFETCH.lead_s)) * 1000.0;
  }

  _window_max_groups(): number {
    const p = get_obj(this.settings, "prefetch");
    return Math.max(1, as_int(p["max_groups"] ?? DEFAULT_PREFETCH.max_groups,
                              DEFAULT_PREFETCH.max_groups));
  }

  _seek_debounce_s(): number {
    const p = get_obj(this.settings, "prefetch");
    return Math.max(0, as_int(p["seek_debounce_ms"] ?? DEFAULT_PREFETCH.seek_debounce_ms,
                              DEFAULT_PREFETCH.seek_debounce_ms)) / 1000.0;
  }

  _batch_limits(): [number, number] {
    const b = get_obj(this.settings, "batch");
    return [Math.max(1, as_int(b["max_groups"] ?? DEFAULT_BATCH.max_groups,
                               DEFAULT_BATCH.max_groups)),
            Math.max(1, as_int(b["max_chars"] ?? DEFAULT_BATCH.max_chars,
                               DEFAULT_BATCH.max_chars))];
  }

  _neighbours(src: EngineSource, gi: number): [string, string] {
    // (prev, next) context texts, honouring prompt.context_groups - which
    // shapes the PROMPT only; it never gates scheduling (decision 16).
    // Python .get("context_groups", 1): the key absent means ON (default 1).
    const prompt = get_obj(this.settings, "prompt");
    const cg = "context_groups" in prompt ? prompt["context_groups"] : 1;
    if (!cg) return ["", ""];
    const prev_t = gi > 0 ? src.groups[gi - 1]!.text : "";
    const nxt_t = gi + 1 < src.groups.length ? src.groups[gi + 1]!.text : "";
    return [prev_t, nxt_t];
  }

  _translated(src: EngineSource, gi: number): boolean {
    const g = src.groups[gi]!;
    if (gi in src.group_trans) return true;
    for (let ci = g.start_idx; ci <= g.end_idx; ci++) {
      if (!src.cues[ci]!.trans) return false;
    }
    return true;
  }

  _build_job(src: EngineSource, gi: number, priority: number): TranslationJob | null {
    // The single translation job for one group, or null if it needs no
    // request. Both the urgent path and the batch fill build jobs here, so a
    // group's cache identity is byte-identical whichever path sends it
    // (decision 11 - the identity invariant).
    if (gi < 0 || gi >= src.groups.length) return null;
    const g = src.groups[gi]!;
    if (_is_chinese_group(src, gi)) {
      // Original-only is terminal for this group - not a queued translation
      // or a provider failure.
      _mark_original_only(src, gi);
      return null;
    }
    if (this._translated(src, gi)) return null;
    const [prov, instructions] = this._provider_snapshot();
    if (!provider_usable(prov)) {
      // Issue #1: "not configured" is not mock mode - show the original.
      return null;
    }
    const prompt_ctx = this._neighbours(src, gi);
    const ident = this._identity(prov, instructions, this._client_key(src, g), g, prompt_ctx);
    // Identity and namespace come from the one snapshot above.
    return new Q.TranslationJob(ident, priority, src.source_id, gi, g.text,
                                prompt_ctx[0], prompt_ctx[1],
                                g.end_idx - g.start_idx + 1,
                                new Q.ProviderContext(prov, this._namespace_of(prov, instructions)));
  }

  _submit_group(src: EngineSource, gi: number, priority: number): void {
    if (!this._translation_mode_enabled()) return;
    const job = this._build_job(src, gi, priority);
    if (job !== null) {
      const accepted = this._queue.submit(job);
      if (accepted && !(gi in src.group_failures)) {
        src.group_states[gi] = "translating";
      }
    }
  }

  _window_group_indices(src: EngineSource, gi: number, t_ms: number): number[] {
    // The ordered prefetch window, bounded by time and group count.
    const lead_ms = this._window_lead_ms();
    const horizon = t_ms + lead_ms;
    const end = Math.min(src.groups.length, gi + this._window_max_groups());
    const window: number[] = [];
    for (let idx = gi; idx < end; idx++) {
      if (idx > gi && src.groups[idx]!.start_ms > horizon) break;
      window.push(idx);
    }
    return window;
  }

  _submit_prefetch_groups(src: EngineSource, todo: number[]): void {
    // Submit a fill burst in contract-sized chunks, preserving group order.
    if (todo.length === 0 || !this._translation_mode_enabled()) return;
    if (todo.length === 1) {
      this._submit_group(src, todo[0]!, NORMAL);
      return;
    }
    const [max_g, max_c] = this._batch_limits();
    const items: Array<[number, number]> = [];
    for (const idx of todo) {
      const [prev_t, nxt_t] = this._neighbours(src, idx);
      // The char budget counts the group text plus the context it drags
      // along: the cap must measure what actually gets sent (ADR-007).
      items.push([idx, src.groups[idx]!.text.length + prev_t.length + nxt_t.length]);
    }
    for (const chunk of chunk_fill_items(items, max_g, max_c)) {
      if (chunk.length === 1) {
        this._submit_group(src, chunk[0]!, NORMAL);
        continue;
      }
      const jobs = chunk.map(idx => this._build_job(src, idx, NORMAL))
        .filter((j): j is TranslationJob => j !== null);
      if (jobs.length === 1) this._queue.submit(jobs[0]!);
      else if (jobs.length > 0) this._queue.submit_batch(jobs);
    }
  }

  _fill_window(src: EngineSource, gi: number, t_ms: number): void {
    // Fill the time-and-count bounded window around the playhead. A fill is
    // the only batch formation point.
    const window = this._window_group_indices(src, gi, t_ms);
    const todo = window.filter(idx => idx !== gi && !this._translated(src, idx));
    this._submit_prefetch_groups(src, todo);
  }

  _identity(prov: Record<string, unknown>, instructions: string, client_key: string,
            g: { text: string }, prompt_ctx: readonly [string, string]): string {
    let prompt = g.text;
    if (prompt_ctx[0] || prompt_ctx[1]) {
      prompt = prompt_ctx.filter(x => x).join(" || ") + " || " + g.text;
    }
    return Q.cache_identity(prov, client_key, instructions, prompt);
  }

  _provider_snapshot(): [Record<string, unknown>, string] {
    // (provider copy, instructions) - the inputs both the cache identity and
    // the translation namespace are computed from, taken in one place.
    // instructions = the ACTIVE PRESET text (#39 / ADR-010); it is also
    // copied into prov["system"], the cfg key translate_group reads - so the
    // text that shaped the identity is byte-identical to the wire text.
    const prov: Record<string, unknown> = { ...get_obj(this.settings, "provider") };
    const instructions =
      S.active_prompt_text(this.settings as unknown as S.Json) || P.DEFAULT_SYSTEM_PROMPT;
    prov["system"] = instructions;
    return [prov, instructions];
  }

  _namespace_of(prov: Record<string, unknown>, instructions: string): string {
    // The provider + instructions namespace: the cache identity with the
    // per-sentence parts (client_key / prompt) blanked.
    return Q.cache_identity(prov, "", instructions, "");
  }

  _provider_namespace(): string {
    const [prov, instructions] = this._provider_snapshot();
    return this._namespace_of(prov, instructions);
  }

  _sync_namespace(): void {
    // Issue #31: translations are provider-derived. Toggling Mock - or
    // editing base_url / model / system prompt - moves to another namespace:
    // drop the in-memory translations and re-request the current sentence.
    const ns = this._provider_namespace();
    if (ns === this._provider_ns) return;
    this._provider_ns = ns;
    for (const src of Object.values(this.sources)) src.reset_translations();
  }

  async _default_translate(jobs: TranslationJob[]): Promise<TranslateResult[]> {
    // The queue's translate seam, widened to a JOB LIST (spec #24): a
    // length-1 list is exactly the single behaviour; a longer list is ONE
    // batched request. Returns one result per job, in order.
    if (jobs.length === 0) return [];
    if (jobs.length === 1) return [await this._translate_single(jobs[0]!)];
    // Issue #31: results are written under identities computed from this
    // snapshot - the snapshot travels with the first job (all members are
    // built from one snapshot per fill).
    const first = jobs[0]!;
    const prov: Record<string, unknown> = first.context !== null
      ? { ...first.context.provider } : this._provider_snapshot()[0];
    if (!provider_usable(prov)) {
      return jobs.map(() => ({ aligned: false, text: "", error: "NOT_CONFIGURED" }));
    }
    if (prov["mock"]) {
      // Mock never hits the wire; each group gets the same product the
      // single path would produce, so batch results stay interchangeable.
      await sleepS(0.02);
      const out: TranslateResult[] = [];
      for (const j of jobs) out.push(await this._translate_single(j));
      return out;
    }
    const items = jobs.map(j => ({ text: j.group_text, prev: j.prev,
                                   nxt: j.nxt, expected: j.expected }));
    return await this._deps.translateBatch(prov, items) as unknown as TranslateResult[];
  }

  async _translate_single(job: TranslationJob): Promise<TranslateResult> {
    // Issue #31: the job carries the provider its identity was computed
    // from; bare jobs fall back to _provider_snapshot(), which already
    // copies the active preset into prov["system"] (#39 D5).
    const prov: Record<string, unknown> = job.context !== null
      ? { ...job.context.provider } : this._provider_snapshot()[0];
    if (!provider_usable(prov)) {
      // Defence in depth for a job queued without a provider snapshot.
      return { aligned: false, text: "", error: "NOT_CONFIGURED" };
    }
    if (prov["mock"]) {
      await sleepS(0.02); // simulate latency so queue/priority is exercised
      if (job.expected > 1) {
        const n = job.expected;
        // mock aligned output in N|line form to exercise validation
        const parts = py_split_maxsplit(job.group_text, " ", n - 1);
        const raw = parts.map((p, i) => String(i + 1) + "|\u3010\u8bd1\u3011" + p).join("\n");
        const vals = P.unpack_numbered(raw, n);
        if (vals !== null) return { aligned: true, values: vals, error: null };
      }
      return { aligned: false, text: "\u3010\u8bd1\u3011" + job.group_text, error: null };
    }
    let r = await this._deps.translateGroup(prov, job.group_text, job.prev, job.nxt,
                                            job.expected > 1 ? job.expected : 0);
    if (r["error"] === "SHAPE_MISS") {
      r = await this._deps.translateGroup(prov, job.group_text, job.prev, job.nxt, 0);
    }
    return r as unknown as TranslateResult;
  }

  _on_done(job: TranslationJob | null, result: TranslateResult): void {
    if (!job || job.cancelled) return;
    const src = this.sources[job.source_id];
    if (job.context !== null && job.context.namespace !== this._provider_ns) {
      // Issue #31: the namespace moved while this job was in flight - its
      // text came from the old provider and must not land here.
      return;
    }
    if (src === undefined || job.group_idx >= src.groups.length) return;
    if (_is_chinese_group(src, job.group_idx)) {
      // A request may have been in flight when the user switched tracks.
      _mark_original_only(src, job.group_idx);
      return;
    }
    if (result["error"]) {
      // Prefetch failures are deliberately invisible. A failed batch is
      // voided and the urgent sentence request owns the verdict.
      if (job.priority === URGENT) {
        const reason = Engine._failure_reason(result);
        if (reason !== null) {
          const verdict = "failed:" + reason;
          src.group_failures[job.group_idx] = verdict;
          src.group_states[job.group_idx] = verdict;
          // 表示互斥 + 失败不显译（#151 方案 A 第 3/5 条）：失败的组不保留任何
          // 既有译文表示，否则旧译文会盖过 failed 状态。SHAPE_MISS（reason
          // None）与预取失败在此之上原样保留。
          const gf = src.groups[job.group_idx]!;
          delete src.group_trans[job.group_idx];
          for (let ci = gf.start_idx; ci <= gf.end_idx; ci++) {
            src.cues[ci]!.trans = "";
          }
        }
      } else if (this.active_source === job.source_id
                 && src.last_group_idx === job.group_idx) {
        // A prefetched sentence may have become current while its batch was
        // in flight. Replace that void result with the ordinary urgent
        // single-sentence path.
        this._submit_group(src, job.group_idx, URGENT);
      }
      return;
    }
    const g = src.groups[job.group_idx]!;
    if (result["aligned"] && result["values"]) {
      const vals = result["values"] as string[];
      let k = 0;
      for (let ci = g.start_idx; ci <= g.end_idx; ci++) {
        if (k < vals.length) src.cues[ci]!.trans = vals[k]!;
        k += 1;
      }
      // 表示互斥（#151 方案 A 第 5 条）：aligned 结果逐 cue 活在 cue.trans，
      // 清掉可能残留的旧整组文本 - 同组只有一种表示存活。
      delete src.group_trans[job.group_idx];
    } else if (result["text"]) {
      // 表示互斥（#151 方案 A 第 5 条）：同组同时只有一种表示存活，清掉可能
      // 残留的旧 aligned 逐 cue 值。
      for (let ci = g.start_idx; ci <= g.end_idx; ci++) {
        src.cues[ci]!.trans = "";
      }
      src.group_trans[job.group_idx] = result["text"] as string;
    } else {
      return;
    }
    delete src.group_failures[job.group_idx];
    src.group_states[job.group_idx] = "ready";
    if (this.display_cb) {
      try {
        this.display_cb();
      } catch {
        // a broken display callback must never break the pipeline
      }
    }
  }

  // ---- UI tick ----
  tick(): Record<string, unknown> | null {
    // Advance playback + schedule urgent/prefetch. Returns display dict or null.
    const d = this._tick_locked();
    this.last_display = d;
    return d;
  }

  status(): Record<string, unknown> {
    // Read-only snapshot for the /status route (never raises).
    const display: Record<string, unknown> = { ...(this.last_display ?? {}) };
    // Issue #1 contract: /status always answers "can this run translate at
    // all", even before the first tick has anything to show.
    if (!("trans_available" in display)) {
      display["trans_available"] = provider_usable(get_obj(this.settings, "provider"));
    }
    return { sources: Object.keys(this.sources).length,
             active_source: this.active_source, display };
  }

  static _failure_reason(result: TranslateResult): string | null {
    // Map provider wire/worker errors to the fixed, user-safe vocabulary.
    const code = result["error"] as string | undefined;
    const status = result["status"] as number | undefined;
    if (status === 402) return "额度不足";
    if (status === 429) return "请求受限";
    if (code === "RATE_LIMITED") return "请求受限";
    if (code === "AUTH") return "API Key 无效";
    if (code === "FORBIDDEN") return "访问被拒绝";
    if (code === "TIMEOUT" || code === "NETWORK" || code === "SERVER" ||
        code === "INVALID_MODEL_OUTPUT") {
      return { "TIMEOUT": "翻译请求超时", "NETWORK": "无法连接翻译服务",
               "SERVER": "翻译服务异常", "INVALID_MODEL_OUTPUT": "译文格式异常" }[code!]!;
    }
    if (code === "BAD_REQUEST") return "翻译请求无效";
    if (code === "BAD_CONFIG" || code === "NO_MODEL") return "翻译配置无效";
    if (code === "SHAPE_MISS") return null;
    return "翻译内部错误";
  }

  static _timeline_display(src: EngineSource, video_time_ms: number):
      [Cue | null, number | null, string] {
    // Resolve one clock position through cue -> group -> translation. Cue
    // selection owns timing; translations render cue-first (#151 方案 A).
    const cue = Clock.find_cue_at(src.cues, video_time_ms);
    if (cue === null) return [null, null, ""];
    const cue_index = src.cues.indexOf(cue);
    const group_index = src.cue_to_group[cue_index];
    if (group_index === undefined) return [cue, null, ""];
    // Contract (#151 方案 A): aligned 结果逐 cue 活在 cue.trans；unaligned 的
    // 整组文本只在组首 cue 出现一次。
    let translation: string;
    if (cue.trans) translation = cue.trans;
    else if (cue_index === src.groups[group_index]!.start_idx) {
      translation = src.group_trans[group_index] ?? "";
    } else translation = "";
    return [cue, group_index, translation];
  }

  _tick_locked(): Record<string, unknown> | null {
    this._sync_namespace();
    const translation_enabled = this._sync_translation_mode();
    const sid = this.active_source;
    if (sid === null) return null;
    const src = this.sources[sid];
    if (src === undefined || src.cues.length === 0) {
      // Both failure reasons travel with the display state: hook_error = the
      // page hook never installed; capture_error = the response was unusable.
      const usable = provider_usable(get_obj(this.settings, "provider"));
      const hook_error = src !== undefined ? str_(src.meta["hook_error"] ?? "") : "";
      const capture_error = src !== undefined ? str_(src.meta["capture_error"] ?? "") : "";
      const trans_state = !translation_enabled ? "idle"
        : !usable ? "unconfigured"
        : (!hook_error && !capture_error) ? "waiting" : "idle";
      return { state: "no_cues", trans_state,
               title: src !== undefined ? src.meta["tab_title"] : "",
               video_description: src !== undefined
                 ? (src.meta["video_description"] ?? "") : "",
               hook_error, capture_error, trans_available: usable };
    }
    const t = Clock.estimate_ms(src.sync);
    const [cue, gi, trans0] = Engine._timeline_display(src, t);
    let trans = trans0;
    if (gi !== null && _is_chinese_group(src, gi)) {
      _mark_original_only(src, gi);
      trans = "";
    }
    if (translation_enabled && gi !== null && gi !== src.last_group_idx) {
      src.last_group_idx = gi;
      // The sentence on screen (URGENT): never debounced, never throttled.
      this._submit_group(src, gi, URGENT);
    }
    // Prefetch is scheduling, not prompting (#38 / ADR-009): the window
    // fills unconditionally - context_groups only shapes the prompt.
    if (this._queue.in_backoff()) {
      this._backoff_seen = true;
    } else if (this._backoff_seen) {
      this._backoff_seen = false;
      src.window_anchor = null; // deep backoff ended: refill what it shed
    }
    // Window refill gates: playing, the seek-debounce quiet time, and a
    // changed anchor (event-native incremental advance, spec #24 decision 2/3).
    if (translation_enabled && gi !== null && src.sync.playing
        && Date.now() / 1000 >= src.prefetch_quiet_until
        && src.window_anchor !== gi) {
      src.window_anchor = gi;
      this._fill_window(src, gi, t);
    }
    const title = str_(src.meta["tab_title"] ?? "");
    const usable = provider_usable(get_obj(this.settings, "provider"));
    const trans_state = (!translation_enabled || gi === null
                         || src.group_states[gi] === "idle") ? "idle"
      : !usable ? "unconfigured"
      : trans ? "ready"
      : (src.group_failures[gi] ?? src.group_states[gi] ?? "translating");
    return { state: "ok", orig: cue !== null ? cue.text : "",
             trans, trans_state,
             // Issue #1: the one authority on whether this run can translate.
             trans_available: usable,
             playing: src.sync.playing,
             rate: src.sync.playback_rate, title,
             video_description: src.meta["video_description"] ?? "",
             hook_error: str_(src.meta["hook_error"] ?? ""),
             capture_error: str_(src.meta["capture_error"] ?? "") };
  }
}
