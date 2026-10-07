// ==UserScript==
// @name         youtubesub - YouTube subtitle bridge
// @namespace    https://github.com/local/youtubesub
// @version      0.1.1
// @description  Streams YouTube subtitle cues + player state to the local desktop overlay (127.0.0.1:9877).
// @match        *://*.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addElement
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// @license      MIT
// ==/UserScript==
//
// Page-context interception adapted from dkitle dkitle.user.js:388-460 (MIT, (c) ywxt),
// reworked for this project: SPA navigation creates a new source (dkitle defect fixed),
// replayed sync keeps its original timestamp (dkitle reconnect-jump defect fixed).
// Cue decoding mirrors yt-dual-subs parseJson3 (MIT, (c) 2026 Gythiro).

(function () {
  'use strict';

  var DEFAULTS = {
    host: '127.0.0.1',
    port: 9877,
    reconnectBaseMs: 3000,
    reconnectMaxMs: 30000,
    videoPollMs: 1500,
    hookReceiptMs: 500
  };

  var CFG = Object.assign({}, DEFAULTS);

  // ---- pure helpers (unit-tested in node, see tests/userscript.test.mjs) ----
  function normKey(url) {
    // pot/fmt/tlang rotate per request and must not look like a new track
    try {
      var u = new URL(url, location.href);
      ['fmt', 'tlang', 'pot', 'potc', 'c', 'expire', 'ip', 'signature', 'sig', 'lsig', 'n'].forEach(function (k) {
        u.searchParams.delete(k);
      });
      return u.origin + u.pathname + '?' + u.searchParams.toString();
    } catch (e) {
      return String(url || '');
    }
  }

  function trackKindFromUrl(url) {
    var s = String(url || '');
    if (/[?&]kind=asr/.test(s)) return 'asr';
    if (/[?&]tlang=/.test(s)) return 'tlang';
    return 'manual';
  }

  function trackLangFromUrl(url) {
    var s = String(url || '');
    // tlang wins when present: the returned cue text is the translation, so
    // reporting the source lang would mislabel the track metadata.
    var m = /[?&]tlang=([^&]+)/.exec(s) || /[?&]lang=([^&]+)/.exec(s);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function isTimedtextUrl(url) {
    return /timedtext|srv3|json3/i.test(String(url || '')) && String(url || '').indexOf('youtube') !== -1;
  }

  function parseJson3(json, url) {
    // mirrors desktop suboverlay/protocol.py parse_json3 (yt-dual-subs semantics, MIT)
    var cues = [];
    if (!json || !Array.isArray(json.events)) return cues;
    for (var i = 0; i < json.events.length; i++) {
      var ev = json.events[i];
      if (!ev || !Array.isArray(ev.segs)) continue;
      var parts = [], off = 0, hasOff = false;
      for (var s = 0; s < ev.segs.length; s++) {
        var seg = ev.segs[s];
        if (!seg || typeof seg.utf8 !== 'string') continue;
        // Seg separator aligned with the desktop parser (#26): space-join, then
        // collapse - a seg without a trailing space must not glue the next word
        // onto it (word/char counts feed the segmentation criteria).
        parts.push(seg.utf8);
        if (seg.utf8.trim() && typeof seg.tOffsetMs === 'number') { off = seg.tOffsetMs; hasOff = true; }
      }
      var text = parts.join(' ').replace(/\s+/g, ' ').trim().replace(/(^|\s)>{2,}\s*/g, '$1').trim();
      if (!text) continue;
      var start = typeof ev.tStartMs === 'number' ? ev.tStartMs : 0;
      var dur = typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 0;
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

  function cuesSignature(cues) {
    // Content fingerprint used to dedup re-intercepted tracks. Cue COUNT alone is
    // not enough: a switched track (e.g. tlang rotation) can carry the same number
    // of cues with different text, and count-only dedup silently dropped it.
    var n = cues.length;
    if (!n) return '0:';
    var chars = 0;
    for (var i = 0; i < n; i++) chars += cues[i].text.length;
    return [n, chars, cues[0].start_ms, cues[n - 1].end_ms,
            cues[0].text, cues[n - 1].text].join(':');
  }

  function videoMetadata() {
    var title = String(document.title || '').replace(/\s+- YouTube\s*$/i, '').trim();
    var metadata = { tab_title: title };
    var description = document.querySelector('meta[name="description"]');
    var content = description && typeof description.content === 'string'
      ? description.content.trim() : '';
    if (content) metadata.video_description = content;
    return metadata;
  }

  // This function is serialized into the page's main world. Keep it self-contained:
  // the page's own request already has the credentials needed for timedtext.
  // The receipt (issue #41) rides along: the injected code reports WHICH level ran
  // and which entry points it really wrapped, because "the injector did not throw"
  // is not evidence that a hook exists - a message from this realm is.
  function pageHook(LEVEL) {
    var entries = [];
    function isCaption(url) {
      var s = String(url || '');
      return /timedtext|srv3|json3/i.test(s) && s.indexOf('youtube') !== -1;
    }

    function report(url, data, error) {
      window.dispatchEvent(new CustomEvent('youtubesub-timedtext', {
        detail: { url: url, data: data, error: error }
      }));
    }

    function deliver(url, body, status) {
      if (!body) {
        report(url, null, 'caption response was empty (status ' + status + ')');
        return;
      }
      try {
        report(url, JSON.parse(body), '');
      } catch (e) {
        report(url, null, 'caption response was not JSON (status ' + status + ')');
      }
    }

    function unreadable(url, error) {
      report(url, null, 'caption response could not be read: ' + error);
    }

    var originalFetch = window.fetch;
    if (originalFetch) {
      window.fetch = function () {
        var input = arguments[0];
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var response = originalFetch.apply(this, arguments);
        if (isCaption(url)) {
          response.then(function (result) {
            try {
              result.clone().text().then(
                function (body) { deliver(url, body, result.status); },
                function (error) { unreadable(url, error); }
              );
            } catch (error) { unreadable(url, error); }
          });
        }
        return response;
      };
      entries.push('fetch');
    }

    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__ytusUrl = url;
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      var url = xhr.__ytusUrl;
      if (isCaption(url)) {
        xhr.addEventListener('load', function () {
          try { deliver(xhr.__ytusUrl, xhr.responseText, xhr.status); }
          catch (error) { unreadable(xhr.__ytusUrl, error); }
        });
      }
      return originalSend.apply(this, arguments);
    };
    entries.push('xhr');

    // The receipt: it names the injection level and which entry points were really
    // wrapped in THIS realm. Only a receipt with at least one entry counts outside.
    if (window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('youtubesub-hook-ready', { detail: { level: LEVEL, entries: entries } }));
    }
  }

  function buildPageHookCode(level) {
    return '(' + pageHook.toString() + ')(' + JSON.stringify(String(level || '')) + ');';
  }

  var _ttPolicy = null;
  var _ttPolicyFailed = false;
  var _ttNotice = '';

  function trustedScript(code) {
    // A page with require-trusted-types-for 'script' refuses a plain string
    // assignment to script.textContent - this is what silently killed the hook on
    // youtube.com. A policy created by this frame is the sanctioned way through,
    // and it only works when the page's CSP allows the policy name.
    if (_ttPolicyFailed) return null;
    try {
      var tt = window.trustedTypes;
      if (!tt || typeof tt.createPolicy !== 'function') {
        _ttPolicyFailed = true;
        _ttNotice = 'Trusted Types unavailable';
        return null;
      }
      if (!_ttPolicy) {
        _ttPolicy = tt.createPolicy('youtubesub', { createScript: function (s) { return s; } });
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
  var _hookReceipt = {
    onConfirmed: null,      // resolves the level being awaited with '' when it answers
    onLateConfirmed: null,  // resolves a receipt that arrives after every level timed out
    timer: null,
    emptyLevels: []         // levels that ran somewhere but hooked no entry point
  };

  function onHookReadyEvent(ev) {
    var d = (ev && ev.detail) || {};
    var entries = Array.isArray(d.entries) ? d.entries : [];
    var level = String(d.level || '?');
    if (!entries.length) {
      // The code ran, but wrapped neither fetch nor XMLHttpRequest: that is not an
      // installation, even though it executed.
      if (_hookReceipt.emptyLevels.indexOf(level) < 0) _hookReceipt.emptyLevels.push(level);
      return;
    }
    var confirmed = _hookReceipt.onConfirmed;
    _hookReceipt.onConfirmed = null;
    if (confirmed) { confirmed(''); return; }
    if (_hookReceipt.onLateConfirmed) {
      // Every level already timed out and the failure was reported: the page code
      // was merely slow. Repair the state instead of keeping a lie on screen.
      var late = _hookReceipt.onLateConfirmed;
      _hookReceipt.onLateConfirmed = null;
      late('');
    }
  }

  function injectPageHooks(onDone) {
    // onDone(errorString): '' only when some level was CONFIRMED by a page receipt.
    // Each level is tried in turn and gets hookReceiptMs to answer; a level that
    // cannot answer is judged failed and the reason names it, so a failed install
    // says WHICH level failed instead of only "it did not work".
    var ways = [];
    // 1) Tampermonkey's GM_addElement injects from the extension context, so it
    //    bypasses page CSP and Trusted Types. This is the production path.
    ways.push({ id: 'gm', run: function (code) {
      if (typeof GM_addElement !== 'function') return 'gm: GM_addElement not granted';
      GM_addElement('script', { textContent: code });
      return '';
    } });
    // 2) Page-context injection through a script element, Trusted Types aware.
    ways.push({ id: 'script-element', run: function (code) {
      var el = document.createElement('script');
      var trusted = trustedScript(code);
      el.textContent = trusted || code;
      (document.head || document.documentElement).appendChild(el);
      el.remove();
      return '';
    } });
    // 3) Direct evaluation: immune to Trusted Types and correct whenever this
    //    script already runs in the page's main world (document-start injection by
    //    a harness, or @sandbox none). Inside a userscript sandbox it would install
    //    the hook in the wrong realm, which is worse than failing loudly - so it is
    //    skipped there.
    var sandboxed = (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window);
    if (sandboxed) {
      ways.push({ id: 'sandboxed', run: function () {
        return 'sandboxed: no page-context injection path left';
      } });
    } else {
      ways.push({ id: 'direct-eval', run: function (code) {
        (new Function(code))();
        return '';
      } });
    }

    var reasons = [];
    var settled = false;
    var next = 0;

    function finish(err) {
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
      var way = ways[next++];
      var why = '';
      // Trusted Types is a per-level verdict: reset it so only the level that really
      // hit it carries the note (a direct-eval timeout must not inherit it).
      _ttNotice = '';
      _hookReceipt.onConfirmed = function () { finish(''); };
      try {
        why = way.run(buildPageHookCode(way.id)) || '';
      } catch (e) {
        why = way.id + ': ' + e;
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
        var empty = _hookReceipt.emptyLevels.indexOf(way.id) >= 0;
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

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'ytus-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  class Bridge {
    constructor() {
      this.ws = null;
      this.state = 'idle';
      this.attempts = 0;
      this.stopped = false;
      this.videoEl = null;
      this.statusEl = null;
      this.hookError = '';
      this.resetSource('');
    }

    resetSource(videoId) {
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

    health(done) {
      if (typeof GM_xmlhttpRequest !== 'function') { done(true); return; }
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'http://' + CFG.host + ':' + CFG.port + '/health',
        timeout: 2000,
        onload: function (response) { done(response.status >= 200 && response.status < 300); },
        onerror: function () { done(false); },
        ontimeout: function () { done(false); }
      });
    }

    send(frame) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      try { this.ws.send(JSON.stringify(frame)); return true; }
      catch (error) { return false; }
    }

    cacheAndSend(kind, frame) {
      this.cache[kind] = frame;
      return this.send(frame);
    }

    connect() {
      if (this.stopped) return;
      this.setState('probing');
      this.health((healthy) => {
        if (this.stopped) return;
        if (healthy) this.openSocket();
        else this.scheduleReconnect();
      });
    }

    openSocket() {
      this.setState('connecting');
      try { this.ws = new WebSocket('ws://' + CFG.host + ':' + CFG.port + '/ws'); }
      catch (error) { this.scheduleReconnect(); return; }
      this.ws.onopen = () => {
        this.attempts = 0;
        this.setState('connected');
        this.replay();
      };
      this.ws.onclose = () => {
        this.setState('closed');
        this.scheduleReconnect();
      };
      this.ws.onerror = () => { this.setState('error'); };
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

    buildRegister() {
      return Object.assign({
        type: 'register', provider: 'youtube', source_id: this.sourceId,
        video_id: this.videoId,
        track_kind: this.trackKind, track_lang: this.trackLang,
        hook_error: this.hookError, capture_error: this.captureError
      }, videoMetadata());
    }

    setHookError(msg) {
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
      this.cacheAndSend('sync', {
        type: 'sync', source_id: this.sourceId, video_id: this.videoId,
        video_time_ms: Math.round(video.currentTime * 1000),
        playing: !video.paused && !video.ended,
        playback_rate: video.playbackRate || 1,
        timestamp: Date.now()
      });
    }

    onTimedtextFailure(url, reason) {
      if (!isTimedtextUrl(url)) return;
      const message = String(reason || 'caption response was unusable');
      if (message === this.captureError) return;
      this.captureError = message;
      console.warn('[youtubesub] caption capture failed:', message);
      this.send(this.buildRegister());
      this.setState(this.state);
    }

    onTimedtext(url, data) {
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

    bindVideo(video) {
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
  }

  function videoIdFromLocation() {
    var m = /[?&]v=([\w-]{6,})/.exec(location.search);
    return m ? m[1] : '';
  }

  // ---- status panel (minimal, mirrors dkitle's user-facing retry/stop) ----
  Bridge.prototype.panelText = function (s) {
    // A missing page hook outranks the connection state on purpose: "connected" is
    // true but useless, and the old marker ('connected [NO PAGE HOOK]') still read as
    // a working install. The failing level travels in the reason itself.
    if (this.hookError) {
      var max = 90;   // the panel is a one-line strip; the full reason stays in title
      var why = this.hookError.length > max
        ? this.hookError.slice(0, max - 3) + '...' : this.hookError;
      return 'youtubesub: NO PAGE HOOK - ' + why
        + (s && s !== 'connected' ? ' (' + s + ')' : '');
    }
    return 'youtubesub: ' + s
      + (this.captureError ? ' [NO CAPTION BODY]' : '');
  };

  Bridge.prototype.setState = function (s) {
    this.state = s;
    if (!this.statusEl) return;
    this.statusEl.textContent = this.panelText(s);
    this.statusEl.title = (this.hookError ? this.hookError + '\n' : '')
      + 'Click: retry now. Double-click: stop.';
    this.statusEl.style.color = this.hookError ? '#f88'
      : (s === 'connected' ? '#8f8' : (s === 'stopped' ? '#f88' : '#fd8'));
  };

  Bridge.prototype.mountPanel = function () {
    if (this.statusEl || !document.body) return;
    var self = this;
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:11px Consolas,monospace;'
      + 'background:rgba(0,0,0,.6);color:#fd8;padding:3px 6px;border-radius:4px;pointer-events:auto;';
    el.textContent = this.panelText(this.state);
    el.title = 'Click: retry now. Double-click: stop.';
    el.addEventListener('click', function () { self.retryNow(); });
    el.addEventListener('dblclick', function () { self.stop(); });
    document.body.appendChild(el);
    this.statusEl = el;
  };

  var bridge = new Bridge();

  function onTimedtextEvent(ev) {
    try {
      var d = ev.detail || {};
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

  // ---- test surface (used by userscript/tests/userscript.test.mjs) ----
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

})();
