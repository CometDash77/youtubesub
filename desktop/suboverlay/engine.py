"""Engine: sources + clock + sentence groups + translation queue wiring.
Pure logic (no Qt) so the whole pipeline is testable."""
import threading, time

from .clock import SyncState, apply_sync, estimate_ms, find_cue_at
from .protocol import coerce_cues, parse_json3, repair_cue_ends
from .sentences import compute_sentence_groups
from .queue_cache import (TranslationCache, TranslationJob, TranslationQueue,
                          ProviderContext, cache_identity, URGENT, NORMAL)
from .settings import active_prompt_text
from . import provider as provider_mod

SEEK_JUMP_MS = 2500.0

# Fallbacks for the read-only config defaults (spec #24 decision 15: values live
# in settings but are deliberately not exposed in the UI - see
# settings.default_settings). Calibration against a real Key is milestone M.
DEFAULT_PREFETCH = {"lead_s": 90.0, "max_groups": 20, "seek_debounce_ms": 400}
DEFAULT_BATCH = {"max_groups": 8, "max_chars": 8000}


def _as_float(v, default):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _as_int(v, default):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def resolve_workers(settings):
    """provider.max_concurrent -> worker pool size (spec #24 decision 13, #21):
    clamped to [1, 16], default 5, read once when the Engine is constructed -
    restart-effective, no hot-reload (that question is #21's)."""
    raw = (settings.get("provider") or {}).get("max_concurrent")
    n = 5 if raw is None or raw == "" else _as_int(raw, 5)
    return max(1, min(16, n))


def chunk_fill_items(items, max_groups, max_chars):
    """Fill-time chunking (spec #24 decision 5): greedy sequential split of
    (key, chars) items into chunks of <= max_groups keys and <= max_chars total.
    A single item over the char cap forms its own chunk - a group is never
    split. No timers and no async collector: batches exist only where this runs
    (window-fill bursts), so steady state never sees one."""
    chunks, cur, cur_chars = [], [], 0
    for key, chars in items:
        if cur and (len(cur) >= max_groups or cur_chars + chars > max_chars):
            chunks.append(cur)
            cur, cur_chars = [], 0
        cur.append(key)
        cur_chars += chars
    if cur:
        chunks.append(cur)
    return chunks


def _provider_usable(prov):
    """Can a translation actually be produced?

    Either the user explicitly turned Mock mode on, or there is a base URL *and*
    a model (the same notion of "configured" as settings.redact). Anything else
    means there is nothing to translate with - not that the original is a
    translation."""
    p = prov or {}
    if p.get("mock"):
        return True
    return bool((p.get("base_url") or "").strip()) and bool((p.get("model") or "").strip())

class _Source:
    def __init__(self, source_id, meta=None):
        self.source_id = source_id
        self.meta = meta or {}
        self.cues = []
        self.groups = []
        self.cue_to_group = {}
        self.group_trans = {}   # group_idx -> whole-line translation
        self.sync = SyncState()
        self.last_group_idx = None
        self.window_anchor = None        # group idx the prefetch window was last filled from
        self.prefetch_quiet_until = 0.0  # seek debounce: no window refill before this wall time

    def reset_translations(self):
        """Drop everything a provider produced; keep the cues and the live clock."""
        self.group_trans = {}
        for c in self.cues:
            c.trans = ""
        self.last_group_idx = None
        # Everything provider-derived is gone, so the window must refill from
        # scratch on the next tick - but a refresh is not a seek drag, so no
        # debounce is owed (spec #24).
        self.window_anchor = None
        self.prefetch_quiet_until = 0.0


class Engine:
    def __init__(self, settings, cache=None, workers=None, translate_fn=None):
        self.settings = settings
        self.sources = {}
        self.active_source = None
        self._lock = threading.RLock()
        self._cache = cache or TranslationCache()
        # workers=None -> provider.max_concurrent (clamped), restart-effective.
        self._workers = resolve_workers(settings) if workers is None else workers
        self._backoff_seen = False   # True->False edge triggers a window refill
        self._translate_fn = translate_fn or self._default_translate
        self._queue = TranslationQueue(settings.get("provider", {}), self._cache,
                                       workers=self._workers, on_done=self._on_done,
                                       translate_fn=self._translate_fn)
        self.display_cb = None   # called on translation arrivals (UI refresh)
        self.last_display = None  # latest tick() result, for /status diagnostics
        self._provider_ns = None  # provider namespace the in-memory translations belong to

    # ---- event ingestion (called from WS thread via queue) ----
    def _stamp_meta(self, src, ev):
        src.meta.update({k: ev.get(k) for k in
            ("provider", "video_id", "tab_title", "track_kind",
             "hook_error", "capture_error")})
        # track_lang (#25): segmentation reads the STORED track language, so a
        # frame that omits the key must not erase what an earlier register or
        # cues frame already carried. Absent everywhere => "" => the
        # space-language branch. Track kind deliberately stops here: it changes
        # no segmentation branch, only what we promise about boundary parity.
        if "track_lang" in ev:
            src.meta["track_lang"] = ev["track_lang"]

    def handle_event(self, ev):
        t = ev.get("type")
        sid = ev.get("source_id")
        if not sid:
            return
        with self._lock:
            if t == "register":
                self._stamp_meta(self.sources.setdefault(sid, _Source(sid, ev)), ev)
                self._switch_active(sid)
            elif t == "cues":
                src = self.sources.setdefault(sid, _Source(sid, ev))
                self._stamp_meta(src, ev)
                raw = ev.get("cues")
                cues = raw if (raw and isinstance(raw[0], object)
                               and hasattr(raw[0], "start_ms")) else coerce_cues(raw)
                self._set_cues(src, cues)
                # Do NOT reset src.sync here: the same source is the same video, so
                # a cues refresh (subtitle track switch, SPA track reload) must keep
                # the live clock. Resetting it blanked the overlay until the next
                # player event, which never arrives while the video is paused.
                # A brand new source still gets a fresh clock in _Source.__init__.
                self._switch_active(sid)
            elif t == "sync":
                src = self.sources.get(sid)
                if src is None:
                    return
                prev_est = estimate_ms(src.sync)
                ts = float(ev.get("timestamp") or 0)
                now_ms = time.time() * 1000.0
                apply_sync(src.sync, float(ev.get("video_time_ms") or 0),
                           bool(ev.get("playing")), float(ev.get("playback_rate") or 1),
                           ts, now_ms)
                new_est = estimate_ms(src.sync)
                if abs(new_est - prev_est) > SEEK_JUMP_MS:
                    # Pending prefetch is dropped and the window refill waits out
                    # the debounce, so dragging the seek bar cannot repeatedly
                    # re-fire the whole window (spec #24 decision 3). In-flight
                    # requests are never touched (decision 4): their cache
                    # identity is playhead-independent, so the result is still
                    # worth keeping when the playhead comes back.
                    self._queue.cancel_source(sid)
                    src.last_group_idx = None  # force urgent resubmit at new spot
                    src.window_anchor = None
                    src.prefetch_quiet_until = time.time() + self._seek_debounce_s()
            elif t == "deactivate":
                src = self.sources.get(sid)
                if src:
                    src.sync.playing = False

    def _switch_active(self, sid):
        """Make sid the watched source (spec #24 US9): every OTHER source's
        PENDING work is dropped - we are no longer paying for subtitles nobody
        is watching. In-flight requests are never touched: their cache
        identity is playhead-independent, so the result is still worth
        keeping (decision 4)."""
        if self.active_source != sid:
            for other in self.sources:
                if other != sid:
                    self._queue.cancel_source(other)
        self.active_source = sid

    def _set_cues(self, src, cues):
        # A cues refresh is a track switch or a reload (spec #24 US9): queued
        # work was built from the OLD grouping, so drop it - only pending jobs,
        # never in-flight ones (decision 4). The window refills from the next
        # tick (reset_translations clears the anchor below).
        self._queue.cancel_source(src.source_id)
        cues = repair_cue_ends(cues)
        src.cues = cues
        # The segmentation branch is keyed on the stored track language (#25);
        # missing language => "" => space-language criteria.
        src.groups = compute_sentence_groups(cues, src.meta.get("track_lang") or "")
        src.cue_to_group = {}
        for gi, g in enumerate(src.groups):
            for ci in range(g.start_idx, g.end_idx + 1):
                src.cue_to_group[ci] = gi
        src.reset_translations()

    def ingest_json3(self, source_id, meta, json3):
        """Helper for tests/tools: parse a timedtext payload and feed as cues event."""
        cues = parse_json3(json3)
        self.handle_event({"type": "cues", "source_id": source_id, **meta, "cues": cues})

    # ---- translation scheduling ----
    def _client_key(self, src, g):
        return "|".join([str(src.meta.get("video_id") or ""), str(src.meta.get("track_kind") or ""),
                         str(g.start_ms), str(g.end_ms), g.text[:400]])

    # ---- prefetch / batch parameters (read-only config, spec #24 decision 15) ----
    def _window_lead_ms(self):
        p = self.settings.get("prefetch") or {}
        return max(0.0, _as_float(p.get("lead_s", DEFAULT_PREFETCH["lead_s"]),
                                  DEFAULT_PREFETCH["lead_s"])) * 1000.0

    def _window_max_groups(self):
        p = self.settings.get("prefetch") or {}
        return max(1, _as_int(p.get("max_groups", DEFAULT_PREFETCH["max_groups"]),
                              DEFAULT_PREFETCH["max_groups"]))

    def _seek_debounce_s(self):
        p = self.settings.get("prefetch") or {}
        return max(0, _as_int(p.get("seek_debounce_ms", DEFAULT_PREFETCH["seek_debounce_ms"]),
                              DEFAULT_PREFETCH["seek_debounce_ms"])) / 1000.0

    def _batch_limits(self):
        b = self.settings.get("batch") or {}
        return (max(1, _as_int(b.get("max_groups", DEFAULT_BATCH["max_groups"]),
                               DEFAULT_BATCH["max_groups"])),
                max(1, _as_int(b.get("max_chars", DEFAULT_BATCH["max_chars"]),
                               DEFAULT_BATCH["max_chars"])))

    def _neighbours(self, src, gi):
        """(prev, next) context texts, honouring prompt.context_groups - which
        shapes the PROMPT only; it never gates scheduling (spec #24 decision 16)."""
        if not self.settings.get("prompt", {}).get("context_groups", 1):
            return "", ""
        prev_t = src.groups[gi - 1].text if gi > 0 else ""
        nxt_t = src.groups[gi + 1].text if gi + 1 < len(src.groups) else ""
        return prev_t, nxt_t

    def _translated(self, src, gi):
        g = src.groups[gi]
        return (gi in src.group_trans
                or all(c.trans for c in src.cues[g.start_idx:g.end_idx + 1]))

    def _build_job(self, src, gi, priority):
        """The single translation job for one group, or None if it needs no
        request. Both the urgent path and the batch fill build jobs here, so a
        group's cache identity is byte-identical whichever path sends it
        (spec #24 decision 11 - the identity invariant)."""
        if gi < 0 or gi >= len(src.groups):
            return None
        g = src.groups[gi]
        if self._translated(src, gi):
            return None
        prov, instructions = self._provider_snapshot()
        if not _provider_usable(prov):
            # Issue #1: "not configured" is not mock mode. The mock translator
            # echoes the original behind a fake translation label, which reads as
            # a broken translation; showing the original alone is the honest state.
            return None
        prompt_ctx = self._neighbours(src, gi)
        ident = self._identity(prov, instructions, self._client_key(src, g), g, prompt_ctx)
        # Identity and namespace come from the one snapshot above, so a job can
        # never describe one provider in its identity and another in its context.
        return TranslationJob(ident, priority, src.source_id, gi, g.text,
                              prev=prompt_ctx[0], nxt=prompt_ctx[1],
                              expected=(g.end_idx - g.start_idx + 1),
                              context=ProviderContext(prov, self._namespace_of(prov, instructions)))

    def _submit_group(self, src, gi, priority):
        job = self._build_job(src, gi, priority)
        if job is not None:
            self._queue.submit(job)

    def _fill_window(self, src, gi, t_ms):
        """Window fill (spec #24 / ADR-007): prefetch every group from the
        playhead within the lead window, measured in SECONDS (decoupled from
        subtitle density) and bounded by the group hard cap - first of the two
        to hit wins. The fill is the burst point: its pending groups are
        chunked into batches (<= batch.max_groups / <= batch.max_chars) and
        sent as batches; a lone pending group stays a single request. Steady
        state crosses one group at a time, so this submits exactly one group -
        one-request-per-group behaviour is unchanged there."""
        lead_ms = self._window_lead_ms()
        horizon = t_ms + lead_ms
        window = []
        for idx in range(gi, min(len(src.groups), gi + self._window_max_groups())):
            if idx > gi and src.groups[idx].start_ms > horizon:
                break
            window.append(idx)
        todo = [idx for idx in window
                if idx != gi and not self._translated(src, idx)]
        if not todo:
            return
        if len(todo) == 1:
            self._submit_group(src, todo[0], NORMAL)
            return
        max_g, max_c = self._batch_limits()
        items = []
        for idx in todo:
            prev_t, nxt_t = self._neighbours(src, idx)
            # The char budget counts the group text plus the context it drags
            # along: keeping per-group context inflates the request (~3x, see
            # ADR-007), so the cap must measure what actually gets sent.
            items.append((idx, len(src.groups[idx].text) + len(prev_t) + len(nxt_t)))
        for chunk in chunk_fill_items(items, max_g, max_c):
            if len(chunk) == 1:
                self._submit_group(src, chunk[0], NORMAL)
                continue
            jobs = [j for j in (self._build_job(src, idx, NORMAL) for idx in chunk)
                    if j is not None]
            if len(jobs) == 1:
                self._queue.submit(jobs[0])
            elif jobs:
                self._queue.submit_batch(jobs)

    def _identity(self, prov, instructions, client_key, g, prompt_ctx):
        prompt = g.text
        if prompt_ctx[0] or prompt_ctx[1]:
            prompt = " || ".join([x for x in prompt_ctx if x]) + " || " + g.text
        return cache_identity(prov, client_key, instructions, prompt)

    def _provider_snapshot(self):
        """(provider copy, instructions) - the inputs both the cache identity and
        the translation namespace are computed from. Taken in one place, so a job
        cannot describe one provider in its identity and another in its context.

        instructions = the ACTIVE PRESET text (#39 / ADR-010), resolved by the
        one shared resolver. It is also copied into prov["system"], which is the
        cfg key translate_group reads - so the text that shaped the identity is
        byte-identical to the text that goes on the wire (was: identity used
        prompt.system but the wire silently fell back to DEFAULT_SYSTEM_PROMPT).
        cache_identity picks explicit provider fields only, so the extra key
        never enters the identity on its own."""
        prov = dict(self.settings.get("provider", {}))
        instructions = active_prompt_text(self.settings) or provider_mod.DEFAULT_SYSTEM_PROMPT
        # #23 / ADR-005 same-cfg invariant: the prompt text is part of what
        # the wire sees. It used to enter only the cache identity, so the
        # dialog's prompt never reached the provider - and the connection test
        # (which does send it) would have tested something production did not
        # use. cache_identity reads a fixed key subset, so identity and
        # namespace are unchanged by this key.
        prov["system"] = instructions
        return prov, instructions

    def _namespace_of(self, prov, instructions):
        """The provider + instructions namespace for one provider snapshot.

        This is the cache identity with the per-sentence parts (client_key /
        prompt) blanked, so any identity in the namespace changes when the
        namespace does - but not the converse: one sentence's identity can change
        while the namespace stays put."""
        return cache_identity(prov, "", instructions, "")

    def _provider_namespace(self):
        """The namespace the live settings currently describe."""
        prov, instructions = self._provider_snapshot()
        return self._namespace_of(prov, instructions)

    def _sync_namespace(self):
        """Issue #31: translations are provider-derived. Toggling Mock - or editing
        base_url / model / system prompt - moves to another namespace, so the
        translations held in memory came from a provider that is no longer
        configured: drop them and let the current sentence be requested again.
        Otherwise the Mock echo stays on screen and the real provider is never
        asked. Caller holds self._lock."""
        ns = self._provider_namespace()
        if ns == self._provider_ns:
            return
        self._provider_ns = ns
        for src in self.sources.values():
            src.reset_translations()

    def _default_translate(self, jobs):
        """The queue's translate seam, widened to a JOB LIST (spec #24): a
        length-1 list is exactly the previous single behaviour; a longer list is
        ONE batched request covering every job (burst-point fills only). Returns
        one result per job, in order.
        """
        if not jobs:
            return []
        if len(jobs) == 1:
            return [self._translate_single(jobs[0])]
        # Issue #31: results are written under identities computed from this
        # snapshot, so the batch translates with the provider those identities
        # describe - the snapshot travels with the first job (all members are
        # built from one snapshot per fill).
        first = jobs[0]
        prov = (dict(first.context.provider) if first.context is not None
                else self._provider_snapshot()[0])
        if not _provider_usable(prov):
            return [{"aligned": False, "text": "", "error": "NOT_CONFIGURED"}
                    for _ in jobs]
        if prov.get("mock"):
            # Mock never hits the wire; each group gets the same product the
            # single path would produce, so batch results stay interchangeable.
            time.sleep(0.02)
            return [self._translate_single(j) for j in jobs]
        items = [{"text": j.group_text, "prev": j.prev, "nxt": j.nxt,
                  "expected": j.expected} for j in jobs]
        return provider_mod.translate_batch(prov, items)

    def _translate_single(self, job):
        # Issue #31: the job carries the provider its identity was computed from,
        # so the result written under that identity always came from that
        # provider - even if Settings changed while the job sat in the queue.
        # Bare jobs fall back to _provider_snapshot(), which already copies the
        # active preset into prov["system"] - the wire shape matches the preview
        # and the identity (#39 D5) instead of DEFAULT_SYSTEM_PROMPT.
        prov = (dict(job.context.provider) if job.context is not None
                else self._provider_snapshot()[0])
        if not _provider_usable(prov):
            # Defence in depth for a job queued without a provider snapshot.
            return {"aligned": False, "text": "", "error": "NOT_CONFIGURED"}
        if prov.get("mock"):
            time.sleep(0.02)  # simulate latency so queue/priority is exercised
            if job.expected > 1:
                n = job.expected
                # mock aligned output in N|line form to exercise validation
                raw = chr(10).join(str(i + 1) + "|【译】" + part for i, part in
                                   enumerate(job.group_text.split(" ", n - 1)))
                from suboverlay.provider import unpack_numbered
                vals = unpack_numbered(raw, n)
                if vals is not None:
                    return {"aligned": True, "values": vals, "error": None}
            return {"aligned": False, "text": "【译】" + job.group_text, "error": None}
        r = provider_mod.translate_group(prov, job.group_text, job.prev, job.nxt,
                                         expected_lines=job.expected if job.expected > 1 else 0)
        if r.get("error") == "SHAPE_MISS":
            r = provider_mod.translate_group(prov, job.group_text, job.prev, job.nxt,
                                             expected_lines=0)
        return r

    def _on_done(self, job, result):
        if result.get("error") or not job or job.cancelled:
            return
        with self._lock:
            if job.context is not None and job.context.namespace != self._provider_ns:
                # Issue #31: the namespace moved while this job was in flight (Mock
                # toggled, endpoint edited). Its text came from the old provider and
                # must not land among the new provider's translations.
                return
            src = self.sources.get(job.source_id)
            if src is None or job.group_idx >= len(src.groups):
                return
            g = src.groups[job.group_idx]
            if result.get("aligned") and result.get("values"):
                vals = result["values"]
                for k, ci in enumerate(range(g.start_idx, g.end_idx + 1)):
                    if k < len(vals):
                        src.cues[ci].trans = vals[k]
                src.group_trans[job.group_idx] = " ".join(v for v in vals if v)
            elif result.get("text"):
                src.group_trans[job.group_idx] = result["text"]
            else:
                return
        if self.display_cb:
            try:
                self.display_cb()
            except Exception:
                pass

    # ---- UI tick ----
    def tick(self):
        """Advance playback + schedule urgent/prefetch. Returns display dict or None."""
        d = self._tick_locked()
        with self._lock:
            self.last_display = d
        return d

    def status(self):
        """Read-only snapshot for the /status route (never raises). The Qt tick
        keeps last_display fresh, so this must not drive scheduling itself."""
        with self._lock:
            display = dict(self.last_display or {})
            # Issue #1 contract (docs/PROTOCOL.md): /status always answers "can this
            # run translate at all", even before the first tick has anything to show.
            display.setdefault("trans_available",
                               _provider_usable(self.settings.get("provider", {})))
            return {"sources": len(self.sources), "active_source": self.active_source,
                    "display": display}

    def _tick_locked(self):
        with self._lock:
            self._sync_namespace()
            sid = self.active_source
            if sid is None:
                return None
            src = self.sources.get(sid)
            if src is None or not src.cues:
                # Both failure reasons travel with the display state, because a script
                # that connected but cannot see captions must not look like a video that
                # simply has none: hook_error = the page hook never installed;
                # capture_error = the hook ran but the caption response was unusable.
                return {"state": "no_cues", "title": src.meta.get("tab_title") if src else "",
                        "hook_error": (src.meta.get("hook_error") or "") if src else "",
                        "capture_error": (src.meta.get("capture_error") or "") if src else "",
                        "trans_available": _provider_usable(self.settings.get("provider", {}))}
            t = estimate_ms(src.sync)
            cue = find_cue_at(src.cues, t)
            gi = None
            if cue is not None:
                gi = src.cue_to_group.get(src.cues.index(cue))
            if gi is not None and gi != src.last_group_idx:
                src.last_group_idx = gi
                # The sentence on screen (URGENT): never debounced, never throttled
                # (spec #24 decision 2).
                self._submit_group(src, gi, URGENT)
            # Prefetch is scheduling, not prompting (#38 / ADR-009): the window
            # fills unconditionally - prompt.context_groups only shapes the
            # prompt, never the lookahead (that gate was semantic crosstalk with
            # the prefetch domain of #9 / #24, spec #24 decision 16).
            if self._queue.in_backoff():
                self._backoff_seen = True
            elif self._backoff_seen:
                self._backoff_seen = False
                src.window_anchor = None  # deep backoff ended: refill what it shed
            # Window refill gates: playing (a paused viewer earns no prefetch),
            # the seek-debounce quiet time, and a changed anchor - the window is
            # recomputed when playback crosses into a new group (event-native
            # incremental advance), after a seek, and after backoff - not on a
            # coarse timer (spec #24 decision 2 / 3).
            if (gi is not None and src.sync.playing
                    and time.time() >= src.prefetch_quiet_until
                    and src.window_anchor != gi):
                src.window_anchor = gi
                self._fill_window(src, gi, t)
            trans = ""
            if cue is not None:
                ci = src.cues.index(cue)
                gi = src.cue_to_group.get(ci)
                if gi is not None:
                    trans = src.group_trans.get(gi, "")
                    if not trans and cue.trans:
                        trans = cue.trans
            title = src.meta.get("tab_title") or ""
            return {"state": "ok", "orig": cue.text if cue else "",
                    "trans": trans,
                    # Issue #1: the one authority on whether this run can translate
                    # at all, so the overlay never reads provider config itself and
                    # never has to guess "no translation" from an empty string.
                    "trans_available": _provider_usable(self.settings.get("provider", {})),
                    "playing": src.sync.playing,
                    "rate": src.sync.playback_rate, "title": title,
                    "hook_error": src.meta.get("hook_error") or "",
                    "capture_error": src.meta.get("capture_error") or ""}