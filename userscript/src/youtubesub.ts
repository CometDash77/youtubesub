// youtubesub userscript — TypeScript source (single-file discipline).
// Built by scripts/build.ts: esbuild direct-drive (format iife, platform
// browser) plus a verbatim Tampermonkey metadata banner -> ../youtubesub.user.js.
// The metadata block lives in the build banner, not here: bundlers strip
// ordinary comments, and the artifact's first line must stay ==UserScript==.
//
// Page-context interception adapted from dkitle dkitle.user.js:388-460 (MIT, (c) ywxt),
// reworked for this project: SPA navigation creates a new source (dkitle defect fixed),
// replayed sync keeps its original timestamp (dkitle reconnect-jump defect fixed).
// Cue decoding mirrors yt-dual-subs parseJson3 (MIT, (c) 2026 Gythiro).

"use strict";

interface Cue {
  start_ms: number;
  end_ms: number;
  text: string;
  last_off_ms: number;
}

interface Json3Seg {
  utf8?: unknown;
  tOffsetMs?: number;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
}

type WireFrame = Record<string, unknown>;
type CacheSlot = 'register' | 'cues' | 'sync';
type VideoMetadata = { tab_title: string; video_description?: string };

// Test surface hung off window for userscript/tests (see window.__youtubesub).
interface Window {
  __youtubesub: {
    parseJson3: (json: any, url: string) => Cue[];
    cuesSignature: (cues: Cue[]) => string;
    normKey: (url: string) => string;
    trackKindFromUrl: (url: string) => string;
    trackLangFromUrl: (url: string) => string;
    isTimedtextUrl: (url: unknown) => boolean;
    videoIdFromLocation: () => string;
    buildPageHookCode: (level?: string) => string;
    Bridge: typeof Bridge;
    cfg: typeof DEFAULTS;
    instance: Bridge;
  };
}

// The injected page hook stashes the request URL on the XHR instance.
interface XMLHttpRequest {
  __ytusUrl?: string;
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 9877,
  reconnectBaseMs: 3000,
  reconnectMaxMs: 30000,
  videoPollMs: 1500,
  hookReceiptMs: 500
};

const CFG = Object.assign({}, DEFAULTS);

// ---- pure helpers (unit-tested in node, see tests/userscript.test.ts) ----
function normKey(url: string): string {
  // pot/fmt/tlang rotate per request and must not look like a new track
  try {
    const u = new URL(url, location.href);
    ['fmt', 'tlang', 'pot', 'potc', 'c', 'expire', 'ip', 'signature', 'sig', 'lsig', 'n'].forEach(function (k) {
      u.searchParams.delete(k);
    });
    return u.origin + u.pathname + '?' + u.searchParams.toString();
  } catch (e) {
    return String(url || '');
  }
}

function trackKindFromUrl(url: string): string {
  const s = String(url || '');
  if (/[?&]kind=asr/.test(s)) return 'asr';
  if (/[?&]tlang=/.test(s)) return 'tlang';
  return 'manual';
}

function trackLangFromUrl(url: string): string {
  const s = String(url || '');
  // tlang wins when present: the returned cue text is the translation, so
  // reporting the source lang would mislabel the track metadata.
  const m = /[?&]tlang=([^&]+)/.exec(s) || /[?&]lang=([^&]+)/.exec(s);
  return m ? decodeURIComponent(m[1]) : '';
}

function isTimedtextUrl(url: unknown): boolean {
  return /timedtext|srv3|json3/i.test(String(url || '')) && String(url || '').indexOf('youtube') !== -1;
}

function parseJson3(json: any, url: string): Cue[] {
  // mirrors desktop suboverlay/protocol.py parse_json3 (yt-dual-subs semantics, MIT)
  const cues: Cue[] = [];
  if (!json || !Array.isArray(json.events)) return cues;
  for (let i = 0; i < json.events.length; i++) {
    const ev = json.events[i];
    if (!ev || !Array.isArray(ev.segs)) continue;
    const parts: string[] = [];
    let off = 0, hasOff = false;
    for (let s = 0; s < ev.segs.length; s++) {
      const seg = ev.segs[s];
      if (!seg || typeof seg.utf8 !== 'string') continue;
      // Seg separator aligned with the desktop parser (#26): space-join, then
      // collapse - a seg without a trailing space must not glue the next word
      // onto it (word/char counts feed the segmentation criteria).
      parts.push(seg.utf8);
      if (seg.utf8.trim() && typeof seg.tOffsetMs === 'number') { off = seg.tOffsetMs; hasOff = true; }
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim().replace(/(^|\s)>{2,}\s*/g, '$1').trim();
    if (!text) continue;
    const start = typeof ev.tStartMs === 'number' ? ev.tStartMs : 0;
    const dur = typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 0;
    if (dur <= 0) continue;
    cues.push({
      start_ms: start,
      end_ms: start + dur,
      text: text,
      last_off_ms: hasOff ? start + off : start
    });
  }
  return cues;
}

function cuesSignature(cues: Cue[]): string {
  // Content fingerprint used to dedup re-intercepted tracks. Cue COUNT alone is
  // not enough: a switched track (e.g. tlang rotation) can carry the same number
  // of cues with different text, and count-only dedup silently dropped it.
  const n = cues.length;
  if (!n) return '0:';
  let chars = 0;
  for (let i = 0; i < n; i++) chars += cues[i].text.length;
  return [n, chars, cues[0].start_ms, cues[n - 1].end_ms,
          cues[0].text, cues[n - 1].text].join(':');
}

function videoMetadata(): VideoMetadata {
  const title = String(document.title || '').replace(/\s+- YouTube\s*$/i, '').trim();
  const metadata: VideoMetadata = { tab_title: title };
  const description = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
  const content = description && typeof description.content === 'string'
    ? description.content.trim() : '';
  if (content) metadata.video_description = content;
  return metadata;
}

// This function is serialized into the page's main world. Keep it self-contained:
// the page's own request already has the credentials needed for timedtext.
// The receipt (issue #41) rides along: the injected code reports WHICH level ran
// and which entry points it really wrapped, because "the injector did not throw"
// is not evidence that a hook exists - a message from this realm is.
function pageHook(LEVEL: string) {
  const entries: string[] = [];
  function isCaption(url: unknown) {
    const s = String(url || '');
    return /timedtext|srv3|json3/i.test(s) && s.indexOf('youtube') !== -1;
  }

  function report(url: unknown, data: unknown, error: unknown) {
    window.dispatchEvent(new CustomEvent('youtubesub-timedtext', {
      detail: { url: url, data: data, error: error }
    }));
  }

  function deliver(url: unknown, body: unknown, status: unknown) {
    if (!body) {
      report(url, null, 'caption response was empty (status ' + status + ')');
      return;
    }
    try {
      report(url, JSON.parse(body as string), '');
    } catch (e) {
      report(url, null, 'caption response was not JSON (status ' + status + ')');
    }
  }

  function unreadable(url: unknown, error: unknown) {
    report(url, null, 'caption response could not be read: ' + error);
  }

  const originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function (this: unknown, ...args: any[]) {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const response = (originalFetch as any).apply(this, args);
      if (isCaption(url)) {
        response.then(function (result: any) {
          try {
            result.clone().text().then(
              function (body: string) { deliver(url, body, result.status); },
              function (error: unknown) { unreadable(url, error); }
            );
          } catch (error) { unreadable(url, error); }
        });
      }
      return response;
    };
    entries.push('fetch');
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
    this.__ytusUrl = url as string;
    return (originalOpen as any).apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest) {
    const xhr = this;
    const url = xhr.__ytusUrl;
    if (isCaption(url)) {
      xhr.addEventListener('load', function () {
        try { deliver(xhr.__ytusUrl, xhr.responseText, xhr.status); }
        catch (error) { unreadable(xhr.__ytusUrl, error); }
      });
    }
    return (originalSend as any).apply(this, arguments);
  };
  entries.push('xhr');

  // The receipt: it names the injection level and which entry points were really
  // wrapped in THIS realm. Only a receipt with at least one entry counts outside.
  if (window.dispatchEvent) {
    window.dispatchEvent(new CustomEvent('youtubesub-hook-ready', { detail: { level: LEVEL, entries: entries } }));
  }
}

function buildPageHookCode(level?: string): string {
  return '(' + pageHook.toString() + ')(' + JSON.stringify(String(level || '')) + ');';
}

let _ttPolicy: any = null;
let _ttPolicyFailed = false;
let _ttNotice = '';

function trustedScript(code: string): unknown {
  // A page with require-trusted-types-for 'script' refuses a plain string
  // assignment to script.textContent - this is what silently killed the hook on
  // youtube.com. A policy created by this frame is the sanctioned way through,
  // and it only works when the page's CSP allows the policy name.
  if (_ttPolicyFailed) return null;
  try {
    const tt = (window as any).trustedTypes;
    if (!tt || typeof tt.createPolicy !== 'function') {
      _ttPolicyFailed = true;
      _ttNotice = 'Trusted Types unavailable';
      return null;
    }
    if (!_ttPolicy) {
      _ttPolicy = tt.createPolicy('youtubesub', { createScript: function (s: string) { return s; } });
    }
    return _ttPolicy.createScript(code);
  } catch (e) {
    _ttPolicyFailed = true;
    _ttNotice = 'Trusted Types policy rejected: ' + e;
    return null;
  }
}

// ---- injection receipt (issue #41) ----------------------------------------
// Before this, injecting "successfully" only meant that the injector call had not
// thrown. A script blocked by CSP, or evaluated in the wrong realm, looked exactly
// like a working hook: the bridge said "connected", hook_error stayed empty, and
// the overlay waited forever. Now a level only counts once the injected code has
// reported back FROM THE PAGE WORLD, which is a fact the injector cannot fake.
const _hookReceipt = {
  onConfirmed: null as ((why: string) => void) | null,      // resolves the level being awaited with '' when it answers
  onLateConfirmed: null as ((why: string) => void) | null,  // resolves a receipt that arrives after every level timed out
  timer: null as ReturnType<typeof setTimeout> | null,
  emptyLevels: [] as string[]                               // levels that ran somewhere but hooked no entry point
};

function onHookReadyEvent(ev: Event) {
  const d = ((ev as CustomEvent).detail) || {};
  const entries = Array.isArray(d.entries) ? d.entries : [];
  const level = String(d.level || '?');
  if (!entries.length) {
    // The code ran, but wrapped neither fetch nor XMLHttpRequest: that is not an
    // installation, even though it executed.
    if (_hookReceipt.emptyLevels.indexOf(level) < 0) _hookReceipt.emptyLevels.push(level);
    return;
  }
  const confirmed = _hookReceipt.onConfirmed;
  _hookReceipt.onConfirmed = null;
  if (confirmed) { confirmed(''); return; }
  if (_hookReceipt.onLateConfirmed) {
    // Every level already timed out and the failure was reported: the page code
    // was merely slow. Repair the state instead of keeping a lie on screen.
    const late = _hookReceipt.onLateConfirmed;
    _hookReceipt.onLateConfirmed = null;
    late('');
  }
}

function injectPageHooks(onDone: (err: string) => void) {
  // onDone(errorString): '' only when some level was CONFIRMED by a page receipt.
  // Each level is tried in turn and gets hookReceiptMs to answer; a level that
  // cannot answer is judged failed and the reason names it, so a failed install
  // says WHICH level failed instead of only "it did not work".
  const ways: Array<{ id: string; run: (code: string) => string }> = [];
  // 1) Tampermonkey's GM_addElement injects from the extension context, so it
  //    bypasses page CSP and Trusted Types. This is the production path.
  ways.push({ id: 'gm', run: function (code: string) {
    if (typeof GM_addElement !== 'function') return 'gm: GM_addElement not granted';
    (GM_addElement as any)('script', { textContent: code });
    return '';
  } });
  // 2) Page-context injection through a script element, Trusted Types aware.
  ways.push({ id: 'script-element', run: function (code: string) {
    const el = document.createElement('script');
    const trusted = trustedScript(code);
    el.textContent = (trusted as string) || code;
    (document.head || document.documentElement).appendChild(el);
    el.remove();
    return '';
  } });
  // 3) Direct evaluation: immune to Trusted Types and correct whenever this
  //    script already runs in the page's main world (document-start injection by
  //    a harness, or @sandbox none). Inside a userscript sandbox it would install
  //    the hook in the wrong realm, which is worse than failing loudly - so it is
  //    skipped there.
  const sandboxed = (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window);
  if (sandboxed) {
    ways.push({ id: 'sandboxed', run: function () {
      return 'sandboxed: no page-context injection path left';
    } });
  } else {
    ways.push({ id: 'direct-eval', run: function (code: string) {
      (new Function(code))();
      return '';
    } });
  }

  const reasons: string[] = [];
  let settled = false;
  let next = 0;

  function finish(err: string) {
    if (settled) return;
    settled = true;
    _hookReceipt.onConfirmed = null;
    if (_hookReceipt.timer !== null) { clearTimeout(_hookReceipt.timer); _hookReceipt.timer = null; }
    onDone(err);
  }

  function step() {
    if (settled) return;
    if (next >= ways.length) {
      finish(reasons.join(' | ') || 'no page-context injection path available');
      return;
    }
    const way = ways[next++];
    let why = '';
    // Trusted Types is a per-level verdict: reset it so only the level that really
    // hit it carries the note (a direct-eval timeout must not inherit it).
    _ttNotice = '';
    _hookReceipt.onConfirmed = function () { finish(''); };
    try {
      why = way.run(buildPageHookCode(way.id)) || '';
    } catch (e) {
      why = way.id + ': ' + (e as Error);
    }
    if (settled) return;                 // the receipt arrived synchronously
    if (why) {                           // the injector itself refused to inject
      _hookReceipt.onConfirmed = null;
      reasons.push(why + (_ttNotice ? ' [' + _ttNotice + ']' : ''));
      step();
      return;
    }
    _hookReceipt.timer = setTimeout(function () {
      if (settled) return;
      _hookReceipt.onConfirmed = null;
      const empty = _hookReceipt.emptyLevels.indexOf(way.id) >= 0;
      reasons.push(way.id + ': ' + (empty
        ? 'injected code ran but hooked neither fetch nor XMLHttpRequest'
        : 'no hook receipt within ' + CFG.hookReceiptMs + 'ms'
          + ' (injected code never ran in the page world)')
        + (_ttNotice ? ' [' + _ttNotice + ']' : ''));
      step();
    }, CFG.hookReceiptMs);
  }

  step();
}

function uuid(): string {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'ytus-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

class Bridge {
  ws: WebSocket | null = null;
  state = 'idle';
  attempts = 0;
  stopped = false;
  videoEl: HTMLVideoElement | null = null;
  statusEl: HTMLDivElement | null = null;
  hookError = '';
  sourceId = '';
  videoId = '';
  trackKey = '';
  cueSig = '';
  cueCount = -1;
  trackKind = '';
  trackLang = '';
  captureError = '';
  // Command-channel token (#219): connection-level, survives video changes.
  wsToken: string | null = null;
  cache: Record<CacheSlot, WireFrame | null> = { register: null, cues: null, sync: null };

  constructor() {
    this.resetSource('');
  }

  resetSource(videoId: string) {
    this.sourceId = uuid();
    this.videoId = videoId;
    this.trackKey = '';
    this.cueSig = '';
    this.cueCount = -1;
    this.trackKind = '';
    this.trackLang = '';
    this.captureError = '';
    this.cache = { register: null, cues: null, sync: null };
  }

  health(done: (ok: boolean) => void) {
    if (typeof GM_xmlhttpRequest !== 'function') { done(true); return; }
    (GM_xmlhttpRequest as any)({
      method: 'GET',
      url: 'http://' + CFG.host + ':' + CFG.port + '/health',
      timeout: 2000,
      onload: function (response: any) { done(response.status >= 200 && response.status < 300); },
      onerror: function () { done(false); },
      ontimeout: function () { done(false); }
    });
  }

  // Command-channel token (#219). The desktop serves GET /token with no CORS
  // headers, so page-world JS cannot read it; GM_xmlhttpRequest can. Failure
  // is not fatal: null keeps this connection upstream-only (frames flow,
  // commands do not) - also the compatibility path against an older desktop.
  fetchToken(done: (token: string | null) => void) {
    if (typeof GM_xmlhttpRequest !== 'function') { done(null); return; }
    (GM_xmlhttpRequest as any)({
      method: 'GET',
      url: 'http://' + CFG.host + ':' + CFG.port + '/token',
      timeout: 2000,
      onload: function (response: any) {
        if (response.status < 200 || response.status >= 300) { done(null); return; }
        try {
          const data = JSON.parse(response.responseText);
          done(typeof data.token === 'string' && data.token ? data.token : null);
        } catch (error) { done(null); }
      },
      onerror: function () { done(null); },
      ontimeout: function () { done(null); }
    });
  }

  send(frame: WireFrame): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(frame)); return true; }
    catch (error) { return false; }
  }

  cacheAndSend(kind: CacheSlot, frame: WireFrame): boolean {
    this.cache[kind] = frame;
    return this.send(frame);
  }

  connect() {
    if (this.stopped) return;
    this.setState('probing');
    this.health((healthy) => {
      if (this.stopped) return;
      if (!healthy) { this.scheduleReconnect(); return; }
      this.fetchToken((token) => {
        if (this.stopped) return;
        this.wsToken = token;
        this.openSocket();
      });
    });
  }

  openSocket() {
    this.setState('connecting');
    try { this.ws = new WebSocket('ws://' + CFG.host + ':' + CFG.port + '/ws'); }
    catch (error) { this.scheduleReconnect(); return; }
    this.ws!.onopen = () => {
      this.attempts = 0;
      this.setState('connected');
      this.replay();
    };
    this.ws!.onclose = () => {
      this.setState('closed');
      this.scheduleReconnect();
    };
    this.ws!.onerror = () => { this.setState('error'); };
    this.ws!.onmessage = (ev: MessageEvent) => { this.onCommand(ev.data); };
  }

  replay() {
    this.send(this.cache.register || this.buildRegister());
    if (this.cache.cues) this.send(this.cache.cues);
    if (this.cache.sync) this.send(this.cache.sync);
    else this.sendSync();
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(CFG.reconnectBaseMs * 2 ** this.attempts, CFG.reconnectMaxMs);
    this.attempts += 1;
    this.setState('retry in ' + Math.round(delay / 1000) + 's');
    setTimeout(() => { this.connect(); }, delay);
  }

  retryNow() {
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.ws) {
      try { this.ws.close(); } catch (error) { /* already closed */ }
    }
    this.setState('stopped');
  }

  buildRegister(): WireFrame {
    const frame: WireFrame = Object.assign({
      type: 'register', provider: 'youtube', source_id: this.sourceId,
      video_id: this.videoId,
      track_kind: this.trackKind, track_lang: this.trackLang,
      hook_error: this.hookError, capture_error: this.captureError
    }, videoMetadata());
    // Token only when we hold one (#219): an absent key keeps the frame
    // byte-compatible with an older desktop (v1-additive optional key).
    if (this.wsToken) frame.token = this.wsToken;
    return frame;
  }

  setHookError(msg: string) {
    msg = msg || '';
    if (msg === this.hookError) return;
    this.hookError = msg;
    if (msg) console.warn('[youtubesub] page hook not installed:', msg);
    this.republishRegister();
  }

  republishRegister() {
    // The register frame carries hook_error: a late repair must reach the desktop
    // even when no new cue arrives (sent un-cached on purpose).
    this.send(this.buildRegister());
    this.setState(this.state);   // repaint the panel marker
  }

  sendSync() {
    const video = this.videoEl;
    if (!video) return;
    const frame: WireFrame = {
      type: 'sync', source_id: this.sourceId, video_id: this.videoId,
      video_time_ms: Math.round(video.currentTime * 1000),
      playing: !video.paused && !video.ended,
      playback_rate: video.playbackRate || 1,
      timestamp: Date.now()
    };
    // duration_ms only when metadata is loaded (#219): before that duration
    // is NaN, and the desktop reads an absent key as null.
    if (typeof video.duration === 'number' && Number.isFinite(video.duration)) {
      frame.duration_ms = Math.round(video.duration * 1000);
    }
    this.cacheAndSend('sync', frame);
  }

  // ---- desktop->userscript commands (#219) --------------------------------
  // The desktop drives playback through four frame types: play/pause
  // (explicit states, issue #215 decision B), seek (relative delta_ms) and
  // mute (explicit state). Enforcement mirrors the desktop routing
  // contract: whitelist first, then the source_id check (a stale SPA source
  // must not act on mail addressed to its predecessor), then a bound video.
  // Everything else is dropped silently - the desktop owns routing, the
  // script owns execution. Playback state resyncs through the existing
  // play/pause/seeked listeners installed by bindVideo; mute needs no
  // report-back (the desktop does not track mute state).
  onCommand(raw: unknown) {
    let msg: WireFrame;
    try { msg = JSON.parse(String(raw)); }
    catch (error) { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.source_id !== this.sourceId) return;
    const video = this.videoEl;
    if (!video) return;
    switch (msg.type) {
      case 'play':
        video.play().catch(function () { /* autoplay policy may refuse; the play event reports what really happened */ });
        break;
      case 'pause':
        video.pause();
        break;
      case 'seek': {
        const delta = msg.delta_ms;
        if (typeof delta !== 'number' || !Number.isFinite(delta)) return;
        const dur = (typeof video.duration === 'number' && Number.isFinite(video.duration))
          ? video.duration : Number.POSITIVE_INFINITY;
        const target = Math.min(Math.max(video.currentTime + delta / 1000, 0), dur);
        try { video.currentTime = target; }
        catch (error) { /* seeking before metadata is loaded can throw in some engines */ }
        break;
      }
      case 'mute':
        if (typeof msg.muted !== 'boolean') return;
        video.muted = msg.muted;
        break;
      default:
        return; // outside the whitelist: noise, ignore
    }
  }

  onTimedtextFailure(url: string, reason: unknown) {
    if (!isTimedtextUrl(url)) return;
    const message = String(reason || 'caption response was unusable');
    if (message === this.captureError) return;
    this.captureError = message;
    console.warn('[youtubesub] caption capture failed:', message);
    this.send(this.buildRegister());
    this.setState(this.state);
  }

  onTimedtext(url: string, data: any) {
    if (!isTimedtextUrl(url)) return;
    this.captureError = '';
    const cues = parseJson3(data, url);
    if (!cues.length) return;
    const track = {
      key: normKey(url), signature: cuesSignature(cues),
      kind: trackKindFromUrl(url), lang: trackLangFromUrl(url)
    };
    if (track.key === this.trackKey && track.signature === this.cueSig &&
        track.kind === this.trackKind && track.lang === this.trackLang) return;
    this.trackKey = track.key;
    this.cueSig = track.signature;
    this.trackKind = track.kind;
    this.trackLang = track.lang;
    this.cueCount = cues.length;
    this.send(this.buildRegister());
    this.cacheAndSend('cues', Object.assign({
      type: 'cues', provider: 'youtube', source_id: this.sourceId,
      video_id: this.videoId,
      track_kind: this.trackKind, track_lang: this.trackLang, cues: cues
    }, videoMetadata()));
  }

  bindVideo(video: HTMLVideoElement) {
    this.videoEl = video;
    ['timeupdate', 'play', 'pause', 'seeked', 'ratechange'].forEach((event) => {
      video.addEventListener(event, () => { this.sendSync(); });
    });
    this.sendSync();
  }

  newSource() {
    if (this.cache.sync) this.send({ type: 'deactivate', source_id: this.sourceId });
    this.resetSource(videoIdFromLocation());
    this.send(this.buildRegister());
  }

  poll() {
    const video = document.querySelector('video');
    const videoId = videoIdFromLocation();
    if (videoId && videoId !== this.videoId) this.newSource();
    if (video && video !== this.videoEl) this.bindVideo(video);
  }

  // ---- status panel (minimal, mirrors dkitle's user-facing retry/stop) ----
  panelText(s: string): string {
    // A missing page hook outranks the connection state on purpose: "connected" is
    // true but useless, and the old marker ('connected [NO PAGE HOOK]') still read as
    // a working install. The failing level travels in the reason itself.
    if (this.hookError) {
      const max = 90;   // the panel is a one-line strip; the full reason stays in title
      const why = this.hookError.length > max
        ? this.hookError.slice(0, max - 3) + '...' : this.hookError;
      return 'youtubesub: NO PAGE HOOK - ' + why
        + (s && s !== 'connected' ? ' (' + s + ')' : '');
    }
    return 'youtubesub: ' + s
      + (this.captureError ? ' [NO CAPTION BODY]' : '');
  }

  setState(s: string) {
    this.state = s;
    if (!this.statusEl) return;
    this.statusEl.textContent = this.panelText(s);
    this.statusEl.title = (this.hookError ? this.hookError + '\n' : '')
      + 'Click: retry now. Double-click: stop.';
    this.statusEl.style.color = this.hookError ? '#f88'
      : (s === 'connected' ? '#8f8' : (s === 'stopped' ? '#f88' : '#fd8'));
  }

  mountPanel() {
    if (this.statusEl || !document.body) return;
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:11px Consolas,monospace;'
      + 'background:rgba(0,0,0,.6);color:#fd8;padding:3px 6px;border-radius:4px;pointer-events:auto;';
    el.textContent = this.panelText(this.state);
    el.title = 'Click: retry now. Double-click: stop.';
    el.addEventListener('click', () => { this.retryNow(); });
    el.addEventListener('dblclick', () => { this.stop(); });
    document.body.appendChild(el);
    this.statusEl = el;
  }
}

function videoIdFromLocation(): string {
  const m = /[?&]v=([\w-]{6,})/.exec(location.search);
  return m ? m[1] : '';
}

const bridge = new Bridge();

function onTimedtextEvent(ev: Event) {
  try {
    const d = ((ev as CustomEvent).detail) || {};
    if (d.error) bridge.onTimedtextFailure(d.url, d.error);
    else bridge.onTimedtext(d.url, d.data);
  } catch (e) {
    console.warn('[youtubesub] cue handling failed', e);
  }
}

function afterDomReady() {
  bridge.videoId = videoIdFromLocation();
  bridge.mountPanel();
  bridge.connect();
  setInterval(function () { bridge.poll(); }, CFG.videoPollMs);
  bridge.poll();
}

function boot() {
  // @run-at document-start is a promise the old code broke: it waited for
  // DOMContentLoaded, so a caption request emitted before that was invisible to the
  // hook. The event channel and the hook itself are DOM-independent and go in
  // first; only the panel, the player binding and the connection wait for the DOM.
  window.addEventListener('youtubesub-timedtext', onTimedtextEvent);
  window.addEventListener('youtubesub-hook-ready', onHookReadyEvent);
  injectPageHooks(function (err) {
    // A hook that cannot install means the script will never see a single cue;
    // recording why (and which level failed) is the difference between a
    // diagnosable run and a mystery.
    bridge.setHookError(err || '');
    if (err) {
      // A receipt may still arrive after the deadline: then the injection was slow,
      // not missing, and the panel must stop claiming the hook is absent.
      _hookReceipt.onLateConfirmed = function () { bridge.setHookError(''); };
    }
  });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', afterDomReady);
  } else {
    afterDomReady();
  }
}

boot();

window.addEventListener('beforeunload', function () {
  // unreliable by nature; the desktop side also re-activates a source when cues arrive
  bridge.send({ type: 'deactivate', source_id: bridge.sourceId });
});

// ---- test surface (used by userscript/tests/userscript.test.ts) ----
window.__youtubesub = {
  parseJson3: parseJson3,
  cuesSignature: cuesSignature,
  normKey: normKey,
  trackKindFromUrl: trackKindFromUrl,
  trackLangFromUrl: trackLangFromUrl,
  isTimedtextUrl: isTimedtextUrl,
  videoIdFromLocation: videoIdFromLocation,
  buildPageHookCode: buildPageHookCode,
  Bridge: Bridge,
  cfg: CFG,
  instance: bridge
};
