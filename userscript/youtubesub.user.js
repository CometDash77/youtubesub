// ==UserScript==
// @name         youtubesub - YouTube subtitle bridge
// @namespace    https://github.com/local/youtubesub
// @version      0.1.0
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
    videoPollMs: 1500
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

  // This function is serialized into the page's main world. Keep it self-contained:
  // the page's own request already has the credentials needed for timedtext.
  function pageHook() {
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
  }

  function buildPageHookCode() {
    return '(' + pageHook.toString() + ')();';
  }

  var _ttPolicy = null;
  var _ttPolicyFailed = false;

  function trustedScript(code) {
    // A page with require-trusted-types-for 'script' refuses a plain string
    // assignment to script.textContent - this is what silently killed the hook on
    // youtube.com. A policy created by this frame is the sanctioned way through,
    // and it only works when the page's CSP allows the policy name.
    if (_ttPolicyFailed) return null;
    try {
      var tt = window.trustedTypes;
      if (!tt || typeof tt.createPolicy !== 'function') { _ttPolicyFailed = true; return null; }
      if (!_ttPolicy) {
        _ttPolicy = tt.createPolicy('youtubesub', { createScript: function (s) { return s; } });
      }
      return _ttPolicy.createScript(code);
    } catch (e) {
      _ttPolicyFailed = true;
      return null;
    }
  }

  function injectPageHooks() {
    // Returns an error string when the page hook could NOT be installed, so the
    // bridge can report it instead of showing "connected" with nothing to show.
    var code = buildPageHookCode();
    var errors = [];
    // 1) Tampermonkey's GM_addElement injects from the extension context, so it
    //    bypasses page CSP and Trusted Types. This is the production path.
    if (typeof GM_addElement === 'function') {
      try {
        GM_addElement('script', { textContent: code });
        return '';
      } catch (e) {
        errors.push('GM_addElement: ' + e);
      }
    }
    // 2) Page-context injection through a script element, Trusted Types aware.
    try {
      var el = document.createElement('script');
      var trusted = trustedScript(code);
      el.textContent = trusted || code;
      (document.head || document.documentElement).appendChild(el);
      el.remove();
      return '';
    } catch (e) {
      errors.push('script element: ' + e);
    }
    // 3) Direct evaluation: immune to Trusted Types and correct whenever this
    //    script already runs in the page's main world (document-start injection by
    //    a harness, or @sandbox none). Inside a userscript sandbox it would install
    //    the hook in the wrong realm, which is worse than failing loudly - so it is
    //    skipped there.
    var sandboxed = (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window);
    if (sandboxed) {
      errors.push('sandboxed: no page-context injection path left');
    } else {
      try {
        (new Function(code))();
        return '';
      } catch (e) {
        errors.push('direct eval: ' + e);
      }
    }
    return errors.join(' | ');
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
      return {
        type: 'register', provider: 'youtube', source_id: this.sourceId,
        tab_title: document.title || '', video_id: this.videoId,
        track_kind: this.trackKind, track_lang: this.trackLang,
        hook_error: this.hookError, capture_error: this.captureError
      };
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
      this.cacheAndSend('cues', {
        type: 'cues', provider: 'youtube', source_id: this.sourceId,
        tab_title: document.title || '', video_id: this.videoId,
        track_kind: this.trackKind, track_lang: this.trackLang, cues: cues
      });
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
    return 'youtubesub: ' + s
      + (this.hookError ? ' [NO PAGE HOOK]'
        : (this.captureError ? ' [NO CAPTION BODY]' : ''));
  };

  Bridge.prototype.setState = function (s) {
    this.state = s;
    if (!this.statusEl) return;
    this.statusEl.textContent = this.panelText(s);
    this.statusEl.style.color = s === 'connected' ? '#8f8' : (s === 'stopped' ? '#f88' : '#fd8');
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

  function boot() {
    // A hook that cannot install means the script will never see a single cue;
    // recording why is the difference between a diagnosable run and a mystery.
    var hookError = injectPageHooks();
    bridge.hookError = hookError || '';
    if (hookError) console.warn('[youtubesub] page hook injection failed:', hookError);
    window.addEventListener('youtubesub-timedtext', function (ev) {
      try {
        var d = ev.detail || {};
        if (d.error) bridge.onTimedtextFailure(d.url, d.error);
        else bridge.onTimedtext(d.url, d.data);
      } catch (e) {
        console.warn('[youtubesub] cue handling failed', e);
      }
    });
    bridge.videoId = videoIdFromLocation();
    bridge.mountPanel();
    bridge.connect();
    setInterval(function () { bridge.poll(); }, CFG.videoPollMs);
    bridge.poll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

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
