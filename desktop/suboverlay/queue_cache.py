"""Translation cache (SQLite, persistent) + priority queue.

Cache identity = SHA-256 over key-sorted {version, provider, client_key,
instructions, prompt} - never contains the API key (transly rule, MIT).
Queue: bounded worker pool, urgent > normal priority, in-flight dedup,
cancel-pending-by-source (seek / source switch), prefetch shedding
(designs from yt-dual-subs lanes + transly queue, gaps they lack).
"""
import hashlib, json, os, sqlite3, threading, time, itertools

CACHE_VERSION = 1
TTL_S = 30 * 24 * 3600.0


def cache_identity(provider_cfg, client_key, instructions, prompt):
    """SHA-256 identity; api_key intentionally excluded."""
    p = provider_cfg or {}
    payload = {
        "version": CACHE_VERSION,
        "provider": {
            "base_url": p.get("base_url") or "",
            "model": p.get("model") or "",
            "protocol": p.get("protocol") or "auto",
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


class TranslationJob:
    __slots__ = ("identity", "priority", "seq", "source_id", "group_idx",
                 "group_text", "prev", "nxt", "expected", "cancelled")

    def __init__(self, identity, priority, source_id, group_idx, group_text,
                 prev="", nxt="", expected=0):
        self.identity = identity
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

    def submit(self, job):
        with self._lock:
            if job.identity in self._inflight:
                return False  # dedup concurrent identical work
            for _, pj in self._pending:
                if pj.identity == job.identity and not pj.cancelled:
                    return False
            if len(self._pending) >= self._max_pending:
                # shed lowest-priority oldest normal jobs first (prefetch shedding)
                self._pending = [j for j in self._pending if j.priority == URGENT]
                if len(self._pending) >= self._max_pending:
                    return False
            import heapq
            heapq.heappush(self._pending, (job.sort_key(), job))
            self._wakeup.notify()
        return True

    def cancel_source(self, source_id):
        n = 0
        with self._lock:
            for _, job in self._pending:
                if job.source_id == source_id and not job.cancelled:
                    job.cancelled = True
                    n += 1
            self._wakeup.notify_all()
        return n

    def note_rate_limited(self, cooldown_s=8.0):
        with self._lock:
            self._backoff_until = time.time() + cooldown_s

    def stats(self):
        with self._lock:
            return {"pending": len(self._pending), "inflight": len(self._inflight)}

    def shutdown(self):
        with self._lock:
            self._shutdown = True
            self._wakeup.notify_all()

    def _worker(self):
        import heapq
        while True:
            with self._lock:
                while not self._pending and not self._shutdown:
                    self._wakeup.wait(timeout=0.5)
                if self._shutdown:
                    return
                job = None
                while self._pending:
                    key, cand = heapq.heappop(self._pending)
                    if cand.cancelled:
                        continue
                    if cand.priority == NORMAL and time.time() < self._backoff_until:
                        continue  # shed prefetch under deep backoff
                    job = cand
                    break
                if job is None:
                    continue
                self._inflight[job.identity] = job
            try:
                cached = self._cache.get(job.identity)
                if cached is not None:
                    result = dict(cached)
                    result["from_cache"] = True
                else:
                    result = self._translate(job)
                    if not result.get("error"):
                        self._cache.put(job.identity, result)
                    if result.get("error") == "RATE_LIMITED":
                        self.note_rate_limited()
            except Exception as e:  # never let a worker die
                result = {"error": "WORKER", "message": type(e).__name__ + ": " + str(e)}
            finally:
                with self._lock:
                    self._inflight.pop(job.identity, None)
                    self._wakeup.notify()
            try:
                self._on_done(job, result)
            except Exception:
                pass