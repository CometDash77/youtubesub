"""Translation cache (SQLite, persistent) + priority queue.

Cache identity = SHA-256 over key-sorted {version, provider, client_key,
instructions, prompt} - never contains the API key (transly rule, MIT).
Queue: bounded worker pool, urgent > normal priority, in-flight dedup,
cancel-pending-by-source (seek / source switch), prefetch shedding
(designs from yt-dual-subs lanes + transly queue, gaps they lack).
"""
import hashlib, json, os, sqlite3, threading, time, itertools

# Identity-scheme version. 2 = "mock" is a dimension of the provider namespace
# (issue #31): it retires every row written under the old scheme, real-provider
# rows included. There is no way to keep those and retire only the Mock-poisoned
# ones, because the old scheme gave both the same key.
CACHE_VERSION = 2
TTL_S = 30 * 24 * 3600.0


def cache_identity(provider_cfg, client_key, instructions, prompt):
    """SHA-256 identity; api_key intentionally excluded.

    "mock" is a dimension of the identity (issue #31): a Mock echo is a stand-in
    that wears a 【译】 label, not a translation, so it must not be addressable
    under the identity a real request would use - unchecking Mock would otherwise
    serve the echo as the real translation and never ask the provider. The
    identity-scheme version went 1 -> 2 with it, which is what makes a Mock echo
    cached *before* this fix unreachable."""
    p = provider_cfg or {}
    payload = {
        "version": CACHE_VERSION,
        "provider": {
            "base_url": p.get("base_url") or "",
            "model": p.get("model") or "",
            "protocol": p.get("protocol") or "auto",
            "mock": bool(p.get("mock")),
        },
        "client_key": client_key,
        "instructions": instructions or "",
        "prompt": prompt or "",
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()

class TranslationCache:
    """SQLite-backed persistent cache with TTL. Thread-safe (one conn per op)."""

    def __init__(self, path=None):
        self._path = path or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                          "..", "..", "data", "translations.db")
        self._path = os.path.normpath(self._path)
        os.makedirs(os.path.dirname(self._path), exist_ok=True)
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self):
        return sqlite3.connect(self._path, timeout=5.0)

    def _init_db(self):
        with self._lock:
            with self._connect() as con:
                con.execute("CREATE TABLE IF NOT EXISTS translations ("
                            " identity TEXT PRIMARY KEY, result TEXT NOT NULL,"
                            " created_at REAL NOT NULL)")
                con.execute("CREATE INDEX IF NOT EXISTS idx_t ON translations(created_at)")

    def get(self, identity):
        """Return cached result dict or None; expired rows deleted on read."""
        now = time.time()
        with self._lock:
            with self._connect() as con:
                row = con.execute("SELECT result, created_at FROM translations WHERE identity=?",
                                  (identity,)).fetchone()
        if row is None:
            return None
        result, created = row
        if now - created > TTL_S:
            with self._lock:
                with self._connect() as con:
                    con.execute("DELETE FROM translations WHERE identity=?", (identity,))
            return None
        try:
            return json.loads(result)
        except (json.JSONDecodeError, TypeError):
            return None

    def put(self, identity, result):
        blob = json.dumps(result, ensure_ascii=False)
        with self._lock:
            with self._connect() as con:
                con.execute("INSERT OR REPLACE INTO translations(identity, result, created_at) VALUES(?,?,?)",
                            (identity, blob, time.time()))

    def trim(self, max_rows=20000):
        with self._lock:
            with self._connect() as con:
                con.execute("DELETE FROM translations WHERE identity IN ("
                            " SELECT identity FROM translations ORDER BY created_at DESC LIMIT -1 OFFSET ?)",
                            (max_rows,))

URGENT, NORMAL = 0, 1


class ProviderContext:
    """What a queued job must remember about the provider its identity came from.

    Both halves travel together because a job cannot honour one without the
    other: the worker translates with the provider snapshot instead of live
    settings, and the namespace is what tells a late result apart from a current
    one (issue #31). One value, so a job cannot carry one and forget the other.
    """

    __slots__ = ("provider", "namespace")

    def __init__(self, provider, namespace):
        self.provider = provider
        self.namespace = namespace


class TranslationJob:
    __slots__ = ("identity", "priority", "seq", "source_id", "group_idx",
                 "group_text", "prev", "nxt", "expected", "context", "cancelled")

    def __init__(self, identity, priority, source_id, group_idx, group_text,
                 prev="", nxt="", expected=0, context=None):
        self.identity = identity
        # The provider context this identity was computed from (issue #31). None =
        # fall back to live settings (a caller that submits a job without one).
        self.context = context
        self.priority = priority
        self.seq = next(_SEQ)
        self.source_id = source_id
        self.group_idx = group_idx
        self.group_text = group_text
        self.prev = prev
        self.nxt = nxt
        self.expected = expected
        self.cancelled = False

    def sort_key(self):
        return (self.priority, self.seq)


_SEQ = itertools.count()


class TranslationBatch:
    """A window-fill burst submitted as ONE queue entry (spec #24 / ADR-007).

    A batch has no cache identity of its own: members keep the exact identities
    the single path would compute, so the cache stays per-group. The queue's
    take path is batch-aware: at pop time it drops members that are cancelled,
    already in flight, or already cached, then runs the remainder - >= 2 members
    as one translate call, exactly 1 member falling back to the single path
    (steady-state behaviour unchanged). seq comes from the same counter as
    single jobs, so heap ties can never compare heterogeneous objects.
    """

    __slots__ = ("jobs", "priority", "seq", "source_id")

    def __init__(self, jobs):
        self.jobs = list(jobs)
        self.priority = jobs[0].priority
        self.seq = next(_SEQ)
        self.source_id = jobs[0].source_id

    def sort_key(self):
        return (self.priority, self.seq)


class TranslationQueue:
    """Bounded worker pool with priority + in-flight dedup + cancel-by-source.

    submit(job) -> None; on_done(job, result) is called from worker threads.
    cancel_source(source_id) drops every pending (not-yet-started) job of that
    source - the thing both reference repos lack.
    """

    def __init__(self, provider_cfg, cache, workers=5, on_done=None,
                 translate_fn=None, max_pending=400):
        self._cfg = provider_cfg
        self._cache = cache
        self._on_done = on_done or (lambda job, result: None)
        self._translate = translate_fn  # injectable for tests / mock mode
        self._max_pending = max_pending
        self._pending = []            # heap of jobs
        self._inflight = {}           # identity -> job
        self._lock = threading.Lock()
        self._wakeup = threading.Condition(self._lock)
        self._shutdown = False
        self._backoff_until = 0.0     # deep backoff: shed normal jobs
        self._threads = [threading.Thread(target=self._worker, daemon=True,
                                          name="trans-q-%d" % i)
                         for i in range(max(1, workers))]
        for t in self._threads:
            t.start()

    def _pending_ids_locked(self):
        """Identities queued but not started - singles AND batch members."""
        ids = set()
        for _, entry in self._pending:
            if isinstance(entry, TranslationBatch):
                ids.update(j.identity for j in entry.jobs if not j.cancelled)
            elif not entry.cancelled:
                ids.add(entry.identity)
        return ids

    def submit(self, job):
        with self._lock:
            if job.identity in self._inflight:
                return False  # dedup concurrent identical work
            if job.identity in self._pending_ids_locked():
                return False
            if len(self._pending) >= self._max_pending:
                # shed lowest-priority oldest normal jobs first (prefetch shedding)
                self._pending = [e for e in self._pending if e[1].priority == URGENT]
                if len(self._pending) >= self._max_pending:
                    return False
            import heapq
            heapq.heappush(self._pending, (job.sort_key(), job))
            self._wakeup.notify()
        return True

    def submit_batch(self, jobs):
        """Submit several jobs as one batch entry (spec #24). Members already
        inflight or pending are dropped up front; a batch that reduces to one
        member falls back to the single path - "剩一组就退回单组路径"."""
        if not jobs:
            return False
        with self._lock:
            pending_ids = self._pending_ids_locked()
            members = [j for j in jobs
                       if j.identity not in self._inflight and j.identity not in pending_ids]
            if not members:
                return False
            if len(members) == 1:
                single = members[0]
            else:
                import heapq
                entry = TranslationBatch(members)
                heapq.heappush(self._pending, (entry.sort_key(), entry))
                self._wakeup.notify()
                return True
        return self.submit(single)  # lock released: reuse the single path verbatim

    def cancel_source(self, source_id):
        """Drop pending (not-yet-started) work for a source. In-flight requests
        are never touched: their cache identity is playhead-independent, so the
        result is still worth keeping (spec #24 decision 4)."""
        n = 0
        with self._lock:
            for _, entry in self._pending:
                jobs = entry.jobs if isinstance(entry, TranslationBatch) else [entry]
                for job in jobs:
                    if job.source_id == source_id and not job.cancelled:
                        job.cancelled = True
                        n += 1
            self._wakeup.notify_all()
        return n

    def note_rate_limited(self, cooldown_s=8.0):
        with self._lock:
            self._backoff_until = time.time() + cooldown_s

    def in_backoff(self):
        """Is deep backoff active? The engine watches the True -> False edge to
        refill the window after shed prefetch ("退避后补课", spec #24)."""
        with self._lock:
            return time.time() < self._backoff_until

    def stats(self):
        with self._lock:
            return {"pending": len(self._pending), "inflight": len(self._inflight)}

    def shutdown(self):
        with self._lock:
            self._shutdown = True
            self._wakeup.notify_all()

    def _worker(self):
        """Take path (spec #24, decision 12 - batch-aware):

        pop an entry; a batch first drops cancelled / already-in-flight /
        already-cached members, then >= 2 members run as ONE translate call and
        exactly 1 member falls back to the single path. The translate seam is
        `translate_fn(jobs) -> [result per job]` - a length-1 list is exactly
        the pre-batch behaviour.
        """
        import heapq
        while True:
            with self._lock:
                while not self._pending and not self._shutdown:
                    self._wakeup.wait(timeout=0.5)
                if self._shutdown:
                    return
                job = None
                batch = None
                while self._pending and job is None and batch is None:
                    key, cand = heapq.heappop(self._pending)
                    if isinstance(cand, TranslationBatch):
                        members = [j for j in cand.jobs if not j.cancelled]
                        if not members:
                            continue
                        if cand.priority == NORMAL and time.time() < self._backoff_until:
                            continue  # batches are normal-priority: shed under deep backoff
                        members = [j for j in members if j.identity not in self._inflight]
                        members = [j for j in members if self._cache.get(j.identity) is None]
                        if not members:
                            continue
                        if len(members) == 1:
                            job = members[0]
                        else:
                            batch = members
                    else:
                        if cand.cancelled:
                            continue
                        if cand.priority == NORMAL and time.time() < self._backoff_until:
                            continue  # shed prefetch under deep backoff
                        job = cand
                if job is None and batch is None:
                    continue
                running = batch if batch is not None else [job]
                for j in running:
                    self._inflight[j.identity] = j
            try:
                results = self._run(running)
            except Exception as e:  # never let a worker die
                results = [{"error": "WORKER", "message": type(e).__name__ + ": " + str(e)}
                           for _ in running]
            finally:
                with self._lock:
                    for j in running:
                        self._inflight.pop(j.identity, None)
                    self._wakeup.notify()
            for j, res in zip(running, results):
                try:
                    self._on_done(j, res)
                except Exception:
                    pass

    def _run(self, jobs):
        """Execute one translate call for `jobs` (len 1 = single path) and cache
        per-group results. Batch failures are ALL-OR-NOTHING: if any member
        errors, every member is voided with that error - no cache write, no
        partial landing, no placeholder (spec #24, decision 9)."""
        if len(jobs) == 1:
            job = jobs[0]
            cached = self._cache.get(job.identity)
            if cached is not None:
                result = dict(cached)
                result["from_cache"] = True
                return [result]
            results = self._translate([job])
            results = self._coerce_results(results, jobs)
            result = results[0]
            if not result.get("error"):
                self._cache.put(job.identity, result)
            if result.get("error") == "RATE_LIMITED":
                self.note_rate_limited()
            return [result]
        # batch path: one translate call, per-group identities written on success
        results = self._coerce_results(self._translate(jobs), jobs)
        first_err = next((r for r in results if r.get("error")), None)
        if first_err is not None:
            results = [dict(first_err) for _ in jobs]   # whole batch void
        for job, res in zip(jobs, results):
            if not res.get("error"):
                self._cache.put(job.identity, res)
        if first_err is not None and first_err.get("error") == "RATE_LIMITED":
            self.note_rate_limited()
        return results

    @staticmethod
    def _coerce_results(results, jobs):
        """The translate seam must answer one dict per job, in order."""
        if (not isinstance(results, list) or len(results) != len(jobs)
                or any(not isinstance(r, dict) for r in results)):
            return [{"error": "WORKER", "message": "translate returned no result for the job"}
                    for _ in jobs]
        return results