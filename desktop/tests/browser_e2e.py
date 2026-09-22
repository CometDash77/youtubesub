"""Real-browser end-to-end harness for youtubesub (PROGRESS.md section 3.0 A).

What is REAL in here:
  * a real Chrome (headed or headless) driven over CDP,
  * the real userscript file, injected at document-start
    (Page.addScriptToEvaluateOnNewDocument) with a GM_* shim, i.e. the
    equivalent of Tampermonkey's @run-at document-start,
  * a fixture page with a real <video> playing a generated WAV, issuing its own
    timedtext fetch the way the YouTube player does (json3 + rotating pot),
  * the real desktop app (desktop/app.py) as a child process: real WSServer,
    real Engine, real overlay, mock translation,
  * GET /status as the ONLY observation port - no test reaches into internals.

Two ways to use it:
    python desktop/tests/browser_e2e.py --demo   # headed, human-in-the-loop
    pytest desktop/tests -q                      # test_browser_e2e.py drives it

The GM shim is required because bare CDP injection has no userscript sandbox:
--disable-web-security (test-only, never in production) stands in for the CORS
bypass a real GM_xmlhttpRequest grant provides, and a fresh --user-data-dir
keeps the user's own Chrome and profile untouched.
"""
from __future__ import annotations

import argparse
import asyncio
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP_DIR = os.path.dirname(HERE)
PROJECT_DIR = os.path.dirname(DESKTOP_DIR)
USERSCRIPT_PATH = os.path.join(PROJECT_DIR, "userscript", "youtubesub.user.js")

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]

# ---- fixture content (the expected values are literals, not recomputed) ----
VIDEO_A = "aaaaaaaaaaa"
VIDEO_B = "bbbbbbbbbbb"
TRACK_PREFIX = {VIDEO_A: "FIXTURE ALPHA", VIDEO_B: "FIXTURE BETA"}
CUE_STARTS_MS = (800, 3000, 6000)
# Sentence-final periods: the segmentation criteria (#22/ADR-006) cut groups at
# punctuation, so each fixture line stays its own group and the mock translation
# of the first cue is exactly that cue's text.
CUE_WORDS = ("one.", "two.", "three.")


def cue_text(video_id, index):
    """The exact sentence the fixture emits; tests assert against this literal."""
    return "%s %s" % (TRACK_PREFIX.get(video_id, "FIXTURE ALPHA"), CUE_WORDS[index])


def track_payload(video_id):
    prefix = TRACK_PREFIX.get(video_id, "FIXTURE ALPHA")
    return {"events": [
        {"tStartMs": s, "dDurationMs": 2200,
         "segs": [{"utf8": "%s %s" % (prefix, w), "tOffsetMs": 100}]}
        for s, w in zip(CUE_STARTS_MS, CUE_WORDS)]}


# ---- small OS helpers ----
def find_chrome():
    for p in CHROME_CANDIDATES:
        if p and os.path.exists(p):
            return p
    return None


def free_port():
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def make_wav(path, seconds=60.0, rate=8000):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))
    return path


def http_get_json(port, path, timeout=5.0):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        return resp.status, json.loads(resp.read().decode("utf-8"))
    finally:
        conn.close()


def wait_for(pred, timeout=15.0, interval=0.15, what="condition", detail=None):
    """Poll pred() until it is truthy; raise AssertionError carrying the last
    observed value so a red run says what the black box actually reported."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = pred()
        if last:
            return last
        time.sleep(interval)
    seen = detail() if detail else last
    raise AssertionError("timed out after %.1fs waiting for %s (last observed: %r)"
                         % (timeout, what, seen))


# ---- GM shim + userscript injection ----
GM_SHIM = r"""
// Minimal Tampermonkey shim for the two grants the script declares.
window.GM_addElement = function (tag, attrs) {
  var el = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) {
    if (k === 'textContent' || k === 'innerHTML') el[k] = attrs[k];
    else el.setAttribute(k, attrs[k]);
  });
  (document.head || document.documentElement).appendChild(el);
  return el;
};
window.GM_xmlhttpRequest = function (o) {
  fetch(o.url, { method: o.method || 'GET' }).then(function (r) {
    if (o.onload) o.onload({ status: r.status, responseText: '', finalUrl: r.url });
  }).catch(function (e) {
    if (o.onerror) o.onerror({ error: String(e), errorText: String(e) });
  });
};
"""


def injection_source(app_port):
    """GM shim + the real userscript + a port override.

    The app runs on a free port so the harness cannot collide with a desktop app
    the user already has open; the override runs before DOMContentLoaded, i.e.
    before the script's boot() connects.
    """
    with open(USERSCRIPT_PATH, "r", encoding="utf-8") as f:
        script = f.read()
    return ("%s\n%s\ntry { window.__youtubesub.cfg.port = %d; } catch (e) "
            "{ console.error('[e2e] port override failed', e); }\n"
            % (GM_SHIM, script, app_port))


PAGE_TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>__TITLE__</title></head>
<body style="font:13px Consolas,monospace;background:#111;color:#ddd;padding:10px">
<h3 style="margin:4px 0">youtubesub fixture page (real video element, real timedtext fetch)</h3>
<p style="margin:4px 0;color:#999;max-width:900px">
Plays a generated WAV through a real video element and fetches a json3 timedtext payload
the way the YouTube player does (rotating pot token). The userscript under test is injected at
document-start; the desktop app is the only observer that matters (GET /status).</p>
<div>
<button onclick="__fixture.requestSubtitles()">Load captions</button>
<button onclick="__fixture.play()">Play</button>
<button onclick="__fixture.pause()">Pause</button>
<button onclick="__fixture.seek(__fixture.now()+2)">+2s</button>
<button onclick="__fixture.seek(__fixture.now()-2)">-2s</button>
<button onclick="__fixture.rate(2)">2.0x</button>
<button onclick="__fixture.rate(1)">1.0x</button>
<button onclick="__fixture.switchVideo()">SPA: switch video</button>
</div>
<video id="v" src="/media.wav" preload="auto" controls muted></video>
<div id="readout" style="margin-top:6px"></div>
<script>
var VIDEOS = __VIDEOS__;
var v = document.getElementById('v');
function currentVideo() {
  var m = /[?&]v=([\w-]{6,})/.exec(location.search);
  return m ? m[1] : VIDEOS[0];
}
function requestSubtitles(vid) {
  vid = vid || currentVideo();
  var url = '/youtube/api/timedtext?v=' + vid + '&lang=en&kind=asr&fmt=json3&pot=' + Date.now();
  return fetch(url).then(function (r) { return r.json(); });
}
window.__fixture = {
  requestSubtitles: requestSubtitles,
  play: function () { return v.play(); },
  pause: function () { v.pause(); },
  seek: function (t) { v.currentTime = Math.max(0, t); return v.currentTime; },
  rate: function (r) { v.playbackRate = r; return v.playbackRate; },
  now: function () { return v.currentTime; },
  video: function () { return currentVideo(); },
  switchVideo: function () {
    var next = VIDEOS[(VIDEOS.indexOf(currentVideo()) + 1) % VIDEOS.length];
    history.pushState({}, '', '/watch?v=' + next);
    document.title = 'Fixture page ' + next;
    setTimeout(function () { requestSubtitles(next); }, 2000);
    return next;
  }
};
['play','pause','seeked','ratechange','timeupdate','loadedmetadata'].forEach(function (e) {
  v.addEventListener(e, function () {
    document.getElementById('readout').textContent =
      'video=' + currentVideo() + '  t=' + v.currentTime.toFixed(2) + 's  paused=' + v.paused +
      '  rate=' + v.playbackRate + '  last=' + e;
  });
});
// A player with captions enabled asks for the track shortly after load and then
// starts playing on its own (a muted local fixture, so autoplay is allowed).
setTimeout(function () {
  requestSubtitles().catch(function () {}).then(function () { return v.play(); })
    .catch(function (e) { console.warn('[fixture] autoplay blocked', e); });
}, 400);
</script>
</body></html>"""


class FixtureServer:
    """127.0.0.1 fixture origin: /watch, /youtube/api/timedtext, /media.wav.

    The origin is deliberately a bare 127.0.0.1 (not *.localhost): the WS
    server's origin allowlist matches on the literal "127.0.0.1" and a
    public-looking hostname would be rejected with 403.
    """

    def __init__(self, wav_seconds=60.0):
        self._tmp = tempfile.mkdtemp(prefix="ytus-fixture-")
        self._wav = make_wav(os.path.join(self._tmp, "media.wav"), seconds=wav_seconds)
        with open(self._wav, "rb") as f:
            self._wav_bytes = f.read()
        self.timedtext_requests = []
        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), self._make_handler())
        self._httpd.daemon_threads = True
        self.port = self._httpd.server_address[1]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    @property
    def origin(self):
        return "http://127.0.0.1:%d" % self.port

    def watch_url(self, video_id):
        return "%s/watch?v=%s" % (self.origin, video_id)

    def _make_handler(server):
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def handle_error(self, request, client_address):
                pass  # Chrome resets keep-alive sockets at shutdown; not interesting

            def _send(self, code, body, ctype, extra=None):
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Accept-Ranges", "bytes")
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                url = urlparse(self.path)
                query = parse_qs(url.query)
                if url.path == "/watch":
                    vid = (query.get("v") or [VIDEO_A])[0]
                    page = (PAGE_TEMPLATE
                            .replace("__VIDEOS__", json.dumps([VIDEO_A, VIDEO_B]))
                            .replace("__TITLE__", "Fixture page " + vid))
                    self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")
                elif url.path.endswith("/api/timedtext"):
                    vid = (query.get("v") or [VIDEO_A])[0]
                    server.timedtext_requests.append(self.path)
                    body = json.dumps(track_payload(vid)).encode("utf-8")
                    self._send(200, body, "application/json")
                elif url.path == "/media.wav":
                    self._send_wav()
                else:
                    self._send(404, b"not found", "text/plain")

            def _send_wav(self):
                body = server._wav_bytes
                total = len(body)
                rng = self.headers.get("Range")
                if rng and rng.startswith("bytes="):
                    spec = rng[6:].split(",")[0]
                    a, _, b = spec.partition("-")
                    start = int(a) if a.strip() else 0
                    end = int(b) if b.strip() else total - 1
                    end = min(end, total - 1)
                    if start > end:
                        self.send_response(416)
                        self.send_header("Content-Range", "bytes */%d" % total)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    chunk = body[start:end + 1]
                    self.send_response(206)
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, total))
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Length", str(len(chunk)))
                    self.end_headers()
                    self.wfile.write(chunk)
                else:
                    self._send(200, body, "audio/wav")

        return Handler

    def stop(self):
        try:
            self._httpd.shutdown()
            self._httpd.server_close()
        finally:
            shutil.rmtree(self._tmp, ignore_errors=True)


class CDP:
    """Tiny Chrome DevTools Protocol client (no puppeteer, just websockets)."""

    def __init__(self, ws_url, timeout=20.0):
        import websockets  # noqa: F401  (import here so the module stays importable without it)
        self._ws_url = ws_url
        self._loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self._ws = None
        self._pending = {}
        self._id = 0
        self.events = []
        self._thread = threading.Thread(target=self._run, daemon=True, name="cdp")
        self._thread.start()
        if not self._ready.wait(timeout):
            raise RuntimeError("CDP websocket did not connect in %.0fs" % timeout)

    def _run(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._main())

    async def _main(self):
        import websockets
        async with websockets.connect(self._ws_url, max_size=32 * 1024 * 1024) as ws:
            self._ws = ws
            self._ready.set()
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if "id" in msg:
                    fut = self._pending.pop(msg["id"], None)
                    if fut is not None and not fut.done():
                        fut.set_result(msg)
                else:
                    if len(self.events) < 2000:
                        self.events.append(msg)

    def call(self, method, params=None, timeout=20.0):
        if self._ws is None:
            raise RuntimeError("CDP not connected")
        self._id += 1
        mid = self._id

        async def go():
            fut = self._loop.create_future()
            self._pending[mid] = fut
            await self._ws.send(json.dumps({"id": mid, "method": method,
                                            "params": params or {}}))
            return await fut

        cf = asyncio.run_coroutine_threadsafe(go(), self._loop)
        try:
            return cf.result(timeout)
        finally:
            cf.cancel()

    def evaluate(self, expression, await_promise=False):
        msg = self.call("Runtime.evaluate", {"expression": expression,
                                             "returnByValue": True,
                                             "awaitPromise": bool(await_promise)})
        result = msg.get("result", {})
        if "error" in msg:
            raise RuntimeError("CDP error: %s" % json.dumps(msg["error"])[:300])
        if "exceptionDetails" in result:
            raise RuntimeError("page exception for %r: %s"
                               % (expression[:80], json.dumps(result["exceptionDetails"])[:400]))
        return result.get("result", {}).get("value")

    def console_messages(self):
        """Every console call, page exception and browser Log entry.

        Log entries matter for the live (real-site) mode: a Content-Security-Policy
        block of the injected page hook does not raise a console API error, it only
        shows up here.
        """
        out = []
        for ev in self.events:
            method = ev.get("method")
            if method == "Runtime.consoleAPICalled":
                p = ev.get("params", {})
                args = [a.get("value", a.get("description", "")) for a in p.get("args", [])]
                out.append((p.get("type", "log"), " ".join(str(a) for a in args)))
            elif method == "Runtime.exceptionThrown":
                d = ev.get("params", {}).get("exceptionDetails", {})
                out.append(("exception", str(d.get("exception", {}).get("description")
                                              or d.get("text"))))
            elif method == "Log.entryAdded":
                e = ev.get("params", {}).get("entry", {})
                out.append(("log:" + str(e.get("level")),
                            "%s %s" % (e.get("source", ""), e.get("text", ""))))
        return out

    def console_errors(self):
        """User-visible console errors + uncaught page exceptions."""
        out = []
        for ev in self.events:
            if ev.get("method") == "Runtime.consoleAPICalled" and \
                    ev.get("params", {}).get("type") in ("error", "assert"):
                args = [a.get("value", a.get("description", ""))
                        for a in ev["params"].get("args", [])]
                out.append(" ".join(str(a) for a in args))
            elif ev.get("method") == "Runtime.exceptionThrown":
                d = ev.get("params", {}).get("exceptionDetails", {})
                out.append(str(d.get("exception", {}).get("description") or d.get("text")))
        return out

    def close(self):
        try:
            if self._ws is not None:
                asyncio.run_coroutine_threadsafe(self._ws.close(), self._loop).result(5)
        except Exception:
            pass
        try:
            self._loop.call_soon_threadsafe(self._loop.stop)
        except Exception:
            pass


class Chrome:
    """A private Chrome instance: own profile dir, own debug port, own process."""

    def __init__(self, headed=False, proxy=None, log_dir=None):
        self.exe = find_chrome()
        if not self.exe:
            raise RuntimeError("no Chrome found (looked at: %s)" % ", ".join(CHROME_CANDIDATES))
        self.headed = headed
        self.proxy = proxy
        self.log_dir = log_dir or tempfile.mkdtemp(prefix="ytus-chrome-")
        self.profile = tempfile.mkdtemp(prefix="ytus-profile-")
        self.port = free_port()
        self.proc = None
        self.cdp = None

    def flags(self):
        f = []
        if not self.headed:
            f.append("--headless=new")
        f += [
            "--remote-debugging-port=%d" % self.port,
            "--remote-allow-origins=*",
            "--user-data-dir=" + self.profile,
            "--no-first-run", "--no-default-browser-check",
            "--autoplay-policy=no-user-gesture-required", "--mute-audio",
            # test-only CORS bypass: bare CDP injection has no GM_xmlhttpRequest
            # grant, so the script's cross-origin /health probe would be blocked.
            # Production runs under Tampermonkey and never needs this.
            "--disable-web-security",
            "--window-size=980,700", "--window-position=80,60",
        ]
        if self.proxy:
            f += ["--proxy-server=" + self.proxy,
                  "--proxy-bypass-list=127.0.0.1;localhost"]
        else:
            f.append("--no-proxy-server")
        f.append("about:blank")
        return f

    def start(self, log_path):
        self._log = open(log_path, "wb")
        self._log_path = log_path
        self.proc = subprocess.Popen([self.exe] + self.flags(),
                                     stdout=self._log, stderr=subprocess.STDOUT)

    def page_ws_url(self, timeout=25.0):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            try:
                status, data = http_get_json(self.port, "/json/list", timeout=3)
                if status == 200:
                    pages = [t for t in data if t.get("type") == "page"]
                    if pages:
                        return pages[0]["webSocketDebuggerUrl"]
            except Exception as e:
                last = e
            time.sleep(0.25)
        tail = ""
        try:
            with open(self._log_path, "rb") as f:
                tail = f.read()[-1500:].decode("utf-8", "replace")
        except Exception:
            pass
        raise RuntimeError("Chrome debug port never came up (%s). Chrome log tail:\n%s"
                           % (last, tail))

    def stop(self):
        if self.cdp is not None:
            self.cdp.close()
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"],
                               capture_output=True)
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        try:
            self._log.close()
        except Exception:
            pass
        shutil.rmtree(self.profile, ignore_errors=True)


class DesktopApp:
    """The real entry point: python desktop/app.py, with a private APPDATA.

    A private APPDATA means settings.load() sees provider.mock=true and a free
    port, so a run never touches the user's real settings (%APPDATA%/SubOverlay)
    and never talks to a real translation API.
    """

    def __init__(self, port, offscreen=True):
        self.port = port
        self.offscreen = offscreen
        self.appdata = tempfile.mkdtemp(prefix="ytus-appdata-")
        self.log_path = os.path.join(self.appdata, "app.log")
        d = os.path.join(self.appdata, "SubOverlay")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "setting.json"), "w", encoding="utf-8") as f:
            json.dump({
                "server": {"port": port},
                "provider": {"base_url": "", "api_key": "", "model": "",
                             "protocol": "auto", "mock": True},
                "window": {"x": 220, "y": 150, "w": 780, "h": 130},
            }, f, indent=2)
        self.proc = None

    def start(self):
        env = dict(os.environ)
        env["APPDATA"] = self.appdata
        if self.offscreen:
            env["QT_QPA_PLATFORM"] = "offscreen"
        self._log = open(self.log_path, "wb")
        self.proc = subprocess.Popen([sys.executable, os.path.join(DESKTOP_DIR, "app.py")],
                                     cwd=DESKTOP_DIR, env=env,
                                     stdout=self._log, stderr=subprocess.STDOUT)

    def wait_healthy(self, timeout=30.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("desktop/app.py exited early (code %s):\n%s"
                                   % (self.proc.returncode, self.log_tail()))
            try:
                status, data = http_get_json(self.port, "/health", timeout=2)
                if status == 200 and data.get("ok"):
                    return True
            except Exception:
                pass
            time.sleep(0.25)
        raise RuntimeError("desktop/app.py never answered /health on port %d:\n%s"
                           % (self.port, self.log_tail()))

    def log_tail(self, limit=3000):
        try:
            with open(self.log_path, "rb") as f:
                return f.read()[-limit:].decode("utf-8", "replace")
        except Exception:
            return ""

    def stop(self):
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"],
                               capture_output=True)
        try:
            self._log.close()
        except Exception:
            pass
        shutil.rmtree(self.appdata, ignore_errors=True)


class Harness:
    """One running scenario: fixture origin + real app + real Chrome + real script."""

    def __init__(self, headed=False, proxy=None, bypass_csp=False):
        self.headed = headed
        self.proxy = proxy
        # Live mode only: a real GM_addElement injects from the extension context,
        # so it bypasses the page's CSP *and* Trusted Types. Bare CDP injection has
        # no such privilege, so the harness asks Chrome to drop CSP for the page -
        # otherwise a live run fails for a harness reason, not a product reason.
        self.bypass_csp = bypass_csp
        self.fixture = None
        self.app = None
        self.chrome = None
        self.cdp = None
        self.app_port = None
        self._tmp = tempfile.mkdtemp(prefix="ytus-e2e-")

    # ---- lifecycle ----
    def start(self):
        self.fixture = FixtureServer()
        self.app_port = free_port()
        self.app = DesktopApp(self.app_port, offscreen=not self.headed)
        self.app.start()
        self.app.wait_healthy()
        self.chrome = Chrome(headed=self.headed, proxy=self.proxy, log_dir=self._tmp)
        self.chrome.start(os.path.join(self._tmp, "chrome.log"))
        self.chrome.cdp = CDP(self.chrome.page_ws_url())
        self.cdp = self.chrome.cdp
        self.cdp.call("Page.enable")
        self.cdp.call("Runtime.enable")
        self.cdp.call("Log.enable")  # CSP violations only appear in the browser Log
        if self.bypass_csp:
            self.cdp.call("Page.setBypassCSP", {"enabled": True})
        self.cdp.call("Page.addScriptToEvaluateOnNewDocument",
                      {"source": injection_source(self.app_port)})
        return self

    def open(self, video_id=VIDEO_A):
        self.cdp.call("Page.navigate", {"url": self.fixture.watch_url(video_id)})
        wait_for(lambda: self.cdp.evaluate("document.readyState") == "complete",
                 timeout=20, what="document.readyState == complete")
        # The port override must have applied, otherwise the script is talking to
        # some other (or no) desktop app and every later assertion is meaningless.
        port = wait_for(lambda: self.cdp.evaluate(
            "window.__youtubesub && window.__youtubesub.cfg.port"), timeout=10,
            what="userscript cfg.port override")
        assert port == self.app_port, ("userscript talks to port %r, app is on %r"
                                       % (port, self.app_port))

    def stop(self):
        for closer in (lambda: self.chrome and self.chrome.stop(),
                       lambda: self.app and self.app.stop(),
                       lambda: self.fixture and self.fixture.stop()):
            try:
                closer()
            except Exception:
                pass
        shutil.rmtree(self._tmp, ignore_errors=True)

    # ---- observation ports ----
    def status(self):
        try:
            status, data = http_get_json(self.app_port, "/status", timeout=5)
            return data if status == 200 else {}
        except Exception:
            return {}

    def video_state(self):
        """What the fixture page thinks is happening (for failure messages)."""
        return self.cdp.evaluate(
            "JSON.stringify({t: document.getElementById('v').currentTime,"
            " paused: document.getElementById('v').paused,"
            " rate: document.getElementById('v').playbackRate,"
            " video: __fixture.video(), src: location.search})")


# ---- live (real site) mode: an independent tracer separates the three links ----
LIVE_TRACER = r"""
(function () {
  if (window.__e2e_urls) return 'already installed';
  window.__e2e_urls = [];
  var f = window.fetch;
  if (f) {
    window.fetch = function () {
      try { window.__e2e_urls.push(String((arguments[0] && arguments[0].url) || arguments[0])); } catch (e) {}
      return f.apply(this, arguments);
    };
  }
  var oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { window.__e2e_urls.push(String(u)); } catch (e) {}
    return oo.apply(this, arguments);
  };
  return 'installed';
})()"""

LIVE_BOOTSTRAP = r"""
(function () {
  var out = {};
  var b = document.querySelector('.ytp-subtitles-button');
  if (b) { b.click(); out.ccButton = 'clicked'; } else { out.ccButton = 'missing'; }
  var p = document.querySelector('#movie_player');
  if (!p) { out.player = 'missing'; return JSON.stringify(out); }
  out.player = 'ok';
  try {
    var tl = (p.getOption && p.getOption('captions', 'tracklist')) || [];
    out.tracklist = tl.map(function (t) { return t.languageCode; });
    if (p.loadModule) p.loadModule('captions');
    var pick = null;
    for (var i = 0; i < tl.length; i++) {
      if (/^en/.test(tl[i].languageCode)) { pick = tl[i].languageCode; break; }
    }
    if (!pick && tl.length) pick = tl[0].languageCode;
    if (pick && p.setOption) { p.setOption('captions', 'track', { languageCode: pick }); out.picked = pick; }
    if (p.mute) p.mute();
    if (p.playVideo) p.playVideo();
  } catch (e) { out.apiError = String(e); }
  return JSON.stringify(out);
})()"""

LIVE_PROBE = r"""
(function () {
  var p = document.querySelector('#movie_player');
  var seg = document.querySelector('.ytp-caption-segment');
  var urls = (window.__e2e_urls || []).filter(function (u) { return /timedtext|srv3|json3/i.test(u); });
  var ys = window.__youtubesub;
  return JSON.stringify({
    player: !!p,
    playerState: p && p.getPlayerState ? p.getPlayerState() : null,
    t: p && p.getCurrentTime ? Math.round(p.getCurrentTime() * 10) / 10 : null,
    captionDom: seg ? seg.textContent.slice(0, 70) : null,
    timedtextSeenByTracer: urls.length,
    timedtextSample: urls.length ? urls[urls.length - 1].slice(0, 80) : null,
    script: ys ? ys.instance.state : 'NOT INJECTED',
    hookError: ys ? (ys.instance.hookError || '') : null,
    bridgeTrackKey: ys ? (ys.instance.trackKey || '') : '',
    bridgeCueCount: ys ? ys.instance.cueCount : null
  });
})()"""

LIVE_BANNER = """\
==============================================================================
 LIVE MODE - the real userscript injected into a real site (no Tampermonkey)
==============================================================================
 A real Chrome (private profile, CORS checks off to stand in for the GM grant)
 is pointed at the URL you gave, the real userscript is injected at
 document-start, and the real desktop app runs with throwaway mock settings, so
 your own settings and API key are NOT used.

 The report below separates the three possible failure points:
   timedtextSeenByTracer   the SITE really fetched a caption track
   bridgeTrackKey          the userscript's page hook really caught it
   app orig/trans          the desktop app really received cues
 When a real caption arrives it prints CAPTURED. Ctrl+C stops everything.
"""


def live(url, proxy=None, seconds=0.0, headed=True):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    h = Harness(headed=headed, proxy=proxy, bypass_csp=True)
    h.start()
    print(LIVE_BANNER)
    print("app: http://127.0.0.1:%d/status" % h.app_port)
    seen = 0
    try:
        h.cdp.call("Page.navigate", {"url": url})
        wait_for(lambda: h.cdp.evaluate("document.readyState") == "complete",
                 timeout=45, what="the page to load")
        time.sleep(3)
        print("tracer  :", h.cdp.evaluate(LIVE_TRACER))
        print("captions:", h.cdp.evaluate(LIVE_BOOTSTRAP))
        started = time.time()
        while True:
            if seconds and time.time() - started > seconds:
                break
            st = h.status()
            print("--- page : %s" % h.cdp.evaluate(LIVE_PROBE))
            print("    app  : state=%s playing=%s sources=%s orig=%r trans=%r"
                  % (st.get("state"), st.get("playing"), st.get("sources"),
                     (st.get("orig") or "")[:70], (st.get("trans") or "")[:40]))
            msgs = h.cdp.console_messages()
            for kind, text in msgs[seen:]:
                print("    %-10s %s" % (kind, text[:170]))
            seen = len(msgs)
            if st.get("orig"):
                print("    >>> CAPTURED real caption text through the whole chain")
            time.sleep(5)
    except KeyboardInterrupt:
        print("\nstopping...")
    finally:
        h.stop()
    return 0


BANNER = """\
================================================================================
 DEMO MODE - the real browser -> real desktop chain, no Tampermonkey, no API key
================================================================================
 * Chrome window: fixture page with a real video element (a generated 60s WAV)
   that fetches a json3 caption track the way the YouTube player does.
 * A separate overlay window is the real desktop app (desktop/app.py) running
   with throwaway settings, so your own settings and API key are NOT used.
 * Within ~2s the overlay should show   FIXTURE ALPHA one   plus a second line
   starting with the mock translator marker, which is what proves the link works.

Try by hand:
   Load captions / Play / Pause / +2s / -2s / 2.0x / 1.0x / "SPA: switch video"
   Drag and resize the overlay; right-click it for mode / font / opacity / Quit.
   Playing the video should move the subtitle line by line; pausing must freeze it.
This Chrome has CORS checks disabled on purpose (it stands in for Tampermonkey's
GM_xmlhttpRequest grant) and uses its own profile: your Chrome is untouched.
Press Ctrl+C to stop everything.
"""


def demo(proxy=None, seconds=0.0):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    h = Harness(headed=True, proxy=proxy)
    h.start()
    h.open(VIDEO_A)
    print(BANNER)
    print("fixture page : %s" % h.fixture.watch_url(VIDEO_A))
    print("desktop app  : http://127.0.0.1:%d/status  (live view)" % h.app_port)
    last = None
    started = time.time()
    try:
        while True:
            if seconds and time.time() - started > seconds:
                break
            st = h.status() or {}
            line = ("state=%-8s playing=%-5s rate=%-4s orig=%-28s trans=%s"
                    % (st.get("state", "?"), st.get("playing"), st.get("rate"),
                       (st.get("orig") or "")[:28], (st.get("trans") or "")[:40]))
            if line != last:
                print("  " + line)
                last = line
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\nstopping...")
    finally:
        h.stop()
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="youtubesub real-browser E2E harness")
    ap.add_argument("--demo", action="store_true",
                    help="headed Chrome + visible overlay, human drives it")
    ap.add_argument("--proxy", default=None,
                    help="route Chrome through a proxy (needed for real youtube.com)")
    ap.add_argument("--seconds", type=float, default=0.0,
                    help="auto-stop after N seconds (0 = run until Ctrl+C)")
    ap.add_argument("--live", metavar="URL", default=None,
                    help="open this URL instead of the fixture page (real site)")
    ap.add_argument("--headless", action="store_true",
                    help="with --live: no browser window (scripted diagnosis)")
    args = ap.parse_args(argv)
    if args.live:
        return live(args.live, args.proxy, args.seconds, headed=not args.headless)
    if not args.demo:
        ap.print_help()
        return 0
    return demo(args.proxy, args.seconds)


if __name__ == "__main__":
    sys.exit(main())
