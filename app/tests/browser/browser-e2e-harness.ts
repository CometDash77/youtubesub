// Real-browser end-to-end harness for youtubesub - the port of
// desktop/tests/browser_e2e.py (ticket #206). What is REAL in here:
//   * a real Chrome (headed or headless) driven over CDP,
//   * the real userscript file, injected at document-start
//     (Page.addScriptToEvaluateOnNewDocument) with a GM_* shim, i.e. the
//     equivalent of Tampermonkey's @run-at document-start,
//   * a fixture page with a real video element playing a generated WAV,
//     issuing its own timedtext fetch the way the YouTube player does
//     (json3 + rotating pot token),
//   * the real TS desktop app (Electron main process) as a child process:
//     real WSServer, Engine and overlay; state scenarios may wrap it with the
//     e2e-control mode/provider HTTP surface,
//   * GET /status as the ONLY observation port - no test reaches into internals.
//
// The Electron app window stays hidden during automated runs
// (YOUTUBESUB_E2E_OFFSCREEN=1): the run is black-box over /status and stays
// desktop-safe per the #193 decision. Run "node tests/browser-e2e-harness.ts
// --demo" to show both windows for the human-in-the-loop checklist.
//
// The GM shim is required because bare CDP injection has no userscript
// sandbox: --disable-web-security (test-only, never in production) stands in
// for the CORS bypass a real GM_xmlhttpRequest grant provides, and a fresh
// --user-data-dir keeps the user's own Chrome and profile untouched.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url));      // app/tests
const APP_ROOT = path.resolve(HERE, "..", "..");                // app/
const PROJECT_DIR = path.resolve(APP_ROOT, "..");               // repo root (unchanged: APP_ROOT stays app/)
const USERSCRIPT_PATH = path.join(PROJECT_DIR, "userscript", "youtubesub.user.js");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  (process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe" : ""),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

// ---- fixture content (the expected values are literals, not recomputed) ----
export const VIDEO_A = "aaaaaaaaaaa";
export const VIDEO_B = "bbbbbbbbbbb";
export const VIDEO_NO_CUES = "ccccccccccc";
export const VIDEO_CAPTURE_ERROR = "ddddddddddd";
export const VIDEO_HOOK_ERROR = "eeeeeeeeeee";
export const TRACK_PREFIX: Record<string, string> = { [VIDEO_A]: "FIXTURE ALPHA", [VIDEO_B]: "FIXTURE BETA" };
export const CUE_STARTS_MS = [800, 3000, 6000] as const;
// Sentence-final periods: the segmentation criteria (#22/ADR-006) cut groups
// at punctuation, so each fixture line stays its own group and the mock
// translation of the first cue is exactly that cue's text.
export const CUE_WORDS = ["one.", "two.", "three."] as const;

export function cue_text(video_id: string, index: number): string {
  // The exact sentence the fixture emits; tests assert against this literal.
  return (TRACK_PREFIX[video_id] ?? "FIXTURE ALPHA") + " " + CUE_WORDS[index];
}

export function track_payload(video_id: string): Record<string, unknown> {
  const prefix = TRACK_PREFIX[video_id] ?? "FIXTURE ALPHA";
  return { events: CUE_STARTS_MS.map((s, i) => ({
    tStartMs: s, dDurationMs: 2200,
    segs: [{ utf8: prefix + " " + CUE_WORDS[i], tOffsetMs: 100 }],
  })) };
}

// ---- small OS helpers ----
export function find_chrome(): string | null {
  for (const p of CHROME_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// Node has no synchronous bind: the port is only known inside the listen
// callback, so this has to be awaited by every caller.
export async function free_port(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(0, "127.0.0.1", resolve);
  });
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

// 16-bit PCM mono silence, the same bytes the Python wave module wrote.
function make_wav_bytes(seconds = 60.0, rate = 8000): Buffer {
  const frames = Math.trunc(rate * seconds);
  const dataSize = frames * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);        // PCM
  buf.writeUInt16LE(1, 22);        // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);        // block align
  buf.writeUInt16LE(16, 34);       // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;                      // samples stay zero (silence)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function http_get_json(port: number, reqPath: string, timeoutMs = 5000): Promise<{ status: number; data: unknown }> {
  const res = await fetch("http://127.0.0.1:" + port + reqPath, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  return { status: res.status, data: JSON.parse(text) as unknown };
}

export async function wait_for<T>(
  pred: () => T | null | undefined | false | "" | Promise<T | null | undefined | false | "">,
  opts: { timeout?: number; interval?: number; what?: string; detail?: () => unknown | Promise<unknown> } = {},
): Promise<NonNullable<T>> {
  // Poll pred() until it is truthy; raise carrying the last observed value so
  // a red run says what the black box actually reported.
  const timeout = opts.timeout ?? 15000;
  const interval = opts.interval ?? 150;
  const what = opts.what ?? "condition";
  const deadline = Date.now() + timeout;
  let last: unknown = null;
  while (Date.now() < deadline) {
    last = await pred();
    if (last) return last as NonNullable<T>;
    await sleep(interval);
  }
  const seen = opts.detail ? await opts.detail() : last;
  throw new Error("timed out after " + (timeout / 1000).toFixed(1) + "s waiting for " + what +
    " (last observed: " + JSON.stringify(seen) + ")");
}

// ---- GM shim + userscript injection ----
export const GM_SHIM = `
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
`;

export function injection_source(app_port: number): string {
  // GM shim + the real userscript + a port override. The app runs on a free
  // port so the harness cannot collide with a desktop app the user already
  // has open; the override runs before DOMContentLoaded, i.e. before the
  // script's boot() connects.
  const script = fs.readFileSync(USERSCRIPT_PATH, "utf8");
  return [GM_SHIM, script, "try { window.__youtubesub.cfg.port = " + app_port +
    "; } catch (e) { console.error('[e2e] port override failed', e); }"].join("\n") + "\n";
}

export const PAGE_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>__TITLE__</title></head>
<body style="font:13px Consolas,monospace;background:#111;color:#ddd;padding:10px">
<h3 style="margin:4px 0">youtubesub fixture page (real video element, real timedtext fetch)</h3>
<p style="margin:4px 0;color:#999;max-width:900px">
Plays a generated WAV through a real video element and fetches a json3 timedtext payload the
way the YouTube player does (rotating pot token). The userscript under test is injected at
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
<script nonce="fixture">
var VIDEOS = __VIDEOS__;
var v = document.getElementById('v');
function currentVideo() {
  var m = /[?&]v=([a-zA-Z0-9_-]{6,})/.exec(location.search);
  return m ? m[1] : VIDEOS[0];
}
if (currentVideo() === 'eeeeeeeeeee') {
  window.GM_addElement = function () { throw new Error('fixture injection blocked'); };
  var nativeCreateElement = document.createElement.bind(document);
  document.createElement = function (tag) {
    if (String(tag).toLowerCase() === 'script') throw new Error('fixture script blocked');
    return nativeCreateElement(tag);
  };
  window.Function = function () { throw new Error('fixture eval blocked'); };
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
// A player with captions enabled asks for the track shortly after load and
// then starts playing on its own (a muted local fixture, so autoplay is allowed).
setTimeout(function () {
  requestSubtitles().catch(function () {}).then(function () { return v.play(); })
    .catch(function (e) { console.warn('[fixture] autoplay blocked', e); });
}, 400);
</script>
</body></html>`;

function send(res: http.ServerResponse, code: number, body: Buffer | string, ctype: string, extra?: Record<string, string>): void {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  res.writeHead(code, {
    "Content-Type": ctype,
    "Content-Length": String(buf.length),
    "Accept-Ranges": "bytes",
    ...(extra ?? {}),
  });
  res.end(buf);
}

export class FixtureServer {
  // 127.0.0.1 fixture origin: /watch, /youtube/api/timedtext, /media.wav.
  // The origin is deliberately a bare 127.0.0.1 (not *.localhost): the WS
  // server's origin allowlist matches on the literal "127.0.0.1" and a
  // public-looking hostname would be rejected with 403.
  timedtext_requests: string[] = [];
  private readonly server: http.Server;
  private readonly wav: Buffer;
  port = 0;
  constructor(wavSeconds = 60.0) {
    this.wav = make_wav_bytes(wavSeconds);
    this.server = http.createServer((req, res) => this.route(req, res));
    // Chrome resets keep-alive sockets at shutdown; not interesting.
    this.server.on("clientError", (_e, socket) => socket.destroy());
  }
  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this.port;
  }
  get origin(): string {
    return "http://127.0.0.1:" + this.port;
  }
  watch_url(video_id: string): string {
    return this.origin + "/watch?v=" + video_id;
  }
  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/watch") {
      const vid = url.searchParams.get("v") || VIDEO_A;
      const page = PAGE_TEMPLATE
        .replace("__VIDEOS__", JSON.stringify([VIDEO_A, VIDEO_B]))
        .replace("__TITLE__", "Fixture page " + vid);
      const extra = vid === VIDEO_HOOK_ERROR
        ? { "Content-Security-Policy": "script-src 'nonce-fixture'" }
        : undefined;
      send(res, 200, page, "text/html; charset=utf-8", extra);
    } else if (url.pathname.endsWith("/api/timedtext")) {
      const vid = url.searchParams.get("v") || VIDEO_A;
      this.timedtext_requests.push(req.url ?? "");
      let body: string;
      if (vid === VIDEO_CAPTURE_ERROR) {
        body = "not-json";
      } else {
        const payload = vid === VIDEO_NO_CUES ? { events: [] } : track_payload(vid);
        body = JSON.stringify(payload);
      }
      send(res, 200, body, "application/json");
    } else if (url.pathname === "/media.wav") {
      this.send_wav(req, res);
    } else {
      send(res, 404, "not found", "text/plain");
    }
  }
  private send_wav(req: http.IncomingMessage, res: http.ServerResponse): void {
    const body = this.wav;
    const total = body.length;
    const rng = req.headers.range;
    if (rng && rng.startsWith("bytes=")) {
      const spec = rng.slice(6).split(",")[0] ?? "";
      const dash = spec.indexOf("-");
      const a = spec.slice(0, dash).trim();
      const b = spec.slice(dash + 1).trim();
      const start = a ? parseInt(a, 10) : 0;
      let end = b ? parseInt(b, 10) : total - 1;
      end = Math.min(end, total - 1);
      if (!(start <= end)) {
        res.writeHead(416, { "Content-Range": "bytes */" + total, "Content-Length": "0" });
        res.end();
        return;
      }
      const chunk = body.subarray(start, end + 1);
      res.writeHead(206, {
        "Content-Type": "audio/wav",
        "Content-Range": "bytes " + start + "-" + end + "/" + total,
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunk.length),
      });
      res.end(chunk);
    } else {
      send(res, 200, body, "audio/wav");
    }
  }
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ---- CDP client (no puppeteer, just the ws package) ----
type CdpMsg = Record<string, unknown>;
export class CDP {
  private readonly ws: WebSocket;
  private readonly pending = new Map<number, { resolve: (m: CdpMsg) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private idCounter = 0;
  events: CdpMsg[] = [];
  private constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl, { maxPayload: 32 * 1024 * 1024 });
    this.ws.on("message", (raw: unknown) => {
      let msg: CdpMsg;
      try { msg = JSON.parse(String(raw)) as CdpMsg; } catch { return; }
      if (typeof msg["id"] === "number") {
        const p = this.pending.get(msg["id"] as number);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg["id"] as number);
          p.resolve(msg);
        }
      } else if (this.events.length < 2000) {
        this.events.push(msg);
      }
    });
    this.ws.on("error", () => {});   // the connection dies, the client lives
  }
  static async connect(wsUrl: string, timeoutMs = 20000): Promise<CDP> {
    const c = new CDP(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP websocket did not connect in " + Math.round(timeoutMs / 1000) + "s")), timeoutMs);
      c.ws.once("open", () => { clearTimeout(t); resolve(); });
      c.ws.once("error", (e: Error) => { clearTimeout(t); reject(e); });
    });
    return c;
  }
  async call(method: string, params: CdpMsg = {}, timeoutMs = 20000): Promise<CdpMsg> {
    const mid = ++this.idCounter;
    return new Promise<CdpMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(mid);
        reject(new Error("CDP call timed out: " + method));
      }, timeoutMs);
      this.pending.set(mid, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  async evaluate(expression: string, awaitPromise = false): Promise<unknown> {
    const msg = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: !!awaitPromise,
    });
    if (msg["error"] !== undefined) {
      throw new Error("CDP error: " + JSON.stringify(msg["error"]).slice(0, 300));
    }
    const result = (msg["result"] ?? {}) as CdpMsg;
    if (result["exceptionDetails"] !== undefined) {
      throw new Error("page exception for " + JSON.stringify(expression.slice(0, 80)) +
        ": " + JSON.stringify(result["exceptionDetails"]).slice(0, 400));
    }
    const inner = (result["result"] ?? {}) as CdpMsg;
    return inner["value"];
  }
  // Every console call, page exception and browser Log entry. Log entries
  // matter for the live (real-site) mode: a Content-Security-Policy block of
  // the injected page hook does not raise a console API error, it only shows
  // up here.
  console_messages(): [string, string][] {
    const out: [string, string][] = [];
    for (const ev of this.events) {
      const method = String(ev["method"] ?? "");
      if (method === "Runtime.consoleAPICalled") {
        const p = (ev["params"] ?? {}) as CdpMsg;
        const args = (p["args"] as CdpMsg[] | undefined ?? []).map((a) =>
          String(a["value"] ?? a["description"] ?? ""));
        out.push([String(p["type"] ?? "log"), args.join(" ")]);
      } else if (method === "Runtime.exceptionThrown") {
        const d = ((ev["params"] as CdpMsg | undefined)?.["exceptionDetails"] ?? {}) as CdpMsg;
        const ex = (d["exception"] ?? {}) as CdpMsg;
        out.push(["exception", String(ex["description"] ?? d["text"] ?? "")]);
      } else if (method === "Log.entryAdded") {
        const e = ((ev["params"] as CdpMsg | undefined)?.["entry"] ?? {}) as CdpMsg;
        out.push(["log:" + String(e["level"] ?? ""), String(e["source"] ?? "") + " " + String(e["text"] ?? "")]);
      }
    }
    return out;
  }
  // User-visible console errors + uncaught page exceptions.
  console_errors(): string[] {
    const out: string[] = [];
    for (const ev of this.events) {
      const method = String(ev["method"] ?? "");
      if (method === "Runtime.consoleAPICalled" &&
          ((ev["params"] as CdpMsg | undefined)?.["type"] === "error" ||
           (ev["params"] as CdpMsg | undefined)?.["type"] === "assert")) {
        const p = (ev["params"] ?? {}) as CdpMsg;
        const args = (p["args"] as CdpMsg[] | undefined ?? []).map((a) =>
          String(a["value"] ?? a["description"] ?? ""));
        out.push(args.join(" "));
      } else if (method === "Runtime.exceptionThrown") {
        const d = ((ev["params"] as CdpMsg | undefined)?.["exceptionDetails"] ?? {}) as CdpMsg;
        const ex = (d["exception"] ?? {}) as CdpMsg;
        out.push(String(ex["description"] ?? d["text"] ?? ""));
      }
    }
    return out;
  }
  close(): void {
    try { this.ws.close(); } catch { /* ignore */ }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP closed"));
    }
    this.pending.clear();
  }
}

function kill_tree(proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { proc.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

export class Chrome {
  // A private Chrome instance: own profile dir, own debug port, own process.
  readonly exe: string;
  readonly headed: boolean;
  readonly proxy: string | null;
  readonly profile: string;
  port = 0;
  proc: ChildProcess | null = null;
  cdp: CDP | null = null;
  private logPath = "";
  constructor({ headed = false, proxy = null, logDir = null }: { headed?: boolean; proxy?: string | null; logDir?: string | null } = {}) {
    const exe = find_chrome();
    if (!exe) throw new Error("no Chrome found (looked at: " + CHROME_CANDIDATES.join(", ") + ")");
    this.exe = exe;
    this.headed = headed;
    this.proxy = proxy;
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), "ytus-profile-"));
    void logDir;
  }
  private flags(): string[] {
    const f: string[] = [];
    if (!this.headed) f.push("--headless=new");
    f.push(
      "--remote-debugging-port=" + this.port,
      "--remote-allow-origins=*",
      "--user-data-dir=" + this.profile,
      "--no-first-run", "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required", "--mute-audio",
      // test-only CORS bypass: bare CDP injection has no GM_xmlhttpRequest
      // grant, so the script's cross-origin /health probe would be blocked.
      // Production runs under Tampermonkey and never needs this.
      "--disable-web-security",
      "--window-size=980,700", "--window-position=80,60",
    );
    if (this.proxy) {
      f.push("--proxy-server=" + this.proxy, "--proxy-bypass-list=127.0.0.1;localhost");
    } else {
      f.push("--no-proxy-server");
    }
    f.push("about:blank");
    return f;
  }
  async start(logPath: string): Promise<void> {
    this.logPath = logPath;
    this.port = await free_port();
    const logFd = fs.openSync(logPath, "w");
    this.proc = spawn(this.exe, this.flags(), { stdio: ["ignore", logFd, logFd] });
  }
  async page_ws_url(timeoutMs = 25000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown = null;
    while (Date.now() < deadline) {
      try {
        const { status, data } = await http_get_json(this.port, "/json/list", 3000);
        if (status === 200 && Array.isArray(data)) {
          const pages = (data as CdpMsg[]).filter((t) => t["type"] === "page");
          if (pages.length) return String(pages[0]!["webSocketDebuggerUrl"]);
        }
      } catch (e) { last = e; }
      await sleep(250);
    }
    let tail = "";
    try { tail = fs.readFileSync(this.logPath).subarray(-1500).toString("utf8"); } catch { /* ignore */ }
    throw new Error("Chrome debug port never came up (" + String(last) + "). Chrome log tail:\n" + tail);
  }
  async stop(): Promise<void> {
    if (this.cdp !== null) this.cdp.close();
    const proc = this.proc;
    if (proc !== null && proc.exitCode === null && proc.signalCode === null) {
      kill_tree(proc);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && proc.exitCode === null && proc.signalCode === null) await sleep(100);
      if (process.platform !== "win32" && proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }
    fs.rmSync(this.profile, { recursive: true, force: true });
  }
}

export interface DesktopAppOptions {
  offscreen?: boolean;
  mode?: string;
  provider?: Record<string, unknown> | null;
  modeControl?: boolean;
}

export class DesktopApp {
  // The real desktop app (Electron main process), with a private APPDATA.
  // A private APPDATA means settings.load() sees provider.mock=true and a
  // free port, so a run never touches the user's real settings
  // (%APPDATA%/SubOverlay) and never talks to a real translation API.
  readonly port: number;
  modePort: number | null = null;
  readonly appdata: string;
  readonly logPath: string;
  proc: ChildProcess | null = null;
  private readonly offscreen: boolean;
  private readonly modeControl: boolean;
  constructor(port: number, { offscreen = true, mode = "bilingual", provider = null, modeControl = false }: DesktopAppOptions = {}) {
    this.port = port;
    this.offscreen = offscreen;
    this.modeControl = modeControl;
    this.appdata = fs.mkdtempSync(path.join(os.tmpdir(), "ytus-appdata-"));
    this.logPath = path.join(this.appdata, "app.log");
    const d = path.join(this.appdata, "SubOverlay");
    fs.mkdirSync(d, { recursive: true });
    const settings = {
      server: { port },
      provider: provider ?? { base_url: "", api_key: "", model: "", protocol: "auto", mock: true },
      display: { mode },
      window: { x: 220, y: 150, w: 780, h: 130 },
    };
    fs.writeFileSync(path.join(d, "setting.json"), JSON.stringify(settings, null, 2));
  }
  async start(): Promise<void> {
    if (this.modeControl && this.modePort === null) this.modePort = await free_port();
    const require_ = createRequire(import.meta.url);
    const electronPath = require_("electron") as string;
    const env: NodeJS.ProcessEnv = { ...process.env, APPDATA: this.appdata };
    // Agent/IDE tool processes are often launched with ELECTRON_RUN_AS_NODE=1
    // (their host is an Electron app); it turns electron.exe into a plain
    // Node and the real app dies with "no export named BrowserWindow".
    delete env["ELECTRON_RUN_AS_NODE"];
    // Hidden overlay window during automated runs (black-box over /status);
    // --demo clears this to show the real window.
    if (this.offscreen) env["YOUTUBESUB_E2E_OFFSCREEN"] = "1";
    // Keep the translation cache out of the repo tree: it belongs to the
    // private APPDATA and dies with the run.
    env["YOUTUBESUB_DATA_DIR"] = path.join(this.appdata, "data");
    if (this.modePort !== null) env["YOUTUBESUB_E2E_MODE_PORT"] = String(this.modePort);
    const logFd = fs.openSync(this.logPath, "w");
    this.proc = spawn(electronPath, ["."], { cwd: APP_ROOT, env, stdio: ["ignore", logFd, logFd] });
  }
  private async control(reqPath: string, payload: Record<string, unknown>): Promise<void> {
    if (this.modePort === null) throw new Error("mode control is available only in the test harness");
    const res = await fetch("http://127.0.0.1:" + this.modePort + reqPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    await res.arrayBuffer();
    if (res.status !== 202) throw new Error("E2E app rejected " + reqPath + ": HTTP " + res.status);
  }
  async set_mode(mode: string): Promise<void> {
    if (this.modePort === null) throw new Error("mode control is available only in the test harness");
    await this.control("/mode", { mode });
  }
  async set_provider(provider: Record<string, unknown>): Promise<void> {
    if (this.modePort === null) throw new Error("provider control is available only in the test harness");
    await this.control("/provider", { provider });
  }
  log_tail(limit = 3000): string {
    try { return fs.readFileSync(this.logPath).subarray(-limit).toString("utf8"); }
    catch { return ""; }
  }
  async wait_healthy(timeoutMs = 30000): Promise<true> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.proc !== null && this.proc.exitCode !== null) {
        throw new Error("app main process exited early (code " + this.proc.exitCode + "):\n" + this.log_tail());
      }
      try {
        const { status, data } = await http_get_json(this.port, "/health", 2000);
        const ok = (data as CdpMsg | null)?.["ok"];
        if (status === 200 && ok === true) return true;
      } catch { /* poll again */ }
      await sleep(250);
    }
    throw new Error("app never answered /health on port " + this.port + ":\n" + this.log_tail());
  }
  async stop(): Promise<void> {
    const proc = this.proc;
    if (proc !== null && proc.exitCode === null && proc.signalCode === null) {
      kill_tree(proc);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && proc.exitCode === null && proc.signalCode === null) await sleep(100);
      if (process.platform !== "win32" && proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }
    fs.rmSync(this.appdata, { recursive: true, force: true });
  }
}

export interface HarnessOptions {
  headed?: boolean;
  proxy?: string | null;
  bypassCsp?: boolean;
  desktopOptions?: DesktopAppOptions;
}

export class Harness {
  // One running scenario: fixture origin + real app + real Chrome + real script.
  readonly headed: boolean;
  readonly proxy: string | null;
  readonly bypassCsp: boolean;
  readonly desktopOptions: DesktopAppOptions;
  fixture: FixtureServer | null = null;
  app: DesktopApp | null = null;
  chrome: Chrome | null = null;
  cdp: CDP | null = null;
  appPort = 0;
  private readonly tmp: string;
  constructor({ headed = false, proxy = null, bypassCsp = false, desktopOptions = {} }: HarnessOptions = {}) {
    this.headed = headed;
    this.proxy = proxy;
    // Live mode only: a real GM_addElement injects from the extension context,
    // so it bypasses the page's CSP *and* Trusted Types. Bare CDP injection
    // has no such privilege, so the harness asks Chrome to drop CSP for the
    // page - otherwise a live run fails for a harness reason, not a product
    // reason.
    this.bypassCsp = bypassCsp;
    this.desktopOptions = desktopOptions;
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ytus-e2e-"));
  }
  async start(): Promise<this> {
    this.fixture = new FixtureServer();
    await this.fixture.start();
    this.appPort = await free_port();
    this.app = new DesktopApp(this.appPort, {
      offscreen: !this.headed,
      ...this.desktopOptions,
    });
    await this.app.start();
    await this.app.wait_healthy();
    this.chrome = new Chrome({ headed: this.headed, proxy: this.proxy, logDir: this.tmp });
    await this.chrome.start(path.join(this.tmp, "chrome.log"));
    this.chrome.cdp = await CDP.connect(await this.chrome.page_ws_url());
    this.cdp = this.chrome.cdp;
    await this.cdp.call("Page.enable");
    await this.cdp.call("Runtime.enable");
    await this.cdp.call("Log.enable");  // CSP violations only appear in the browser Log
    if (this.bypassCsp) {
      await this.cdp.call("Page.setBypassCSP", { enabled: true });
    }
    await this.cdp.call("Page.addScriptToEvaluateOnNewDocument", {
      source: injection_source(this.appPort),
    });
    return this;
  }
  async open(videoId: string = VIDEO_A): Promise<void> {
    await this.cdp!.call("Page.navigate", { url: this.fixture!.watch_url(videoId) });
    await wait_for(async () => (await this.cdp!.evaluate("document.readyState")) === "complete" ? true : null,
      { timeout: 20000, what: "document.readyState == complete" });
    // The port override must have applied, otherwise the script is talking to
    // some other (or no) desktop app and every later assertion is meaningless.
    const port = await wait_for(async () => {
      const p = await this.cdp!.evaluate("window.__youtubesub && window.__youtubesub.cfg.port");
      return typeof p === "number" ? p : null;
    }, { timeout: 10000, what: "userscript cfg.port override" });
    if (port !== this.appPort) {
      throw new Error("userscript talks to port " + port + ", app is on " + this.appPort);
    }
  }
  async status(): Promise<Record<string, unknown>> {
    try {
      const { status, data } = await http_get_json(this.appPort, "/status", 5000);
      return status === 200 ? (data as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  // What the fixture page thinks is happening (for failure messages).
  async video_state(): Promise<string> {
    return (await this.cdp!.evaluate(
      "JSON.stringify({t: document.getElementById('v').currentTime," +
      " paused: document.getElementById('v').paused," +
      " rate: document.getElementById('v').playbackRate," +
      " video: __fixture.video(), src: location.search})",
    )) as string;
  }
  async stop(): Promise<void> {
    const closers: (() => Promise<void>)[] = [
      async () => { if (this.chrome) await this.chrome.stop(); },
      async () => { if (this.app) await this.app.stop(); },
      async () => { if (this.fixture) await this.fixture.stop(); },
    ];
    for (const closer of closers) {
      try { await closer(); } catch { /* best effort */ }
    }
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }
}

// ---- live (real site) mode: an independent tracer separates the three links ----
export const LIVE_TRACER = `
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
})()`;

export const LIVE_BOOTSTRAP = `
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
})()`;

export const LIVE_PROBE = `
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
})()`;

export const LIVE_BANNER = `
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
`;

export const BANNER = `
==============================================================================
 DEMO MODE - full real stack: Chrome + userscript + fixture page + TS app
==============================================================================
 A real Chrome (private profile, CORS checks off to stand in for the GM grant)
 plays a local fixture page with a real video element and a real timedtext
 fetch. The real desktop app runs with throwaway mock settings, so your own
 settings and API key are NOT used.

 Expected: after ~2s the overlay shows FIXTURE ALPHA one. plus a translated
 line below it, following playback line by line. Ctrl+C stops everything.
`;

export async function demo(proxy: string | null = null, seconds = Infinity): Promise<void> {
  // Human-in-the-loop entry: visible Chrome + visible overlay window.
  const h = new Harness({ headed: true, proxy });
  process.on("SIGINT", () => { void h.stop().then(() => process.exit(0)); });
  await h.start();
  await h.open(VIDEO_A);
  console.log(BANNER);
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < seconds * 1000) {
    const s = await h.status();
    const line = "state=" + String(s.state ?? "").padEnd(9) +
      " playing=" + String(s.playing ?? "").padEnd(6) +
      " rate=" + String(s.rate ?? "").padEnd(4) +
      " orig=" + JSON.stringify(String(s.orig ?? "")).padEnd(30) +
      " trans=" + JSON.stringify(String(s.trans ?? ""));
    if (line !== last) {
      console.log(line);
      last = line;
    }
    await sleep(500);
  }
  await h.stop();
}

export async function live(url: string, proxy: string | null = null, seconds = 20, headed = true): Promise<void> {
  const h = new Harness({ headed, proxy, bypassCsp: true });
  process.on("SIGINT", () => { void h.stop().then(() => process.exit(0)); });
  await h.start();
  let seenMessages = 0;
  let captured = false;
  try {
    console.log("live: navigating to " + url);
    await h.cdp!.call("Page.navigate", { url });
    await h.cdp!.call("Runtime.evaluate", { expression: LIVE_TRACER, returnByValue: true });
    await h.cdp!.call("Runtime.evaluate", { expression: LIVE_BOOTSTRAP, returnByValue: true });
    console.log(LIVE_BANNER);
    const deadline = Date.now() + Math.max(5, seconds) * 1000;
    while (Date.now() < deadline) {
      await sleep(3000);
      const report = JSON.parse(String(await h.cdp!.evaluate(LIVE_PROBE))) as Record<string, unknown>;
      const s = await h.status();
      console.log("-- t+" + Math.round((Date.now() - (deadline - seconds * 1000)) / 1000) + "s");
      console.log("  page:    " + JSON.stringify(report));
      console.log("  /status: state=" + s.state + " playing=" + s.playing + " sources=" + s.sources +
        " orig=" + JSON.stringify(String(s.orig ?? "")).slice(0, 70) +
        " trans=" + JSON.stringify(String(s.trans ?? "")).slice(0, 40));
      const messages = h.cdp!.console_messages();
      for (; seenMessages < messages.length; seenMessages++) {
        console.log("  console[" + messages[seenMessages]![0] + "]: " + messages[seenMessages]![1].slice(0, 160));
      }
      if (!captured && s.orig) {
        console.log("CAPTURED: the desktop app is receiving real subtitles.");
        captured = true;
      }
    }
  } finally {
    await h.stop();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let proxy: string | null = null;
  let seconds = 30;
  let liveUrl: string | null = null;
  let headless = false;
  let demoMode = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--demo") demoMode = true;
    else if (a === "--proxy") proxy = argv[++i] ?? null;
    else if (a === "--seconds") seconds = parseFloat(argv[++i] ?? "30");
    else if (a === "--live") liveUrl = argv[++i] ?? null;
    else if (a === "--headless") headless = true;
    else {
      console.error("unknown argument: " + a);
      process.exit(2);
    }
  }
  if (liveUrl) await live(liveUrl, proxy, seconds, !headless);
  else if (demoMode) await demo(proxy, seconds);
  else {
    console.log("usage: node tests/browser-e2e-harness.ts [--demo] [--proxy http://127.0.0.1:10809] [--seconds 30] [--live URL] [--headless]");
    process.exit(2);
  }
}

// Run directly (node tests/browser-e2e-harness.ts --demo) -> CLI mode.
const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) void main();


