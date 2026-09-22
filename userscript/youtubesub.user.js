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
    videoPollMs: 1500,
    // How long one injection level gets to report back from the page world before
    // it is judged failed and the next level is tried (issue #41).
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

  function buildPageHookCode(level) {
    // Page context is required: the player's timedtext request carries a pot token we
    // cannot mint; reusing that exact request is the only reliable way (yt-dual-subs).
    // The generated code signs off with a receipt (issue #41): "the injector call did
    // not throw" is not evidence that the hook exists, but a message from this realm is.
    var testSrc = isTimedtextUrl.toString();
    var levelSrc = JSON.stringify(String(level || ''));
    var code = [
      '(function () {',
      '  var test = ' + testSrc + ';',
      '  var LEVEL = ' + levelSrc + ';',
      '  var entries = [];',
      '  function emit(url, data) {',
      "    window.dispatchEvent(new CustomEvent('youtubesub-timedtext', { detail: { url: url, data: data, error: '' } }));",
      '  }',
      '  function emitFailure(url, why) {',
      "    window.dispatchEvent(new CustomEvent('youtubesub-timedtext', { detail: { url: url, data: null, error: why } }));",
      '  }',
      '  // A response that arrived but cannot be used is REPORTABLE: 200 with an empty',
      '  // body (what youtube.com returns to a headless Chrome) used to be swallowed by',
      '  // a bare catch, leaving the panel on "connected" with nothing to show.',
      '  function deliver(url, body, status) {',
      '    if (!body) { emitFailure(url, "caption response was empty (status " + status + ")"); return; }',
      '    try { emit(url, JSON.parse(body)); }',
      '    catch (e) { emitFailure(url, "caption response was not JSON (status " + status + ")"); }',
      '  }',
      '  var of = window.fetch;',
      '  if (of) {',
      '    window.fetch = function () {',
      '      var args = arguments;',
      '      var url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url ? args[0].url : "");',
      '      var p = of.apply(this, args);',
      '      if (test(url)) {',
      '        p.then(function (res) {',
      '          try {',
      '            res.clone().text().then(function (t) { deliver(url, t, res.status); },',
      '              function (e) { emitFailure(url, "caption response could not be read: " + e); });',
      '          } catch (e) { emitFailure(url, "caption response could not be read: " + e); }',
      '        });',
      '      }',
      '      return p;',
      '    };',
      "    entries.push('fetch');",
      '  }',
      '  if (typeof XMLHttpRequest !== "undefined" && XMLHttpRequest.prototype) {',
      '    var oo = XMLHttpRequest.prototype.open;',
      '    var os = XMLHttpRequest.prototype.send;',
      '    XMLHttpRequest.prototype.open = function (m, u) { this.__ytusUrl = u; return oo.apply(this, arguments); };',
      '    XMLHttpRequest.prototype.send = function () {',
      '      var xhr = this;',
      '      if (test(xhr.__ytusUrl)) {',
      "        xhr.addEventListener('load', function () {",
      '          try { deliver(xhr.__ytusUrl, xhr.responseText, xhr.status); }',
      '          catch (e) { emitFailure(xhr.__ytusUrl, "caption response could not be read: " + e); }',
      '        });',
      '      }',
      '      return os.apply(this, arguments);',
      '    };',
      "    entries.push('xhr');",
      '  }',
      '  // The receipt: it names the injection level and which entry points were really',
      '  // wrapped in THIS realm. Only a receipt with at least one entry counts outside.',
      '  if (window.dispatchEvent) {',
      "    window.dispatchEvent(new CustomEvent('youtubesub-hook-ready', { detail: { level: LEVEL, entries: entries } }));",
      '  }',
      '})();'
    ].join('\n');
    return code;
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

  function Bridge() {
    this.ws = null;
    this.state = 'idle';
    this.attempts = 0;
    this.stopped = false;
    this.sourceId = uuid();
    this.videoId = '';
    this.videoEl = null;
    this.trackKey = '';
    this.cueSig = '';
    this.cueCount = -1;
    this.cache = { register: null, cues: null, sync: null };
    this.statusEl = null;
    this.hookError = '';    // set by boot() when the page hook could not install
    this.captureError = ''; // set when a caption response carried no usable body
  }

  Bridge.prototype.health = function (cb) {
    var url = 'http://' + CFG.host + ':' + CFG.port + '/health';
    // Without GM_xmlhttpRequest (script injected outside Tampermonkey, or the
    // grant was stripped) we cannot probe /health at all. Attempting the socket
    // is the only liveness test left, so fall through instead of never connecting.
    if (typeof GM_xmlhttpRequest !== 'function') { cb(true); return; }
    GM_xmlhttpRequest({
      method: 'GET',
      url: url,
      timeout: 2000,
      onload: function (r) { cb(r.status >= 200 && r.status < 300); },
      onerror: function () { cb(false); },
      ontimeout: function () { cb(false); }
    });
  };

  Bridge.prototype.send = function (obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }
    return false;
  };

  Bridge.prototype.cacheAndSend = function (slot, obj) {
    this.cache[slot] = obj;
    return this.send(obj);
  };

  Bridge.prototype.republishRegister = function () {
    // hook_error and capture_error only travel inside the register frame (register is
    // idempotent: meta + active_source). A verdict that changes after the socket is
    // already open must therefore re-send it, or the desktop keeps the stale fact.
    this.send(this.buildRegister());
    this.setState(this.state);   // repaint the panel marker
  };

  Bridge.prototype.setHookError = function (msg) {
    msg = msg || '';
    if (msg === this.hookError) return;
    this.hookError = msg;
    if (msg) console.warn('[youtubesub] page hook not installed:', msg);
    this.republishRegister();
  };

  Bridge.prototype.connect = function () {
    var self = this;
    if (this.stopped) return;
    this.setState('probing');
    this.health(function (ok) {
      if (self.stopped) return;
      if (!ok) { self.scheduleReconnect(); return; }
      self.openSocket();
    });
  };

  Bridge.prototype.openSocket = function () {
    var self = this;
    this.setState('connecting');
    var ws;
    try {
      ws = new WebSocket('ws://' + CFG.host + ':' + CFG.port + '/ws');
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = function () {
      self.attempts = 0;
      self.setState('connected');
      if (self.cache.register) self.send(self.cache.register);
      else self.send(self.buildRegister());
      if (self.cache.cues) self.send(self.cache.cues);
      // replay sync WITHOUT refreshing timestamp: refreshing it makes the desktop
      // overlay jump backwards on every reconnect (dkitle defect #2).
      if (self.cache.sync) self.send(self.cache.sync);
      else self.sendSync();
    };
    ws.onclose = function () { self.setState('closed'); self.scheduleReconnect(); };
    ws.onerror = function () { self.setState('error'); };
  };

  Bridge.prototype.scheduleReconnect = function () {
    var self = this;
    if (this.stopped) return;
    var delay = Math.min(CFG.reconnectBaseMs * Math.pow(2, this.attempts), CFG.reconnectMaxMs);
    this.attempts += 1;
    this.setState('retry in ' + Math.round(delay / 1000) + 's');
    setTimeout(function () { self.connect(); }, delay);
  };

  Bridge.prototype.retryNow = function () {
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  };

  Bridge.prototype.stop = function () {
    this.stopped = true;
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
    this.setState('stopped');
  };

  Bridge.prototype.buildRegister = function () {
    return {
      type: 'register', provider: 'youtube', source_id: this.sourceId,
      tab_title: document.title || '', video_id: this.videoId,
      track_kind: this.trackKind || '', track_lang: this.trackLang || '',
      hook_error: this.hookError || '',
      capture_error: this.captureError || ''
    };
  };

  Bridge.prototype.sendSync = function () {
    var v = this.videoEl;
    if (!v) return;
    this.cacheAndSend('sync', {
      type: 'sync', source_id: this.sourceId, video_id: this.videoId,
      video_time_ms: Math.round(v.currentTime * 1000),
      playing: !v.paused && !v.ended,
      playback_rate: v.playbackRate || 1,
      timestamp: Date.now()
    });
  };

  Bridge.prototype.onTimedtextFailure = function (url, why) {
    // The hook ran and saw a caption request, but the response carried no usable
    // body. Staying silent here is what made "connected, never a subtitle"
    // undiagnosable, so the reason travels to the desktop on the next register frame.
    if (!isTimedtextUrl(url)) return;
    var msg = String(why || 'caption response was unusable');
    if (msg === this.captureError) return;   // one report per distinct reason
    this.captureError = msg;
    console.warn('[youtubesub] caption capture failed:', msg);
    this.republishRegister();
  };

  Bridge.prototype.onTimedtext = function (url, data) {
    if (!isTimedtextUrl(url)) return;
    // A usable payload proves the capture path works again: drop the stale reason.
    this.captureError = '';
    var key = normKey(url);
    var cues = parseJson3(data, url);
    if (!cues.length) return;
    var sig = cuesSignature(cues);
    var kind = trackKindFromUrl(url);
    var lang = trackLangFromUrl(url);
    // A rotating pot/fmt yields the same normKey AND the same content signature:
    // that is the only case worth skipping. Track kind/language are part of the
    // key so the desktop metadata stays truthful.
    if (key === this.trackKey && sig === this.cueSig &&
        kind === this.trackKind && lang === this.trackLang) return;
    this.trackKey = key;
    this.cueSig = sig;
    this.cueCount = cues.length;
    this.trackKind = kind;
    this.trackLang = lang;
    this.send(this.buildRegister());
    this.cacheAndSend('cues', {
      type: 'cues', provider: 'youtube', source_id: this.sourceId,
      tab_title: document.title || '', video_id: this.videoId,
      track_kind: this.trackKind, track_lang: this.trackLang, cues: cues
    });
  };

  Bridge.prototype.bindVideo = function (video) {
    var self = this;
    this.videoEl = video;
    ['timeupdate', 'play', 'pause', 'seeked', 'ratechange'].forEach(function (ev) {
      video.addEventListener(ev, function () { self.sendSync(); });
    });
    this.sendSync();
  };

  Bridge.prototype.newSource = function () {
    // SPA navigation: a different video must be a NEW source, otherwise stale cues
    // from the previous video survive (dkitle defect).
    if (this.cache.sync) this.send({ type: 'deactivate', source_id: this.sourceId });
    this.sourceId = uuid();
    this.videoId = videoIdFromLocation();
    this.captureError = '';
    this.trackKey = '';
    this.cueSig = '';
    this.cueCount = -1;
    this.cache = { register: null, cues: null, sync: null };
    this.send(this.buildRegister());
  };

  Bridge.prototype.poll = function () {
    var video = document.querySelector('video');
    var vid = videoIdFromLocation();
    if (vid && vid !== this.videoId) { this.videoId = vid; this.newSource(); }
    if (video && video !== this.videoEl) this.bindVideo(video);
  };

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
