// Partial port of desktop/suboverlay/protocol.py (ticket #200): the Cue wire
// model + parse_json3, exactly what the parse-parity acceptance needs. The
// remaining protocol surface (coerce_cue / coerce_cues / repair_cue_ends /
// PROTOCOL_* constants / SourceState / frame validation) lands with ticket
// #198 and extends this module. Original parse_json3 adapted ideas from
// yt-dual-subs inject.js (MIT, (c) 2026 Gythiro).
//
// Semantic fidelity notes (registered in ticket #200):
// - Dataclass __post_init__ (last_off_ms falsy -> start_ms) becomes make_cue():
//   0 and -0 both fall back like Python `not x`; NaN is kept (Python truthy),
//   though the shared JSON fixture can never carry NaN (JSON.parse would
//   reject the whole file).
// - Python isinstance(x, (int, float)) on wire fields accepts JSON booleans
//   (bool is an int subclass) and coerces via float(); the TS check therefore
//   accepts number | boolean and Number()-coerces. Strings are rejected on
//   both sides.
// - re.sub(r"\s+", " ") + strip -> replace(/\s+/g, " ") + trim.

export interface Cue {
  start_ms: number;
  end_ms: number;
  text: string;
  // Wire-only since ADR-006: kept for protocol compatibility (userscript,
  // fixtures and docs all still carry it), never used for segmentation.
  last_off_ms: number;
  trans: string;
}

// Python separates "wire dict" from "model object" with hasattr(raw[0],
// "start_ms") - dicts have keys, dataclass instances have attributes. JS
// objects have both, so Cue instances created through make_cue are branded
// in a WeakSet (no shape change; deepEqual-safe) and is_cue_instance()
// replays the hasattr check (ticket #203).
const CUE_BRAND = new WeakSet<object>();

export function is_cue_instance(v: unknown): boolean {
  return v !== null && typeof v === "object" && CUE_BRAND.has(v);
}

export function make_cue(start_ms: number, end_ms: number, text: string,
                         last_off_ms = 0, trans = ""): Cue {
  const cue: Cue = {
    start_ms,
    end_ms,
    text,
    last_off_ms: last_off_ms !== 0 ? last_off_ms : start_ms,
    trans,
  };
  CUE_BRAND.add(cue);
  return cue;
}

// float(v) with Python's junk -> default semantics: numbers pass (NaN/inf
// fall back), booleans coerce (bool is an int subclass), numeric strings
// parse, everything else returns the default.
function _num(v: unknown, d = 0.0): number {
  let f: number;
  if (typeof v === "number") f = v;
  else if (typeof v === "boolean") f = v ? 1 : 0;
  else if (typeof v === "string" && v.trim() !== "") f = Number(v.trim());
  else return d;
  if (!Number.isFinite(f)) return d;
  return f;
}

// Validate one inbound cue dict; null for junk (never raises).
export function coerce_cue(raw: unknown): Cue | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const textRaw = rec["text"] ?? "";
  if (typeof textRaw !== "string") return null;
  const text = textRaw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const start = _num(rec["start_ms"]);
  const end = _num(rec["end_ms"]);
  if (end <= start) return null;
  let last_off = _num(rec["last_off_ms"], start);
  if (last_off < start) last_off = start;
  return make_cue(start, end, text, last_off);
}

// Coerce a cues array; junk dropped, order preserved (no sort here).
export function coerce_cues(raw: unknown): Cue[] {
  if (!Array.isArray(raw)) return [];
  const out: Cue[] = [];
  for (const item of raw) {
    const c = coerce_cue(item);
    if (c !== null) out.push(c);
  }
  return out;
}

// Sort by start; trim overlap to next.start; tail keeps own end. Repairs
// the cue objects in place (Python mutates the dataclasses) and returns the
// sorted list.
export function repair_cue_ends(cues: readonly Cue[], floor_ms = 1000.0): Cue[] {
  const sorted = [...cues].sort((a, b) => a.start_ms - b.start_ms);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    const nxt = i + 1 < sorted.length ? sorted[i + 1]! : null;
    if (nxt !== null && nxt.start_ms > c.start_ms && c.end_ms > nxt.start_ms) {
      c.end_ms = nxt.start_ms;
    }
    if (c.end_ms <= c.start_ms) {
      if (nxt !== null && nxt.start_ms > c.start_ms) c.end_ms = nxt.start_ms;
      else c.end_ms = c.start_ms + floor_ms;
    }
  }
  return sorted;
}

export function parse_json3(data: unknown): Cue[] {
  // Parse YouTube timedtext json3 payload into Cue list (event order kept).
  // Read only segs utf8 + tOffsetMs, collapse whitespace, strip ASR >> marks,
  // skip style/blank events, last_off tracks last NON-BLANK seg. Seg
  // separator aligned to the reference (#26): join with a space so a seg
  // without a trailing space cannot glue the next word onto it (word and
  // char counts would drift); the whitespace collapse folds the doubled
  // spaces a trailing space plus separator produces.
  const cues: Cue[] = [];
  const events = data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as { events?: unknown }).events
    : undefined;
  if (!Array.isArray(events)) return cues;
  for (const ev of events) {
    if (ev === null || typeof ev !== "object" || Array.isArray(ev)) continue;
    const segs = (ev as { segs?: unknown }).segs;
    if (!Array.isArray(segs)) continue;
    const parts: string[] = [];
    let off = 0;
    let has_off = false;
    for (const s of segs) {
      if (s === null || typeof s !== "object" || Array.isArray(s)) continue;
      const u = (s as { utf8?: unknown }).utf8;
      if (typeof u !== "string") continue;
      parts.push(u);
      const to = (s as { tOffsetMs?: unknown }).tOffsetMs;
      if (u.trim() && (typeof to === "number" || typeof to === "boolean")) {
        off = Number(to);
        has_off = true;
      }
    }
    let text = parts.join(" ").replace(/\s+/g, " ").trim();
    text = text.replace(/(^|\s)>{2,}\s*/g, "$1").trim();
    if (!text) continue;
    const tStart = (ev as { tStartMs?: unknown }).tStartMs;
    const start = typeof tStart === "number" || typeof tStart === "boolean"
      ? Number(tStart) : 0.0;
    const dDur = (ev as { dDurationMs?: unknown }).dDurationMs;
    const dur = typeof dDur === "number" || typeof dDur === "boolean"
      ? Number(dDur) : 0.0;
    if (dur <= 0) continue;
    cues.push(make_cue(start, start + dur, text, has_off ? start + off : start));
  }
  return cues;
}
