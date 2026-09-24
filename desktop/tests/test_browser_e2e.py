"""Real-browser end-to-end tests (PROGRESS.md section 3.0 A).

Claims under test, all observed through the real GET /status route:
  (a) the injected userscript really hooks the page's own timedtext fetch in a
      real Chrome main world,
  (b) the real browser Origin really passes the WS server's allowlist,
  (c) the real cue text really reaches the Engine and the overlay display state,
  (d) play / pause / seek / rate / SPA navigation really drive the desktop clock.

Everything here is injected at document-start by the harness, so no test pokes
at internals: the only observations are the desktop app's /status and the page's
own video element state (used for failure messages).

Skipped (not failed) when Chrome is not installed. ORDER MATTERS: the SPA test
replaces the page's video and must stay last.
"""
import os
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import browser_e2e as E2E  # noqa: E402

pytestmark = pytest.mark.skipif(E2E.find_chrome() is None,
                                reason="real Chrome not installed")

CUE0 = E2E.cue_text(E2E.VIDEO_A, 0)
CUE2 = E2E.cue_text(E2E.VIDEO_A, 2)
CUE_B0 = E2E.cue_text(E2E.VIDEO_B, 0)
MOCK_MARK = "\u3010\u8bd1\u3011"  # the mock translator's prefix


@pytest.fixture(scope="module")
def h():
    harness = E2E.Harness(headed=False)
    try:
        harness.start()
        harness.open(E2E.VIDEO_A)
    except Exception:
        harness.stop()
        raise
    yield harness
    harness.stop()


def status_until(h, pred, timeout=20.0, what="condition"):
    """Wait until pred(status) holds, then return a fresh status dict."""
    def detail():
        try:
            return {"status": h.status(), "page": h.video_state()}
        except Exception as e:  # noqa: BLE001
            return {"status": h.status(), "page_error": repr(e)}
    E2E.wait_for(lambda: pred(h.status()) or None, timeout=timeout,
                 what=what, detail=detail)
    status = h.status()
    state = status.get("trans_state")
    assert state in {"idle", "waiting", "translating", "unconfigured", "ready"} \
        or (isinstance(state, str) and state.startswith("failed:")
            and 0 < len(state[len("failed:"):]) <= 16), status
    return status


class CountingProvider:
    """Local OpenAI-compatible endpoint for proving browser-driven scheduling."""

    def __init__(self):
        self.requests = []
        self.lock = threading.Lock()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                with owner.lock:
                    owner.requests.append(body)
                system = body.get("messages", [{}])[0].get("content", "")
                match = re.search(r"exactly (\d+) lines", system)
                content = ("\n".join("%d|translated" % n
                                     for n in range(1, int(match.group(1)) + 1))
                           if match else "translated")
                data = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.config = {"base_url": "http://127.0.0.1:%d/v1" % self.server.server_address[1],
                       "api_key": "test-key", "model": "test-model",
                       "protocol": "chat-completions", "mock": False,
                       "timeout_s": 2, "max_retries": 0}

    def count(self):
        with self.lock:
            return len(self.requests)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


def test_real_userscript_connects_and_registers_a_source(h):
    """(a)(b): the injected script probes /health, opens a real WS with the page's
    Origin, and the server accepts it (frames counted server-side)."""
    # The page issues this fetch by itself (a player with captions enabled); no
    # test calls into the page, so the server-side counter is the "the script's
    # hook really saw a real request" signal.
    E2E.wait_for(lambda: len(h.fixture.timedtext_requests) >= 1, timeout=10,
                 what="the fixture page's own timedtext fetch")
    st = status_until(h, lambda s: int(s.get("sources") or 0) >= 1
                      and int(s.get("stats", {}).get("frames") or 0) >= 2,
                      what="one registered source and >=2 real WS frames")
    assert st["stats"]["bad_frames"] == 0, st["stats"]


def test_real_timedtext_becomes_the_exact_subtitle(h):
    """(a)(c): the cue text the desktop shows is byte-for-byte the fixture's, and
    the mock translation of it arrives through the real queue."""
    h.cdp.evaluate("__fixture.pause(); __fixture.seek(1.0);")
    st = status_until(h, lambda s: s.get("state") == "ok" and s.get("orig") == CUE0,
                      what="orig == %r" % CUE0)
    assert st["state"] == "ok"
    st = status_until(h, lambda s: MOCK_MARK in (s.get("trans") or ""),
                      what="a translated line for the first cue")
    assert st["trans"].startswith(MOCK_MARK)
    assert st["trans_state"] == "ready", st
    assert E2E.cue_text(E2E.VIDEO_A, 0) in st["trans"], st["trans"]


def test_original_only_browser_cues_do_not_reach_provider_until_mode_switch():
    provider = CountingProvider()
    harness = E2E.Harness(desktop_options={
        "mode": "orig", "provider": provider.config, "mode_control": True})
    try:
        harness.start()
        harness.open(E2E.VIDEO_A)
        harness.cdp.evaluate("__fixture.pause(); __fixture.seek(1.0);")
        st = status_until(harness, lambda s: s.get("state") == "ok"
                          and s.get("orig") == CUE0,
                          what="the real browser cue while the overlay is original-only")
        assert st["mode"] == "orig" and st["trans_state"] == "idle", st
        assert provider.count() == 0, \
            "real browser cues must not trigger urgent or prefetch provider requests"

        harness.app.set_mode("bilingual")
        status_until(harness, lambda s: s.get("mode") == "bilingual",
                     what="the test controller's translation-mode change")
        st = status_until(harness, lambda s: s.get("trans_state") == "ready",
                          what="a translation after switching modes")
        assert st["trans"], st
        assert provider.count() > 0, \
            "switching back to a translation mode must start work from the current cue"
    finally:
        harness.stop()
        provider.stop()


def test_play_pause_reaches_the_desktop_clock(h):
    """(d) play/pause: the state crosses the wire and a paused clock freezes."""
    h.cdp.evaluate("__fixture.seek(0.0); __fixture.play();")
    status_until(h, lambda s: s.get("playing") is True, what="playing == True")
    h.cdp.evaluate("__fixture.pause();")
    status_until(h, lambda s: s.get("playing") is False, what="playing == False")
    h.cdp.evaluate("__fixture.seek(1.0);")
    first = status_until(h, lambda s: s.get("orig") == CUE0,
                         what="the cue at the seek target")
    time.sleep(1.2)
    assert h.status().get("orig") == first["orig"], "a paused desktop clock must not advance"


def test_playback_rate_reaches_the_desktop_clock(h):
    """(d) rate: 2.0x must show up in the desktop's display state."""
    h.cdp.evaluate("__fixture.rate(2);")
    st = status_until(h, lambda s: s.get("rate") == 2.0, what="rate == 2.0")
    assert st["playing"] in (True, False)
    h.cdp.evaluate("__fixture.rate(1);")
    status_until(h, lambda s: s.get("rate") == 1.0, what="rate back to 1.0")


def test_seek_moves_the_subtitle(h):
    """(d) seek: jumping to the third cue must change what the overlay shows."""
    h.cdp.evaluate("__fixture.pause(); __fixture.seek(6.5);")
    status_until(h, lambda s: s.get("orig") == CUE2, what="orig == %r" % CUE2)


def test_spa_navigation_creates_a_new_source_without_stale_cues(h):
    """(d) SPA: history.pushState to another video id must produce a NEW source;
    the previous video's cues must not survive into it. ORDER: keep this last."""
    before = h.status().get("active_source")
    assert before, "expected an active source before navigating"
    assert h.cdp.evaluate("__fixture.switchVideo()") == E2E.VIDEO_B
    status_until(h, lambda s: s.get("active_source") not in (None, "", before),
                 timeout=25.0, what="a new active_source after pushState")
    h.cdp.evaluate("__fixture.pause(); __fixture.seek(1.0);")
    st = status_until(h, lambda s: s.get("orig") == CUE_B0,
                      timeout=25.0, what="orig == %r (the new video's cue)" % CUE_B0)
    assert "ALPHA" not in (st.get("orig") or ""), "stale cue from the previous video"


def test_userscript_reports_no_console_errors(h):
    """A silent failure mode would be an injection that never happened; the script
    logs that itself, and any uncaught page exception would surface here too."""
    messages = [m for m in h.cdp.console_errors() if m]
    script_errors = [m for m in messages
                     if "[youtubesub]" in str(m) or "injection failed" in str(m)]
    assert not script_errors, script_errors
    assert not [m for m in messages if "port override failed" in str(m)], messages
