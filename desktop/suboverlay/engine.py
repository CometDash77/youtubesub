"""Engine: sources + clock + sentence groups + translation queue wiring.
Pure logic (no Qt) so the whole pipeline is testable."""
import threading, time

from .clock import SyncState, apply_sync, estimate_ms, find_cue_at
from .protocol import coerce_cues, parse_json3, repair_cue_ends
from .sentences import compute_sentence_groups
from .queue_cache import (TranslationCache, TranslationJob, TranslationQueue,
                          ProviderContext, cache_identity, URGENT, NORMAL)
from . import provider as provider_mod

SEEK_JUMP_MS = 2500.0
PREFETCH_GROUPS = 4


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

    def reset_translations(self):
        """Drop everything a provider produced; keep the cues and the live clock."""
        self.group_trans = {}
        for c in self.cues:
            c.trans = ""
        self.last_group_idx = None


class Engine:
    def __init__(self, settings, cache=None, workers=5, translate_fn=None):
        self.settings = settings
        self.sources = {}
        self.active_source = None
        self._lock = threading.RLock()
        self._cache = cache or TranslationCache()
        self._translate_fn = translate_fn or self._default_translate
        self._queue = TranslationQueue(settings.get("provider", {}), self._cache,
                                       workers=workers, on_done=self._on_done,
                                       translate_fn=self._translate_fn)
        self.display_cb = None   # called on translation arrivals (UI refresh)
        self.last_display = None  # latest tick() result, for /status diagnostics
        self._provider_ns = None  # provider namespace the in-memory translations belong to

    # ---- event ingestion (called from WS thread via queue) ----
    def handle_event(self, ev):
        t = ev.get("type")
        sid = ev.get("source_id")
        if not sid:
            return
        with self._lock:
            if t == "register":
                self.sources.setdefault(sid, _Source(sid, ev))
                self.sources[sid].meta.update({k: ev.get(k) for k in
                    ("provider", "video_id", "tab_title", "track_kind", "track_lang",
                     "hook_error", "capture_error")})
                self.active_source = sid
            elif t == "cues":
                src = self.sources.setdefault(sid, _Source(sid, ev))
                src.meta.update({k: ev.get(k) for k in
                    ("provider", "video_id", "tab_title", "track_kind", "track_lang",
                     "hook_error", "capture_error")})
                raw = ev.get("cues")
                cues = raw if (raw and isinstance(raw[0], object)
                               and hasattr(raw[0], "start_ms")) else coerce_cues(raw)
                self._set_cues(src, cues)
                # Do NOT reset src.sync here: the same source is the same video, so
                # a cues refresh (subtitle track switch, SPA track reload) must keep
                # the live clock. Resetting it blanked the overlay until the next
                # player event, which never arrives while the video is paused.
                # A brand new source still gets a fresh clock in _Source.__init__.
                self.active_source = sid
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
                    self._queue.cancel_source(sid)
                    src.last_group_idx = None  # force urgent resubmit at new spot
            elif t == "deactivate":
                src = self.sources.get(sid)
                if src:
                    src.sync.playing = False

    def _set_cues(self, src, cues):
        cues = repair_cue_ends(cues)
        src.cues = cues
        src.groups = compute_sentence_groups(cues)
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

    def _submit_group(self, src, gi, priority):
        if gi < 0 or gi >= len(src.groups):
            return
        g = src.groups[gi]
        if gi in src.group_trans or all(c.trans for c in src.cues[g.start_idx:g.end_idx + 1]):
            return
        prov, instructions = self._provider_snapshot()
        if not _provider_usable(prov):
            # Issue #1: "not configured" is not mock mode. The mock translator
            # echoes the original behind a fake translation label, which reads as
            # a broken translation; showing the original alone is the honest state.
            return
        prev_t = src.groups[gi - 1].text if gi > 0 else ""
        nxt_t = src.groups[gi + 1].text if gi + 1 < len(src.groups) else ""
        prompt_ctx = (prev_t, nxt_t) if self.settings.get("prompt", {}).get("context_groups", 1) else ("", "")
        ident = self._identity(prov, instructions, self._client_key(src, g), g, prompt_ctx)
        # Identity and namespace come from the one snapshot above, so a job can
        # never describe one provider in its identity and another in its context.
        job = TranslationJob(ident, priority, src.source_id, gi, g.text,
                             prev=prompt_ctx[0], nxt=prompt_ctx[1],
                             expected=(g.end_idx - g.start_idx + 1),
                             context=ProviderContext(prov, self._namespace_of(prov, instructions)))
        self._queue.submit(job)

    def _identity(self, prov, instructions, client_key, g, prompt_ctx):
        prompt = g.text
        if prompt_ctx[0] or prompt_ctx[1]:
            prompt = " || ".join([x for x in prompt_ctx if x]) + " || " + g.text
        return cache_identity(prov, client_key, instructions, prompt)

    def _provider_snapshot(self):
        """(provider copy, instructions) - the inputs both the cache identity and
        the translation namespace are computed from. Taken in one place, so a job
        cannot describe one provider in its identity and another in its context."""
        prov = dict(self.settings.get("provider", {}))
        instructions = (self.settings.get("prompt", {}).get("system")
                        or provider_mod.DEFAULT_SYSTEM_PROMPT)
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

    def _default_translate(self, job):
        # Issue #31: the job carries the provider its identity was computed from,
        # so the result written under that identity always came from that
        # provider - even if Settings changed while the job sat in the queue.
        prov = (dict(job.context.provider) if job.context is not None
                else dict(self.settings.get("provider", {})))
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
            if cue is not None:
                ci = src.cues.index(cue)
                gi = src.cue_to_group.get(ci)
                if gi is not None and gi != src.last_group_idx:
                    src.last_group_idx = gi
                    self._submit_group(src, gi, URGENT)
                    if self.settings.get("prompt", {}).get("context_groups", 1):
                        for off in range(1, PREFETCH_GROUPS + 1):
                            self._submit_group(src, gi + off, NORMAL)
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