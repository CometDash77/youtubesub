"""Loopback WebSocket server for PROTOCOL.md v1.

Runs in a daemon thread with its own asyncio loop; valid frames are pushed
into a thread-safe queue.Queue for the Qt side. Security per ADR-003:
bind 127.0.0.1 only, WS Origin allowlist (youtube/localhost/none), /health probe.
"""
import asyncio, http, json, queue, threading

from .protocol import VALID_TYPES, WS_PATH, HEALTH_PATH, STATUS_PATH

MAX_FRAME_BYTES = 8 * 1024 * 1024


def origin_allowed(origin):
    """Allow empty (non-browser client), localhost, or *.youtube.com."""
    if not origin:
        return True
    o = origin.lower()
    if "localhost" in o or "127.0.0.1" in o or "[::1]" in o:
        return True
    return o.endswith("youtube.com") or o.endswith(".youtube.com")


def sanitize_event(msg):
    """Validate an inbound frame into a plain dict event; None for junk.
    Never raises; unknown types are ignored (counted by caller)."""
    if not isinstance(msg, dict):
        return None
    t = msg.get("type")
    if t not in VALID_TYPES or t == "play_pause":
        return None
    sid = msg.get("source_id")
    if t in ("sync", "deactivate") and (not isinstance(sid, str) or not sid):
        return None
    if t in ("register", "cues") and not isinstance(msg.get("source_id"), str):
        return None
    return msg


class WSServer:
    def __init__(self, port, event_queue, on_frame_error=None, status_provider=None):
        self.port = int(port)
        self.events = event_queue
        self._status_provider = status_provider
        self._loop = None
        self._server = None
        self._thread = None
        self._frame_errors = 0
        self._frames_seen = 0
        self._on_frame_error = on_frame_error
        self._error = None

    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True, name="ws-server")
        self._thread.start()

    def stop(self):
        if self._loop and self._server:
            self._loop.call_soon_threadsafe(self._server.close)
        if self._thread:
            self._thread.join(timeout=3.0)

    def _run(self):
        import websockets
        from websockets.asyncio.server import serve

        async def handler(connection):
            try:
                async for raw in connection:
                    if len(raw) > MAX_FRAME_BYTES:
                        continue
                    self._frames_seen += 1
                    try:
                        msg = json.loads(raw)
                    except (json.JSONDecodeError, TypeError, ValueError):
                        self._frame_errors += 1
                        continue
                    ev = sanitize_event(msg)
                    if ev is None:
                        self._frame_errors += 1
                        continue
                    try:
                        self.events.put_nowait(ev)
                    except queue.Full:
                        pass
            except Exception:
                pass

        def process_request(connection, request):  # websockets>=13: 2-arg form
            if request.path == HEALTH_PATH:
                return connection.respond(http.HTTPStatus.OK,
                                          json.dumps({"ok": True, "version": 1}))
            if request.path == STATUS_PATH:
                return connection.respond(http.HTTPStatus.OK,
                                          json.dumps(self._status_payload()))
            if request.path != WS_PATH:
                return connection.respond(http.HTTPStatus.NOT_FOUND, "not found")
            if not origin_allowed(request.headers.get("Origin", "")):
                return connection.respond(http.HTTPStatus.FORBIDDEN, "origin denied")
            return None

        async def main():
            async with serve(handler, "127.0.0.1", self.port,
                             process_request=process_request,
                             max_size=MAX_FRAME_BYTES) as srv:
                self._server = srv
                await srv.serve_forever()

        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(main())
        except asyncio.CancelledError:
            pass
        except Exception as e:
            self._error = type(e).__name__ + ": " + str(e)

    def _status_payload(self):
        """Loopback diagnostics: transport stats + whatever the UI is showing.

        The provider is optional (tests/headless runs omit it) and must never be
        able to break the endpoint, so its failure is reported inline.
        """
        payload = {"ok": True, "version": 1, "stats": self.stats()}
        if self._status_provider is not None:
            try:
                extra = self._status_provider()
                if isinstance(extra, dict):
                    payload.update(extra)
            except Exception as e:  # never 500 the diagnostics route
                payload["status_error"] = type(e).__name__
        return payload

    def stats(self):
        return {"frames": self._frames_seen, "bad_frames": self._frame_errors,
                "error": self._error}