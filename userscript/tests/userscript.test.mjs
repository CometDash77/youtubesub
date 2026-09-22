// Node harness: evaluates the REAL userscript inside a stubbed browser sandbox,
// then drives it through the paths that matter end to end:
//   cue parsing parity (shared fixtures, also asserted by desktop/tests/test_parse_parity.py),
//   pot-rotation keying, generated page-hook code (actually executed), the WS bridge
//   (register/cues/sync replay, dedup, SPA source switch, reconnect backoff) and the
//   wire-protocol contract the desktop server enforces.
// No browser and no network are involved; this is the fast safety net for the
// browser-side logic. Real Chrome coverage lives in desktop/tests/browser_e2e.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'youtubesub.user.js'), 'utf8');
const fixtures = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures', 'parse_cases.json'), 'utf8'));

// Mirrors desktop/suboverlay/protocol.py VALID_TYPES + sanitize_event().
const VALID_TYPES = ['register', 'cues', 'sync', 'deactivate'];
const WATCH = 'https://www.youtube.com/watch?v=abcdef12345';

// ---------------------------------------------------------------- sandbox ----

function makeSandbox(opts = {}) {
  const sent = [];
  const sockets = [];
  const timers = [];
  const listeners = {};
  const bodyChildren = [];
  const headChildren = [];
  const box = { video: null };
  const clock = { now: 1760000000000 };

  class FakeDate extends Date {}
  FakeDate.now = () => clock.now;

  class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0; this.sentFrames = [];
      sockets.push(this);
    }
    send(s) { const f = JSON.parse(s); this.sentFrames.push(f); sent.push(f); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    fail() { this.readyState = 3; if (this.onerror) this.onerror(); }
  }

  function makeEl(tag) {
    const el = {
      tag, style: {}, children: [], listeners: {},
      appendChild(c) { this.children.push(c); },
      remove() { this.removed = true; },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    };
    let text = '';
    Object.defineProperty(el, 'textContent', {
      get() { return text; },
      set(v) {
        // YouTube enforces require-trusted-types-for 'script': a plain string
        // assignment to a script element is refused at runtime.
        if (opts.trustedTypesBlock && tag === 'script' && !(v && v.__trusted)) {
          throw new TypeError("Failed to set the 'textContent' property on "
            + "'HTMLScriptElement': This document requires 'TrustedScript' assignment.");
        }
        text = v;
      }
    });
    return el;
  }

  const doc = {
    readyState: 'complete',
    title: 'Test Video - YouTube',
    body: { appendChild(el) { bodyChildren.push(el); el.parent = 'body'; } },
    head: { appendChild(el) { headChildren.push(el); el.parent = 'head'; } },
    documentElement: { appendChild() {} },
    createElement: (tag) => makeEl(tag),
    querySelector(sel) { return sel === 'video' ? box.video : null; },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); }
  };

  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    location: { href: WATCH, search: '?v=abcdef12345' },
    document: doc,
    crypto: { randomUUID: (() => { let i = 0; return () => 'uuid-' + (++i); })() },
    URL,
    Date: FakeDate,
    CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
    WebSocket: FakeWS,
    setTimeout(fn, ms) { timers.push({ fn, ms, interval: false }); return timers.length; },
    setInterval(fn, ms) { timers.push({ fn, ms, interval: true }); return timers.length; },
    clearTimeout() {}, clearInterval() {}
  };
  if (opts.noGM !== true) {
    sandbox.GM_xmlhttpRequest = (o) => { sandbox.__lastXhr = o; };
    if (opts.noAddElement !== true) {
      sandbox.GM_addElement = (tag, attrs) => { headChildren.push({ tag, ...attrs, viaGM: true }); };
    }
  }
  if (opts.trustedTypes) {
    sandbox.trustedTypes = {
      createPolicy(name, rules) {
        if (opts.ttPolicyFails) throw new TypeError('Policy ' + name + ' is not allowed');
        return { createScript: (s) => ({ __trusted: true, text: rules.createScript(s) }) };
      }
    };
  }
  if (opts.pageGlobals) {
    sandbox.fetch = function () {
      return Promise.resolve({ clone() { return this; }, json() { return Promise.resolve({ events: [] }); } });
    };
    sandbox.__origFetch = sandbox.fetch;
    sandbox.XMLHttpRequest = class {
      addEventListener() {}
      open() {}
      send() {}
    };
  }
  // window-level stubs: boot() registers a timedtext listener and a beforeunload
  // listener on window, so a sandbox without these throws before any test can run.
  sandbox.addEventListener = (t, f) => { (listeners[t] = listeners[t] || []).push(f); };
  sandbox.removeEventListener = (t, f) => {
    const a = listeners[t] || [];
    const i = a.indexOf(f);
    if (i >= 0) a.splice(i, 1);
  };
  sandbox.dispatchEvent = (ev) => {
    for (const f of (listeners[ev.type] || []).slice()) f(ev);
    return true;
  };
  if (opts.sandboxed) sandbox.unsafeWindow = { page: 'other realm' };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.__sent = sent;
  sandbox.__sockets = sockets;
  sandbox.__timers = timers;
  sandbox.__listeners = listeners;
  sandbox.__bodyChildren = bodyChildren;
  sandbox.__headChildren = headChildren;
  sandbox.__box = box;
  sandbox.__clock = clock;
  return sandbox;
}

function load(opts) {
  const sandbox = makeSandbox(opts);
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'youtubesub.user.js' });
  return sandbox;
}

const api = (sb) => sb.__youtubesub;
const bridge = (sb) => sb.__youtubesub.instance;

// Sanity probe (health probe OK) then onopen -> register + sync.
function goLive(sb) {
  sb.__lastXhr.onload({ status: 200 });
  const ws = sb.__sockets[sb.__sockets.length - 1];
  ws.open();
  return ws;
}

function fakeVideo(over = {}) {
  return Object.assign({
    currentTime: 12.5, paused: false, ended: false, playbackRate: 1,
    listeners: {},
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  }, over);
}

function normCues(cues) {
  return Array.from(cues, (c) => [
    Number(c.start_ms.toFixed(3)), Number(c.end_ms.toFixed(3)),
    c.text, Number(c.last_off_ms.toFixed(3))]);
}

function lastFrame(sb, type) {
  const hit = [...sb.__sent].reverse().find((f) => f.type === type);
  return hit || null;
}

function assertWireFrame(f) {
  assert.ok(f && typeof f === 'object', 'frame is an object');
  assert.ok(VALID_TYPES.includes(f.type), 'known frame type: ' + JSON.stringify(f.type));
  if (f.type === 'sync' || f.type === 'deactivate') {
    assert.equal(typeof f.source_id, 'string');
    assert.ok(f.source_id.length > 0, 'source_id must be non-empty');
  }
  if (f.type === 'register' || f.type === 'cues') {
    assert.equal(typeof f.source_id, 'string');
  }
  if (f.type === 'sync') {
    assert.equal(typeof f.video_time_ms, 'number');
    assert.equal(typeof f.playing, 'boolean');
    assert.equal(typeof f.playback_rate, 'number');
    assert.equal(typeof f.timestamp, 'number');
  }
  if (f.type === 'cues') {
    assert.ok(Array.isArray(f.cues) && f.cues.length > 0, 'cues non-empty');
    for (const c of f.cues) {
      assert.equal(typeof c.start_ms, 'number');
      assert.ok(c.end_ms > c.start_ms, 'end_ms > start_ms');
      assert.ok(typeof c.text === 'string' && c.text.length > 0 && c.text.trim() === c.text,
        'text is non-empty and pre-trimmed');
      assert.ok(typeof c.last_off_ms === 'number' && c.last_off_ms >= c.start_ms,
        'last_off_ms >= start_ms');
    }
  }
}

// ------------------------------------------------------------------ loading ---

test('harness: userscript evaluates in the sandbox and exposes the test surface', () => {
  let sb;
  assert.doesNotThrow(() => { sb = load(); });
  const t = api(sb);
  for (const k of ['parseJson3', 'normKey', 'trackKindFromUrl', 'trackLangFromUrl',
                   'isTimedtextUrl', 'videoIdFromLocation', 'buildPageHookCode',
                   'cuesSignature', 'Bridge']) {
    assert.equal(typeof t[k], 'function', 'missing test surface: ' + k);
  }
  assert.ok(bridge(sb), 'bridge instance exists');
});

test('boot: page hook injected, timedtext listener + panel + poll timer wired', () => {
  const sb = load();
  assert.equal(sb.__headChildren.length, 1, 'one script element injected');
  assert.ok(/window.fetch\s*=/.test(sb.__headChildren[0].textContent), 'generated code wraps fetch');
  assert.equal(sb.__listeners['youtubesub-timedtext'].length, 1);
  assert.equal(sb.__listeners['beforeunload'].length, 1);
  assert.equal(sb.__bodyChildren.length, 1, 'status panel mounted');
  assert.match(sb.__bodyChildren[0].textContent, /^youtubesub: /);
  assert.ok(sb.__timers.some((t) => t.interval), 'video poll interval registered');
});

test('boot without GM_addElement falls back to a script element in head', () => {
  const sb = load({ noGM: true });
  assert.equal(sb.__headChildren.length, 1);
  assert.equal(sb.__headChildren[0].tag, 'script');
  assert.equal(sb.__headChildren[0].removed, true, 'fallback element removed after use');
});

// ------------------------------- page-hook injection under Trusted Types ----
// Found by the real-browser live run: youtube.com enforces
// require-trusted-types-for 'script', so the old textContent assignment threw and
// the hook silently never installed while the panel still claimed "connected".

test('boot: TrustedScript policy installs the hook when GM_addElement is gone', () => {
  const sb = load({ noAddElement: true, trustedTypes: true, trustedTypesBlock: true });
  assert.equal(bridge(sb).hookError, '', 'the policy path must succeed');
  const el = sb.__headChildren[0];
  assert.equal(el.tag, 'script');
  assert.ok(el.textContent.__trusted, 'textContent must be a TrustedScript');
  assert.ok(/window.fetch\s*=/.test(el.textContent.text), 'same generated hook code');
});

test('boot: falls back to direct evaluation when the element is blocked', () => {
  const sb = load({ noAddElement: true, trustedTypes: true, ttPolicyFails: true,
                    trustedTypesBlock: true, pageGlobals: true });
  assert.equal(bridge(sb).hookError, '');
  assert.notEqual(sb.fetch, sb.__origFetch, 'the fallback must really wrap fetch');
});

test('boot: an uninstallable page hook is reported, not hidden', () => {
  const sb = load({ noAddElement: true, trustedTypes: true, ttPolicyFails: true,
                    trustedTypesBlock: true });
  assert.match(bridge(sb).hookError, /textContent|TrustedScript|XMLHttpRequest/);
  assert.match(sb.__bodyChildren[0].textContent, /NO PAGE HOOK/);
  goLive(sb);
  const reg = sb.__sent.filter((f) => f.type === 'register').pop();
  assert.ok(reg, 'the bridge must still register');
  assert.ok(reg.hook_error && reg.hook_error.length > 0,
    'register must carry hook_error so the desktop can show it');
});

test('boot: a successful injection reports no hook error', () => {
  const sb = load();
  assert.equal(bridge(sb).hookError, '');
  const reg = goLive(sb).sentFrames.filter((f) => f.type === 'register').pop();
  assert.equal(reg.hook_error, '');
});

// ------------------------------------------------------------ parse parity ----

test('parseJson3: shared fixtures match the desktop parser contract', () => {
  const sb = load();
  for (const c of fixtures) {
    assert.deepEqual(normCues(api(sb).parseJson3(c.json3, WATCH)),
      c.expected.map((e) => [e.start_ms, e.end_ms, e.text, e.last_off_ms]),
      'case: ' + c.name);
  }
});

test('parseJson3: null / non-object payloads yield an empty list', () => {
  const sb = load();
  for (const bad of [null, undefined, 42, 'x', [], { events: 'nope' }]) {
    assert.deepEqual(normCues(api(sb).parseJson3(bad, WATCH)), []);
  }
});

test('parseJson3: last_off follows the last NON-BLANK seg with an offset', () => {
  const sb = load();
  const cues = api(sb).parseJson3({ events: [{ tStartMs: 100, dDurationMs: 500,
    segs: [{ utf8: 'a', tOffsetMs: 400 }, { utf8: '  ' }, { utf8: 'b' }] }] }, WATCH);
  assert.equal(cues[0].last_off_ms, 500, 'blank trailing seg must not move last_off');
});

// ------------------------------------------------------------------ helpers ---

test('normKey: rotating pot/fmt/tlang/c/sig params do not create a new track', () => {
  const sb = load();
  const base = 'https://www.youtube.com/api/timedtext?v=abcdef12345&lang=en&kind=asr';
  const key = api(sb).normKey(base);
  for (const extra of ['&pot=AAA', '&potc=1&fmt=json3&c=WEB&tlang=en&sig=xx&lsig=yy&expire=9&ip=a.b']) {
    assert.equal(api(sb).normKey(base + extra), key, 'rotation changed the key: ' + extra);
  }
  assert.notEqual(api(sb).normKey(base.replace('abcdef12345', 'zzzzzz99999')), key);
  assert.notEqual(api(sb).normKey(base + '&lang=de'), key, 'lang is part of the identity');
});

test('normKey: garbage input never throws and resolves against the page URL', () => {
  const sb = load();
  const t = api(sb);
  assert.equal(t.normKey(''), sb.location.href, 'empty input resolves to the page URL');
  assert.equal(t.normKey('::not a url::'), t.normKey('::not a url::'), 'stable across calls');
  assert.ok(t.normKey('/api/timedtext?v=x&pot=A')
    .startsWith('https://www.youtube.com/api/timedtext'), 'relative input resolves, not throws');
  assert.equal(typeof t.normKey(null), 'string');
});

test('url helpers: kind, lang, timedtext detection and video id extraction', () => {
  const sb = load();
  const t = api(sb);
  assert.equal(t.trackKindFromUrl('x?kind=asr'), 'asr');
  assert.equal(t.trackKindFromUrl('x?tlang=zh-Hans'), 'tlang');
  assert.equal(t.trackKindFromUrl('x?lang=en'), 'manual');
  assert.equal(t.trackLangFromUrl('x?lang=en-US'), 'en-US');
  assert.equal(t.trackLangFromUrl('x?tlang=zh-Hans'), 'zh-Hans');
  assert.equal(t.trackLangFromUrl('x?lang=en&tlang=zh-Hans'), 'zh-Hans',
    'tlang identifies the language of the returned cues');
  assert.equal(t.trackLangFromUrl('x?kind=asr'), '');
  assert.ok(t.isTimedtextUrl('https://www.youtube.com/api/timedtext?v=x&fmt=json3'));
  assert.ok(t.isTimedtextUrl('https://youtube.com/api/srv3?v=x'));
  assert.ok(!t.isTimedtextUrl('https://www.youtube.com/watch?v=x'), 'watch page is not timedtext');
  assert.ok(!t.isTimedtextUrl('https://example.com/timedtext.json3'), 'non-youtube host rejected');
});

test('videoIdFromLocation: v param, order and length guard', () => {
  const sb = load();
  const t = api(sb);
  assert.equal(t.videoIdFromLocation(), 'abcdef12345');
  sb.location.search = '?list=PL1&v=zzzzzz99999&t=3';
  assert.equal(t.videoIdFromLocation(), 'zzzzzz99999');
  sb.location.search = '?v=short';
  assert.equal(t.videoIdFromLocation(), '');
  sb.location.search = '';
  assert.equal(t.videoIdFromLocation(), '');
});

test('cuesSignature: distinct for same-count-different-content tracks', () => {
  const sb = load();
  const mk = (texts) => texts.map((t, i) => ({ start_ms: i * 1000, end_ms: i * 1000 + 900, text: t }));
  const a = api(sb).cuesSignature(mk(['one', 'two']));
  assert.notEqual(api(sb).cuesSignature(mk(['one', 'three'])), a);
  assert.notEqual(api(sb).cuesSignature(mk(['ONE', 'two'])), a);
  assert.notEqual(api(sb).cuesSignature(mk(['one'])), a);
  assert.equal(api(sb).cuesSignature(mk(['one', 'two'])), a, 'same content, same signature');
  assert.equal(api(sb).cuesSignature([]), '0:');
});

// ------------------------------------------------- generated page-hook code ----

function makePageContext() {
  const events = [];
  const payloads = [];
  const bodies = [];
  class FakeXHR {
    constructor() { this.listeners = {}; this.responseText = ''; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    open(m, u) { this.__origUrl = u; }
    send() { this.__origSent = true; }
  }
  const ctx = {
    console: { warn() {}, log() {} },
    CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } },
    XMLHttpRequest: FakeXHR,
    dispatchEvent(ev) { events.push(ev); return true; },
    __events: events,
    __payloads: payloads,
    __bodies: bodies,
    __video: null
  };
  ctx.window = ctx;
  ctx.self = ctx;
  // The hook reads bodies through res.clone().text() so that it can tell an empty
  // body (200 + text/html + 0 bytes, what youtube.com returns to a headless Chrome)
  // apart from a body that is simply not JSON.
  ctx.fetch = function () {
    return Promise.resolve({
      status: 200,
      clone() { return this; },
      text() { return Promise.resolve(bodies.length ? bodies.shift() : undefined); },
      json() { return Promise.resolve(payloads.shift()); }
    });
  };
  return ctx;
}

test('page hook: generated code executes and intercepts fetch + XHR', async () => {
  const sb = load();
  const code = api(sb).buildPageHookCode();
  const ctx = makePageContext();
  vm.createContext(ctx);
  const origFetch = ctx.fetch;
  const origSend = ctx.XMLHttpRequest.prototype.send;
  const origOpen = ctx.XMLHttpRequest.prototype.open;

  assert.doesNotThrow(() => { vm.runInContext(code, ctx, { filename: 'page-hook.js' }); });
  assert.notEqual(ctx.fetch, origFetch, 'fetch wrapped');
  assert.notEqual(ctx.XMLHttpRequest.prototype.send, origSend, 'XHR.send wrapped');
  assert.notEqual(ctx.XMLHttpRequest.prototype.open, origOpen, 'XHR.open wrapped');

  const tt = 'https://www.youtube.com/api/timedtext?v=abcdef12345&lang=en&fmt=json3&pot=AAA';
  const payload = { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hooked', tOffsetMs: 10 }] }] };

  // fetch path: intercepted URL emits the parsed json3 payload
  ctx.__payloads.push(payload);
  ctx.__bodies.push(JSON.stringify(payload));
  await ctx.fetch(tt);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.__events.length, 1, 'one timedtext event emitted');
  assert.equal(ctx.__events[0].type, 'youtubesub-timedtext');
  assert.equal(ctx.__events[0].detail.url, tt);
  assert.equal(ctx.__events[0].detail.data.events[0].segs[0].utf8, 'hooked');

  // non-timedtext URL must NOT emit
  ctx.__payloads.push(payload);
  ctx.__bodies.push(JSON.stringify(payload));
  await ctx.fetch('https://www.youtube.com/watch?v=abcdef12345');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.__events.length, 1, 'non-timedtext fetch stays silent');

  // the wrapped fetch must still hand the original response back to the page
  ctx.__payloads.push(payload);
  ctx.__bodies.push(JSON.stringify(payload));
  const res = await ctx.fetch(tt);
  assert.ok(res && typeof res.json === 'function', 'response passthrough preserved');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.__events.length, 2, 'second timedtext fetch emitted');

  // XHR path
  const xhr = new ctx.XMLHttpRequest();
  xhr.open('GET', tt);
  xhr.send();
  xhr.responseText = JSON.stringify(payload);
  assert.ok(xhr.__origSent, 'original XHR.send still called');
  assert.equal(xhr.listeners.load.length, 1, 'load listener attached for timedtext');
  for (const f of xhr.listeners.load) f();
  assert.equal(ctx.__events.length, 3, 'XHR timedtext emitted');

  const xhr2 = new ctx.XMLHttpRequest();
  xhr2.open('GET', 'https://www.youtube.com/watch?v=abcdef12345');
  xhr2.send();
  assert.equal(xhr2.listeners.load, undefined, 'non-timedtext XHR not instrumented');

  // malformed XHR body must not throw - and must be REPORTED, not swallowed
  const xhr3 = new ctx.XMLHttpRequest();
  xhr3.open('GET', tt);
  xhr3.send();
  xhr3.responseText = '{not json';
  assert.doesNotThrow(() => { for (const f of xhr3.listeners.load) f(); });
  assert.equal(ctx.__events.length, 4, 'unparsable body is reported as a capture failure');
  assert.match(ctx.__events[3].detail.error, /not JSON/);
});

// Found by the live run: youtube.com answers a headless Chrome with 200 +
// text/html + 0 bytes. The hook's parse threw inside a bare catch, so the panel
// kept saying "connected" while no subtitle ever arrived - undiagnosable.

test('page hook: an empty caption body is reported, not swallowed', async () => {
  const sb = load();
  const ctx = makePageContext();
  vm.createContext(ctx);
  vm.runInContext(api(sb).buildPageHookCode(), ctx, { filename: 'page-hook.js' });
  const tt = 'https://www.youtube.com/api/timedtext?v=abcdef12345&lang=en&fmt=json3&pot=AAA';
  ctx.__bodies.push('');
  await ctx.fetch(tt);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.__events.length, 1, 'a failure must be reported, not dropped');
  assert.match(ctx.__events[0].detail.error, /empty/);
  assert.equal(ctx.__events[0].detail.data, null);
});

test('page hook: a non-JSON caption body is reported', async () => {
  const sb = load();
  const ctx = makePageContext();
  vm.createContext(ctx);
  vm.runInContext(api(sb).buildPageHookCode(), ctx, { filename: 'page-hook.js' });
  const tt = 'https://www.youtube.com/api/timedtext?v=abcdef12345&lang=en&fmt=json3&pot=AAA';
  ctx.__bodies.push('<html>consent wall</html>');
  await ctx.fetch(tt);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.__events.length, 1);
  assert.match(ctx.__events[0].detail.error, /not JSON/);
});

test('bridge: a capture failure reaches the desktop as capture_error', () => {
  const sb = load();
  goLive(sb);
  const b = bridge(sb);
  const tt = 'https://www.youtube.com/api/timedtext?v=abcdef12345&lang=en&fmt=json3';
  b.onTimedtextFailure(tt, 'caption response was empty (status 200)');
  assert.equal(lastFrame(sb, 'register').capture_error,
    'caption response was empty (status 200)');
  assert.match(sb.__bodyChildren[0].textContent, /NO CAPTION BODY/);
  const before = sb.__sent.length;
  b.onTimedtextFailure(tt, 'caption response was empty (status 200)');
  assert.equal(sb.__sent.length, before, 'an unchanged reason is not re-broadcast');
  const payload = { events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'ok', tOffsetMs: 10 }] }] };
  b.onTimedtext(tt, payload);
  assert.equal(b.captureError, '', 'a usable payload clears the capture error');
  assert.equal(lastFrame(sb, 'register').capture_error, '');
});

test('boot: inside a userscript sandbox the direct-eval path is refused', () => {
  const sb = load({ noAddElement: true, trustedTypes: true, ttPolicyFails: true,
                    trustedTypesBlock: true, pageGlobals: true, sandboxed: true });
  assert.match(bridge(sb).hookError, /sandboxed/,
    'the sandbox must be named as the reason, not guessed at');
  assert.equal(sb.fetch, sb.__origFetch,
    'installing the hook into the wrong realm is worse than failing loudly');
});

// ------------------------------------------------------------------- bridge ---

test('bridge: healthy /health probe opens a socket to the documented URL', () => {
  const sb = load();
  assert.equal(sb.__lastXhr.url, 'http://127.0.0.1:9877/health');
  assert.equal(sb.__lastXhr.method, 'GET');
  const ws = goLive(sb);
  assert.equal(ws.url, 'ws://127.0.0.1:9877/ws');
  assert.equal(bridge(sb).state, 'connected');
  // No video element is bound yet, so there is nothing to sync: register alone is
  // correct. The first sync follows as soon as the player exists.
  assert.deepEqual(sb.__sent.map((f) => f.type), ['register']);
  sb.__sent.forEach(assertWireFrame);
  assert.equal(lastFrame(sb, 'register').provider, 'youtube');
  assert.equal(lastFrame(sb, 'register').source_id, 'uuid-1');
  bridge(sb).bindVideo(fakeVideo({ currentTime: 2 }));
  assert.equal(lastFrame(sb, 'sync').video_time_ms, 2000);
});

test('bridge: failed /health probe schedules a reconnect and opens no socket', () => {
  const sb = load();
  const before = sb.__timers.length;
  sb.__lastXhr.onerror();
  assert.equal(sb.__sockets.length, 0, 'no socket after probe failure');
  assert.match(bridge(sb).state, /^retry in 3s$/);
  assert.equal(sb.__timers.length, before + 1);
  assert.equal(sb.__timers[sb.__timers.length - 1].ms, 3000);
  const t = sb.__timers[sb.__timers.length - 1];
  t.fn();
  assert.equal(sb.__lastXhr.url, 'http://127.0.0.1:9877/health', 'reconnect re-probes health');
});

test('bridge: reconnect backoff is exponential and capped at 30s', () => {
  const sb = load();
  goLive(sb);
  const b = bridge(sb);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const n = sb.__timers.length;
    b.scheduleReconnect();
    assert.equal(sb.__timers.length, n + 1);
    seen.push(sb.__timers[sb.__timers.length - 1].ms);
  }
  assert.deepEqual(seen, [3000, 6000, 12000, 24000, 30000, 30000]);
});

test('bridge: ws close reconnects, retryNow resets attempts, stop is terminal', () => {
  const sb = load();
  const ws = goLive(sb);
  const b = bridge(sb);
  ws.close();
  assert.equal(b.state, 'retry in 3s', 'a close goes straight to the backoff state');
  assert.equal(b.attempts, 1, 'close scheduled one reconnect');
  b.attempts = 5;
  b.retryNow();
  assert.equal(b.attempts, 0, 'retryNow resets the backoff');
  assert.match(b.state, /^probing$/);
  b.stop();
  assert.equal(b.state, 'stopped');
  const before = sb.__sockets.length;
  b.connect();
  assert.equal(sb.__sockets.length, before, 'connect() after stop() is a no-op');
});

test('bridge: status panel click retries, double-click stops', () => {
  const sb = load();
  const panel = sb.__bodyChildren[0];
  panel.listeners.click.forEach((f) => f());
  assert.match(bridge(sb).state, /^probing$/);
  panel.listeners.dblclick.forEach((f) => f());
  assert.equal(bridge(sb).state, 'stopped');
  assert.equal(panel.style.color, '#f88');
});

test('bridge: sync reflects live player state (time/playing/rate)', () => {
  const sb = load();
  goLive(sb);
  const b = bridge(sb);
  const v = fakeVideo({ currentTime: 3.25, paused: true, playbackRate: 1.5 });
  b.bindVideo(v);
  let f = lastFrame(sb, 'sync');
  assert.equal(f.video_time_ms, 3250);
  assert.equal(f.playing, false);
  assert.equal(f.playback_rate, 1.5);
  assert.equal(f.timestamp, sb.__clock.now);

  v.paused = false; v.currentTime = 4.5; v.playbackRate = 2;
  v.listeners.play.forEach((fn) => fn());
  f = lastFrame(sb, 'sync');
  assert.equal(f.video_time_ms, 4500);
  assert.equal(f.playing, true);
  assert.equal(f.playback_rate, 2);

  v.ended = true;
  v.listeners.ratechange.forEach((fn) => fn());
  assert.equal(lastFrame(sb, 'sync').playing, false, 'ended counts as not playing');
  sb.__sent.forEach(assertWireFrame);
});

test('bridge: send() is a no-op while the socket is not open', () => {
  const sb = load();
  const b = bridge(sb);
  assert.equal(b.send({ type: 'sync', source_id: 'x' }), false);
  sb.__lastXhr.onload({ status: 200 });
  const ws = sb.__sockets[0];
  assert.equal(b.send({ type: 'sync', source_id: 'x' }), false, 'still connecting');
  ws.open();
  assert.equal(b.send({ type: 'sync', source_id: 'x' }), true);
});

test('bridge: onTimedtext pushes register+cues and validates on the wire', () => {
  const sb = load();
  goLive(sb);
  const b = bridge(sb);
  sb.__sent.length = 0;
  const url = 'https://www.youtube.com/api/timedtext?v=abcdef12345&kind=asr&lang=en&pot=P1';
  b.onTimedtext(url, fixtures[1].json3);
  assert.deepEqual(sb.__sent.map((f) => f.type), ['register', 'cues']);
  const cuesFrame = lastFrame(sb, 'cues');
  assert.equal(cuesFrame.track_kind, 'asr');
  assert.equal(cuesFrame.track_lang, 'en');
  assert.equal(cuesFrame.video_id, 'abcdef12345');
  assert.equal(cuesFrame.cues.length, 1);
  assert.equal(cuesFrame.cues[0].text, 'hi there folks');
  sb.__sent.forEach(assertWireFrame);
});

test('bridge: rotating pot with identical content does not re-push cues', () => {
  const sb = load();
  goLive(sb);
  const b = bridge(sb);
  const base = 'https://www.youtube.com/api/timedtext?v=abcdef12345&lang=en&kind=asr';
  b.onTimedtext(base + '&pot=P1', fixtures[1].json3);
  sb.__sent.length = 0;
  b.onTimedtext(base + '&pot=P2&fmt=json3&c=WEB&expire=77', fixtures[1].json3);
  assert.deepEqual(sb.__sent, [], 'pot/form rotation must not spam the desktop');
});

test('bridge: same cue count but different text re-pushes (tlang switch regression)', () => {
  const sb = load();
  goLive(sb);
  const b = bridge(sb);
  const base = 'https://www.youtube.com/api/timedtext?v=abcdef12345&kind=asr';
  b.onTimedtext(base + '&lang=en', fixtures[1].json3);
  sb.__sent.length = 0;
  const switched = JSON.parse(JSON.stringify(fixtures[1].json3));
  switched.events[0].segs[1].utf8 = 'translated differently';
  // same normKey inputs except tlang is stripped by normKey => same key, same count
  b.onTimedtext(base + '&lang=en&tlang=zh-Hans', switched);
  assert.deepEqual(sb.__sent.map((f) => f.type), ['register', 'cues'],
    'identical cue count with different text must still be pushed');
  assert.equal(lastFrame(sb, 'cues').cues[0].text, 'translated differently folks');
  assert.equal(lastFrame(sb, 'cues').track_lang, 'zh-Hans',
    'a tlang request is labelled with the translated language');
});

test('bridge: empty or non-timedtext payloads are ignored', () => {
  const sb = load();
  goLive(sb);
  const b = bridge(sb);
  sb.__sent.length = 0;
  b.onTimedtext('https://www.youtube.com/api/timedtext?v=abcdef12345', { events: [] });
  b.onTimedtext('https://www.youtube.com/watch?v=abcdef12345', fixtures[1].json3);
  b.onTimedtext('https://www.youtube.com/api/timedtext?v=abcdef12345', { nope: 1 });
  assert.deepEqual(sb.__sent, []);
});

test('bridge: reconnect replays cached register/cues and KEEPS the sync timestamp', () => {
  const sb = load();
  goLive(sb);
  const b = bridge(sb);
  const v = fakeVideo({ currentTime: 5 });
  b.bindVideo(v);
  b.onTimedtext('https://www.youtube.com/api/timedtext?v=abcdef12345&lang=en&kind=asr',
    fixtures[3].json3);
  const cachedSync = { ...lastFrame(sb, 'sync') };
  const cachedCues = lastFrame(sb, 'cues');
  assert.equal(cachedSync.timestamp, sb.__clock.now);

  // the video keeps playing while the socket is down
  sb.__clock.now += 25000;
  v.currentTime = 30;
  sb.__sockets[0].close();
  sb.__sent.length = 0;

  const t = sb.__timers[sb.__timers.length - 1];
  assert.equal(t.ms, 3000);
  t.fn();
  sb.__lastXhr.onload({ status: 200 });
  const ws2 = sb.__sockets[sb.__sockets.length - 1];
  assert.notEqual(ws2, sb.__sockets[0]);
  ws2.open();

  assert.deepEqual(sb.__sent.map((f) => f.type), ['register', 'cues', 'sync'],
    'replay order: register, cues, then the cached sync');
  assert.equal(sb.__sent[2].timestamp, cachedSync.timestamp,
    'replayed sync must keep the original timestamp');
  assert.equal(sb.__sent[2].video_time_ms, cachedSync.video_time_ms);
  assert.notEqual(sb.__sent[2].timestamp, sb.__clock.now, 'timestamp must not be refreshed');
  assert.deepEqual(sb.__sent[1], cachedCues);
  sb.__sent.forEach(assertWireFrame);

  // a fresh sync, by contrast, uses the current clock
  b.sendSync();
  assert.equal(lastFrame(sb, 'sync').timestamp, sb.__clock.now);
});

test('bridge: SPA navigation starts a new source and drops stale cues', () => {
  const sb = load();
  goLive(sb);
  const b = bridge(sb);
  b.bindVideo(fakeVideo());
  b.onTimedtext('https://www.youtube.com/api/timedtext?v=abcdef12345&lang=en&kind=asr',
    fixtures[1].json3);
  const oldId = b.sourceId;
  sb.__sent.length = 0;

  sb.location.search = '?v=zzzzzz99999';
  sb.__box.video = fakeVideo({ currentTime: 0 });
  b.poll();

  assert.notEqual(b.sourceId, oldId, 'new source_id minted');
  assert.equal(b.videoId, 'zzzzzz99999');
  assert.deepEqual(sb.__sent.map((f) => f.type), ['deactivate', 'register', 'sync'],
    'stale source deactivated, new source registered');
  assert.equal(sb.__sent[0].source_id, oldId);
  assert.equal(sb.__sent[1].source_id, b.sourceId);
  assert.equal(sb.__sent[1].video_id, 'zzzzzz99999');
  assert.ok(!sb.__sent.some((f) => f.type === 'cues'), 'no stale cues replayed');
  sb.__sent.forEach(assertWireFrame);

  // same video twice must not churn sources
  const id = b.sourceId;
  sb.__sent.length = 0;
  b.poll();
  assert.equal(b.sourceId, id);
  assert.deepEqual(sb.__sent, []);
});

test('bridge: poll binds a video element that appears later', () => {
  const sb = load();
  goLive(sb);
  const b = bridge(sb);
  sb.__sent.length = 0;
  sb.__box.video = fakeVideo({ currentTime: 1, paused: true });
  b.poll();
  assert.equal(sb.__sent[0].type, 'sync', 'binding sends an immediate sync');
  const n = sb.__sent.length;
  sb.__box.video.listeners.timeupdate.forEach((f) => f());
  assert.equal(sb.__sent.length, n + 1);
  sb.__sent.forEach(assertWireFrame);
});

test('bridge: works without GM_xmlhttpRequest (no /health probe, connects anyway)', () => {
  const sb = load({ noGM: true });
  assert.equal(sb.__sockets.length, 1,
    'without GM_xmlhttpRequest the socket attempt is the only liveness test');
  const ws = sb.__sockets[0];
  assert.equal(ws.url, 'ws://127.0.0.1:9877/ws');
  ws.open();
  assert.equal(bridge(sb).state, 'connected');
  assert.deepEqual(sb.__sent.map((f) => f.type), ['register']);
});

test('bridge: every frame produced during a full session is wire-valid', () => {
  const sb = load();
  goLive(sb);
  const b = bridge(sb);
  const v = fakeVideo();
  b.bindVideo(v);
  for (const fx of fixtures) {
    b.onTimedtext('https://www.youtube.com/api/timedtext?v=abcdef12345&lang=' + fx.name.length
      + '&kind=manual', fx.json3);
  }
  v.currentTime = 40; v.paused = true;
  v.listeners.pause.forEach((f) => f());
  v.currentTime = 90;
  v.listeners.seeked.forEach((f) => f());
  v.playbackRate = 2;
  v.listeners.ratechange.forEach((f) => f());
  sb.__listeners['beforeunload'].forEach((f) => f());

  assert.ok(sb.__sent.length > 10, 'a full session produces frames');
  sb.__sent.forEach(assertWireFrame);
  assert.ok(sb.__sent.some((f) => f.type === 'deactivate'), 'unload deactivates the source');
  const syncs = sb.__sent.filter((f) => f.type === 'sync');
  assert.equal(syncs[syncs.length - 1].video_time_ms, 90000);
  const sids = new Set(sb.__sent.map((f) => f.source_id));
  assert.equal(sids.size, 1, 'one session keeps one source_id');
});

test('bridge: cue frames from the real userscript satisfy the desktop coercer', () => {
  const sb = load();
  goLive(sb);
  const b = bridge(sb);
  b.onTimedtext('https://www.youtube.com/api/timedtext?v=abcdef12345&lang=en&kind=asr',
    fixtures[8].json3);
  const frame = lastFrame(sb, 'cues');
  // same rules as protocol.coerce_cue: text non-empty, end > start, last_off >= start
  for (const c of frame.cues) {
    assert.ok(c.text.trim().length > 0);
    assert.ok(c.end_ms > c.start_ms);
    assert.ok(c.last_off_ms >= c.start_ms);
  }
  // space-joined segs (#26): '你好' + '世界' must not glue into one token
  assert.equal(frame.cues[0].text, '你好 世界');
});

// ------------------------------------------------------------ installability ----
// Tampermonkey parses the metadata block *before* it will install or run anything;
// a malformed block is rejected with "用户脚本无效" (invalid userscript). Nothing
// else here reads that block: load() evaluates the body as plain JS and
// desktop/tests/browser_e2e.py injects the file over CDP, so a broken header ships
// green. Regression: the "// ==/UserScript==" terminator was silently lost.
test('userscript metadata block is installable by Tampermonkey', () => {
  assert.ok(src.startsWith('// ==UserScript==\n'),
    'the metadata block must open on line 1 (Tampermonkey ignores it otherwise)');
  const end = src.indexOf('// ==/UserScript==');
  assert.notEqual(end, -1, 'the metadata block must be closed by "// ==/UserScript=="');
  const block = src.slice(0, end).split('\n');
  block.forEach((line, i) => {
    assert.ok(line === '' || line.startsWith('//'),
      `line ${i + 1} inside the metadata block is not a comment: ${JSON.stringify(line)}`);
  });
  const meta = {};
  for (const m of block.join('\n').matchAll(/^\/\/\s*@([\w-]+)\s+(.+)$/gm)) {
    (meta[m[1]] ||= []).push(m[2].trim());
  }
  for (const key of ['name', 'namespace', 'version', 'match', 'run-at', 'grant', 'connect']) {
    assert.ok(meta[key] && meta[key].length, `metadata is missing @${key}`);
  }
  assert.equal(meta['run-at'][0], 'document-start',
    'the page hook must install before the site code runs');
});
