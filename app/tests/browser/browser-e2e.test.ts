// Real-browser end-to-end tests - the port of desktop/tests/test_browser_e2e.py
// (ticket #206). Same ten criteria, same order, one black-box observation port
// (GET /status): a real Chrome runs the REAL userscript against the fixture
// origin, the REAL TS desktop app (Electron main process) receives its frames,
// and every assertion reads the wire protocol - never app internals.
//
// The module-level harness is shared by the criteria that need one long-lived
// app+browser pair; the state-machine criteria (own provider/mode control) boot
// their own. When no Chrome is installed the whole suite is skipped, matching
// the Python skipif.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import {
  CDP,
  Harness,
  VIDEO_A,
  VIDEO_B,
  VIDEO_CAPTURE_ERROR,
  VIDEO_HOOK_ERROR,
  VIDEO_NO_CUES,
  cue_text,
  find_chrome,
  free_port,
  sleep,
  wait_for,
  type HarnessOptions,
} from "./browser-e2e-harness.ts";

const suite = find_chrome() !== null ? describe : describe.skip;

const CUE0 = cue_text(VIDEO_A, 0);   // FIXTURE ALPHA one.
const CUE2 = cue_text(VIDEO_A, 2);   // FIXTURE ALPHA three.
const CUE_B0 = cue_text(VIDEO_B, 0); // FIXTURE BETA one.
const MOCK_MARK = "\u3010\u8bd1\u3011"; // the mock translation prefix

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// A local OpenAI-compatible endpoint that behaves like the mock provider in
// the Python harness: one controlled failure, hold/release of the response,
// numbered multi-line replies. The desktop app talks to it over real HTTP
// with a real provider config.
class CountingProvider {
  requests: Record<string, unknown>[] = [];
  private readonly failOnceFor: string | null;
  private failedOnce = false;
  private releaseOpen: boolean;
  private requestStartedFlag = false;
  private startedWaiters: (() => void)[] = [];
  private releaseWaiters: (() => void)[] = [];
  private readonly server: http.Server;
  readonly port: number;
  readonly config: Record<string, unknown>;

  constructor(port: number, { failOnceFor = null, hold = false }: { failOnceFor?: string | null; hold?: boolean } = {}) {
    this.failOnceFor = failOnceFor;
    this.releaseOpen = !hold;
    this.port = port;
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.listen(port, "127.0.0.1");
    this.config = {
      base_url: "http://127.0.0.1:" + port + "/v1",
      api_key: "test-key",
      model: "test-model",
      protocol: "chat-completions",
      mock: false,
      timeout_s: 2,
      max_retries: 0,
    };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>; } catch { /* empty body */ }
    this.requests.push(body);
    this.markStarted();
    if (!this.releaseOpen) await this.awaitRelease();
    const messages = Array.isArray(body["messages"]) ? (body["messages"] as Record<string, unknown>[]) : [];
    const system = str(messages[0]?.["content"]);
    const user = str(messages[messages.length - 1]?.["content"]);
    if (this.failOnceFor !== null && user.includes(this.failOnceFor)) {
      const shouldFail = !this.failedOnce;
      this.failedOnce = true;
      if (shouldFail) {
        res.writeHead(400, { "Content-Length": "0" });
        res.end();
        return;
      }
    }
    const m = /exactly (\d+) lines/.exec(system);
    const content = m
      ? Array.from({ length: parseInt(m[1]!, 10) }, (_, i) => (i + 1) + "|translated").join("\n")
      : "translated";
    const data = Buffer.from(JSON.stringify({ choices: [{ message: { content } }] }));
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(data.length) });
    res.end(data);
  }

  private markStarted(): void {
    this.requestStartedFlag = true;
    for (const w of this.startedWaiters.splice(0)) w();
  }
  count(): number {
    return this.requests.length;
  }
  hold(): void {
    this.requestStartedFlag = false;
    this.releaseOpen = false;
  }
  release(): void {
    this.releaseOpen = true;
    for (const w of this.releaseWaiters.splice(0)) w();
  }
  async wait_started(timeoutMs = 15000): Promise<void> {
    if (this.requestStartedFlag) return;
    await wait_for(async () => (this.requestStartedFlag ? true : null), {
      timeout: timeoutMs,
      what: "the provider receives the current browser cue",
    });
  }
  private awaitRelease(): Promise<void> {
    if (this.releaseOpen) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 15000);
      this.releaseWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }
  async stop(): Promise<void> {
    this.release();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

suite("browser E2E (real Chrome -> real userscript -> TS app)", () => {
  let h!: Harness;

  before(async () => {
    h = new Harness({ headed: false });
    try {
      await h.start();
      await h.open(VIDEO_A);
    } catch (e) {
      await h.stop();
      throw e;
    }
  });

  after(async () => {
    await h.stop();
  });

  async function status_until(
    hh: Harness,
    pred: (s: Record<string, unknown>) => boolean,
    { timeout = 20000, what = "condition" }: { timeout?: number; what?: string } = {},
  ): Promise<Record<string, unknown>> {
    await wait_for(async () => (pred(await hh.status()) ? true : null), {
      timeout,
      what,
      detail: async () => ({ status: await hh.status(), page: await hh.video_state().catch((e: Error) => "page_error: " + e.message) }),
    });
    const st = await hh.status();
    const ts = str(st.trans_state);
    const okStates = ["idle", "waiting", "translating", "unconfigured", "ready"];
    const failedOk = ts.startsWith("failed:") && ts.length - "failed:".length >= 1 && ts.length - "failed:".length <= 16;
    assert.ok(okStates.includes(ts) || failedOk, JSON.stringify(st));
    return st;
  }

  test("real userscript connects and registers a source", { timeout: 90000 }, async () => {
    await wait_for(async () => ((h.fixture!.timedtext_requests.length >= 1) ? true : null),
      { timeout: 10000, what: "the fixture page's own timedtext fetch" });
    const st = await status_until(h, (s) =>
      num(s.sources) >= 1 && num((s.stats as Record<string, unknown> | undefined)?.["frames"]) >= 2,
      { what: "one registered source and >=2 real WS frames" });
    assert.equal(num((st.stats as Record<string, unknown>)?.["bad_frames"]), 0, JSON.stringify(st.stats));
    // hook_error empty is a POSITIVE fact here: it means the real page hook in
    // the real userscript saw caption data, not just that nothing complained.
    assert.equal(str(st.hook_error), "", JSON.stringify(st));
  });

  test("real timedtext becomes the exact subtitle", { timeout: 90000 }, async () => {
    await h.cdp!.evaluate("__fixture.pause(); __fixture.seek(1.0);");
    let st = await status_until(h, (s) => s.state === "ok" && s.orig === CUE0,
      { what: "orig == " + JSON.stringify(CUE0) });
    assert.equal(st.state, "ok", JSON.stringify(st));
    st = await status_until(h, (s) => str(s.trans).includes(MOCK_MARK),
      { what: "a translated line for the first cue" });
    assert.ok(str(st.trans).startsWith(MOCK_MARK), JSON.stringify(st));
    assert.equal(st.trans_state, "ready", JSON.stringify(st));
    assert.ok(str(st.trans).includes(cue_text(VIDEO_A, 0)), str(st.trans));
  });

  test("original-only browser cues do not reach the provider until the mode switches", { timeout: 120000 }, async () => {
    const provider = new CountingProvider(await free_port());
    const harness = new Harness({
      headed: false,
      desktopOptions: { mode: "orig", provider: provider.config, modeControl: true },
    });
    try {
      await harness.start();
      await harness.open(VIDEO_A);
      await harness.cdp!.evaluate("__fixture.pause(); __fixture.seek(1.0);");
      const st = await status_until(harness, (s) => s.state === "ok" && s.orig === CUE0,
        { what: "orig == " + JSON.stringify(CUE0) + " under a controlled app" });
      assert.equal(st.mode, "orig", JSON.stringify(st));
      assert.equal(st.trans_state, "idle", JSON.stringify(st));
      // Browser cues must not trigger an urgent submit or a prefetch while the
      // display mode says original-only.
      assert.equal(provider.count(), 0, JSON.stringify(provider.requests));
      await harness.app!.set_mode("bilingual");
      await status_until(harness, (s) => s.mode === "bilingual", { what: "mode == bilingual" });
      const st2 = await status_until(harness, (s) => s.trans_state === "ready",
        { what: "a real translation after the mode switch" });
      assert.ok(str(st2.trans).length > 0, JSON.stringify(st2));
      assert.ok(provider.count() > 0, JSON.stringify(provider.requests));
    } finally {
      await harness.stop();
      await provider.stop();
    }
  });

  test("browser translation states and failed-seek recovery", { timeout: 150000 }, async () => {
    const provider = new CountingProvider(await free_port(), { failOnceFor: CUE0, hold: true });
    const harness = new Harness({
      headed: false,
      desktopOptions: { mode: "bilingual", provider: provider.config, modeControl: true },
    });
    try {
      await harness.start();
      await harness.open(VIDEO_A);
      await harness.cdp!.evaluate("__fixture.pause(); __fixture.seek(1.0);");
      await provider.wait_started();
      let st = await status_until(harness, (s) => s.trans_state === "translating",
        { what: "translating while the controlled provider is held" });
      assert.equal(st.orig, CUE0, JSON.stringify(st));
      provider.release();
      // The exact fixed reason, end to end through the real WS protocol.
      st = await status_until(harness, (s) => s.trans_state === "failed:\u7ffb\u8bd1\u8bf7\u6c42\u65e0\u6548",
        { what: "fixed provider failure reason through real /status" });
      assert.equal(st.orig, CUE0, JSON.stringify(st));
      await harness.cdp!.evaluate("__fixture.seek(5.5);");
      // The clock's gap-hold (GAP_HOLD_MS = 3500) legitimately keeps the
      // previous cue on screen when the clock is frozen inside the gap, and
      // when the pause sync never lands the clock free-runs through the gap
      // to the after-last-cue idle. Both clear the failed cue0 display, so
      // assert that semantic, not one timing quirk of the original suite.
      st = await status_until(harness, (s) => s.state === "ok" && str(s.orig) !== CUE0,
        { what: "the failed cue display clears after seeking away" });
      await harness.cdp!.evaluate("__fixture.seek(6.5);");
      st = await status_until(harness, (s) => s.orig === CUE2 && s.trans_state === "ready",
        { what: "successful translation after seeking to another cue" });
      provider.hold();
      const previous = provider.count();
      await harness.cdp!.evaluate("__fixture.seek(1.0);");
      await wait_for(async () => (provider.count() > previous ? true : null),
        { what: "retry request after returning to the failed cue" });
      st = await harness.status();
      assert.equal(st.orig, CUE0, JSON.stringify(st));
      assert.equal(st.trans_state, "failed:\u7ffb\u8bd1\u8bf7\u6c42\u65e0\u6548", JSON.stringify(st));
      provider.release();
      st = await status_until(harness, (s) => s.orig === CUE0 && s.trans_state === "ready",
        { what: "the failed cue clearing after a successful retry" });
      await harness.app!.set_provider({ base_url: "", api_key: "", model: "", protocol: "auto", mock: false });
      st = await status_until(harness, (s) => s.trans_state === "unconfigured",
        { what: "unconfigured provider through real Chrome and /status" });
      assert.equal(st.trans_available, false, JSON.stringify(st));
    } finally {
      await harness.stop();
      await provider.stop();
    }
  });

  test("browser waiting and capture diagnostics preempt translation waiting", { timeout: 120000 }, async () => {
    const harness = new Harness({ headed: false, desktopOptions: { modeControl: true } });
    try {
      await harness.start();
      await harness.open(VIDEO_NO_CUES);
      let st = await status_until(harness, (s) => s.state === "no_cues" && s.trans_state === "waiting",
        { what: "healthy active video with no subtitle cues" });
      assert.ok(!st.hook_error && !st.capture_error, JSON.stringify(st));
      await harness.open(VIDEO_CAPTURE_ERROR);
      st = await status_until(harness, (s) => !!s.capture_error,
        { what: "real userscript capture error reaching /status" });
      assert.equal(st.trans_state, "idle", JSON.stringify(st));
      await harness.open(VIDEO_HOOK_ERROR);
      st = await status_until(harness, (s) => !!s.hook_error,
        { what: "real browser hook error reaching /status" });
      assert.equal(st.trans_state, "idle", JSON.stringify(st));
    } finally {
      await harness.stop();
    }
  });

  test("play/pause reaches the desktop clock", { timeout: 90000 }, async () => {
    await h.cdp!.evaluate("__fixture.seek(0.0); __fixture.play();");
    await status_until(h, (s) => s.playing === true, { what: "playing == true" });
    await h.cdp!.evaluate("__fixture.pause();");
    await status_until(h, (s) => s.playing === false, { what: "playing == false" });
    await h.cdp!.evaluate("__fixture.seek(1.0);");
    const first = await status_until(h, (s) => s.orig === CUE0,
      { what: "the cue at the seek target" });
    await sleep(1200);
    const s2 = await h.status();
    // A paused desktop clock must not advance.
    assert.equal(s2.orig, first.orig, JSON.stringify(s2));
  });

  test("playback rate reaches the desktop clock", { timeout: 90000 }, async () => {
    await h.cdp!.evaluate("__fixture.rate(2);");
    await status_until(h, (s) => s.rate === 2.0, { what: "rate == 2.0" });
    const st = await h.status();
    assert.ok(st.playing === true || st.playing === false, JSON.stringify(st));
    await h.cdp!.evaluate("__fixture.rate(1);");
    await status_until(h, (s) => s.rate === 1.0, { what: "rate == 1.0" });
  });

  test("seek moves the subtitle", { timeout: 90000 }, async () => {
    await h.cdp!.evaluate("__fixture.pause(); __fixture.seek(6.5);");
    const st = await status_until(h, (s) => s.orig === CUE2,
      { what: "orig == " + JSON.stringify(CUE2) });
    assert.equal(st.orig, CUE2, JSON.stringify(st));
  });

  test("SPA navigation creates a new source without stale cues", { timeout: 120000 }, async () => {
    // Runs last (same as the Python order): it navigates the shared page away.
    const before = await h.status();
    assert.ok(before.active_source, JSON.stringify(before));
    const next = await h.cdp!.evaluate("__fixture.switchVideo()");
    assert.equal(next, VIDEO_B);
    await status_until(h, (s) =>
      !!s.active_source && s.active_source !== before.active_source,
      { timeout: 25000, what: "a fresh active_source after SPA navigation" });
    await h.cdp!.evaluate("__fixture.pause(); __fixture.seek(1.0);");
    const st = await status_until(h, (s) => s.orig === CUE_B0,
      { timeout: 25000, what: "orig == " + JSON.stringify(CUE_B0) });
    assert.ok(!str(st.orig).includes("ALPHA"), JSON.stringify(st));
  });

  test("userscript reports no console errors", { timeout: 30000 }, async () => {
    const errors = h.cdp!.console_errors().filter((m) => m.length > 0);
    const scriptErrors = errors.filter((m) =>
      m.includes("[youtubesub]") || m.includes("injection failed"));
    assert.deepEqual(scriptErrors, [], JSON.stringify(errors));
    const portErrors = errors.filter((m) => m.includes("port override failed"));
    assert.deepEqual(portErrors, [], JSON.stringify(errors));
  });
});
