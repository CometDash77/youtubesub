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
"use strict";
(() => {
  // src/youtubesub.ts
  var DEFAULTS = {
    host: "127.0.0.1",
    port: 9877,
    reconnectBaseMs: 3e3,
    reconnectMaxMs: 3e4,
    videoPollMs: 1500,
    hookReceiptMs: 500
  };
  var CFG = Object.assign({}, DEFAULTS);
  function normKey(url) {
    try {
      const u = new URL(url, location.href);
      ["fmt", "tlang", "pot", "potc", "c", "expire", "ip", "signature", "sig", "lsig", "n"].forEach(function(k) {
        u.searchParams.delete(k);
      });
      return u.origin + u.pathname + "?" + u.searchParams.toString();
    } catch (e) {
      return String(url || "");
    }
  }
  function trackKindFromUrl(url) {
    const s = String(url || "");
    if (/[?&]kind=asr/.test(s)) return "asr";
    if (/[?&]tlang=/.test(s)) return "tlang";
    return "manual";
  }
  function trackLangFromUrl(url) {
    const s = String(url || "");
    const m = /[?&]tlang=([^&]+)/.exec(s) || /[?&]lang=([^&]+)/.exec(s);
    return m ? decodeURIComponent(m[1]) : "";
  }
  function isTimedtextUrl(url) {
    return /timedtext|srv3|json3/i.test(String(url || "")) && String(url || "").indexOf("youtube") !== -1;
  }
  function parseJson3(json, url) {
    const cues = [];
    if (!json || !Array.isArray(json.events)) return cues;
    for (let i = 0; i < json.events.length; i++) {
      const ev = json.events[i];
      if (!ev || !Array.isArray(ev.segs)) continue;
      const parts = [];
      let off = 0, hasOff = false;
      for (let s = 0; s < ev.segs.length; s++) {
        const seg = ev.segs[s];
        if (!seg || typeof seg.utf8 !== "string") continue;
        parts.push(seg.utf8);
        if (seg.utf8.trim() && typeof seg.tOffsetMs === "number") {
          off = seg.tOffsetMs;
          hasOff = true;
        }
      }
      const text = parts.join(" ").replace(/\s+/g, " ").trim().replace(/(^|\s)>{2,}\s*/g, "$1").trim();
      if (!text) continue;
      const start = typeof ev.tStartMs === "number" ? ev.tStartMs : 0;
      const dur = typeof ev.dDurationMs === "number" ? ev.dDurationMs : 0;
      if (dur <= 0) continue;
      cues.push({
        start_ms: start,
        end_ms: start + dur,
        text,
        last_off_ms: hasOff ? start + off : start
      });
    }
    return cues;
  }
  function cuesSignature(cues) {
    const n = cues.length;
    if (!n) return "0:";
    let chars = 0;
    for (let i = 0; i < n; i++) chars += cues[i].text.length;
    return [
      n,
      chars,
      cues[0].start_ms,
      cues[n - 1].end_ms,
      cues[0].text,
      cues[n - 1].text
    ].join(":");
  }
  function videoMetadata() {
    const title = String(document.title || "").replace(/\s+- YouTube\s*$/i, "").trim();
    const metadata = { tab_title: title };
    const description = document.querySelector('meta[name="description"]');
    const content = description && typeof description.content === "string" ? description.content.trim() : "";
    if (content) metadata.video_description = content;
    return metadata;
  }
  function pageHook(LEVEL) {
    const entries = [];
    function isCaption(url) {
      const s = String(url || "");
      return /timedtext|srv3|json3/i.test(s) && s.indexOf("youtube") !== -1;
    }
    function report(url, data, error) {
      window.dispatchEvent(new CustomEvent("youtubesub-timedtext", {
        detail: { url, data, error }
      }));
    }
    function deliver(url, body, status) {
      if (!body) {
        report(url, null, "caption response was empty (status " + status + ")");
        return;
      }
      try {
        report(url, JSON.parse(body), "");
      } catch (e) {
        report(url, null, "caption response was not JSON (status " + status + ")");
      }
    }
    function unreadable(url, error) {
      report(url, null, "caption response could not be read: " + error);
    }
    const originalFetch = window.fetch;
    if (originalFetch) {
      window.fetch = function(...args) {
        const input = args[0];
        const url = typeof input === "string" ? input : input && input.url || "";
        const response = originalFetch.apply(this, args);
        if (isCaption(url)) {
          response.then(function(result) {
            try {
              result.clone().text().then(
                function(body) {
                  deliver(url, body, result.status);
                },
                function(error) {
                  unreadable(url, error);
                }
              );
            } catch (error) {
              unreadable(url, error);
            }
          });
        }
        return response;
      };
      entries.push("fetch");
    }
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__ytusUrl = url;
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      const xhr = this;
      const url = xhr.__ytusUrl;
      if (isCaption(url)) {
        xhr.addEventListener("load", function() {
          try {
            deliver(xhr.__ytusUrl, xhr.responseText, xhr.status);
          } catch (error) {
            unreadable(xhr.__ytusUrl, error);
          }
        });
      }
      return originalSend.apply(this, arguments);
    };
    entries.push("xhr");
    if (window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent("youtubesub-hook-ready", { detail: { level: LEVEL, entries } }));
    }
  }
  function buildPageHookCode(level) {
    return "(" + pageHook.toString() + ")(" + JSON.stringify(String(level || "")) + ");";
  }
  var _ttPolicy = null;
  var _ttPolicyFailed = false;
  var _ttNotice = "";
  function trustedScript(code) {
    if (_ttPolicyFailed) return null;
    try {
      const tt = window.trustedTypes;
      if (!tt || typeof tt.createPolicy !== "function") {
        _ttPolicyFailed = true;
        _ttNotice = "Trusted Types unavailable";
        return null;
      }
      if (!_ttPolicy) {
        _ttPolicy = tt.createPolicy("youtubesub", { createScript: function(s) {
          return s;
        } });
      }
      return _ttPolicy.createScript(code);
    } catch (e) {
      _ttPolicyFailed = true;
      _ttNotice = "Trusted Types policy rejected: " + e;
      return null;
    }
  }
  var _hookReceipt = {
    onConfirmed: null,
    // resolves the level being awaited with '' when it answers
    onLateConfirmed: null,
    // resolves a receipt that arrives after every level timed out
    timer: null,
    emptyLevels: []
    // levels that ran somewhere but hooked no entry point
  };
  function onHookReadyEvent(ev) {
    const d = ev.detail || {};
    const entries = Array.isArray(d.entries) ? d.entries : [];
    const level = String(d.level || "?");
    if (!entries.length) {
      if (_hookReceipt.emptyLevels.indexOf(level) < 0) _hookReceipt.emptyLevels.push(level);
      return;
    }
    const confirmed = _hookReceipt.onConfirmed;
    _hookReceipt.onConfirmed = null;
    if (confirmed) {
      confirmed("");
      return;
    }
    if (_hookReceipt.onLateConfirmed) {
      const late = _hookReceipt.onLateConfirmed;
      _hookReceipt.onLateConfirmed = null;
      late("");
    }
  }
  function injectPageHooks(onDone) {
    const ways = [];
    ways.push({ id: "gm", run: function(code) {
      if (typeof GM_addElement !== "function") return "gm: GM_addElement not granted";
      GM_addElement("script", { textContent: code });
      return "";
    } });
    ways.push({ id: "script-element", run: function(code) {
      const el = document.createElement("script");
      const trusted = trustedScript(code);
      el.textContent = trusted || code;
      (document.head || document.documentElement).appendChild(el);
      el.remove();
      return "";
    } });
    const sandboxed = typeof unsafeWindow !== "undefined" && unsafeWindow !== window;
    if (sandboxed) {
      ways.push({ id: "sandboxed", run: function() {
        return "sandboxed: no page-context injection path left";
      } });
    } else {
      ways.push({ id: "direct-eval", run: function(code) {
        new Function(code)();
        return "";
      } });
    }
    const reasons = [];
    let settled = false;
    let next = 0;
    function finish(err) {
      if (settled) return;
      settled = true;
      _hookReceipt.onConfirmed = null;
      if (_hookReceipt.timer !== null) {
        clearTimeout(_hookReceipt.timer);
        _hookReceipt.timer = null;
      }
      onDone(err);
    }
    function step() {
      if (settled) return;
      if (next >= ways.length) {
        finish(reasons.join(" | ") || "no page-context injection path available");
        return;
      }
      const way = ways[next++];
      let why = "";
      _ttNotice = "";
      _hookReceipt.onConfirmed = function() {
        finish("");
      };
      try {
        why = way.run(buildPageHookCode(way.id)) || "";
      } catch (e) {
        why = way.id + ": " + e;
      }
      if (settled) return;
      if (why) {
        _hookReceipt.onConfirmed = null;
        reasons.push(why + (_ttNotice ? " [" + _ttNotice + "]" : ""));
        step();
        return;
      }
      _hookReceipt.timer = setTimeout(function() {
        if (settled) return;
        _hookReceipt.onConfirmed = null;
        const empty = _hookReceipt.emptyLevels.indexOf(way.id) >= 0;
        reasons.push(way.id + ": " + (empty ? "injected code ran but hooked neither fetch nor XMLHttpRequest" : "no hook receipt within " + CFG.hookReceiptMs + "ms (injected code never ran in the page world)") + (_ttNotice ? " [" + _ttNotice + "]" : ""));
        step();
      }, CFG.hookReceiptMs);
    }
    step();
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "ytus-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  var Bridge = class {
    ws = null;
    state = "idle";
    attempts = 0;
    stopped = false;
    videoEl = null;
    statusEl = null;
    hookError = "";
    sourceId = "";
    videoId = "";
    trackKey = "";
    cueSig = "";
    cueCount = -1;
    trackKind = "";
    trackLang = "";
    captureError = "";
    // Command-channel token (#219): connection-level, survives video changes.
    wsToken = null;
    cache = { register: null, cues: null, sync: null };
    constructor() {
      this.resetSource("");
    }
    resetSource(videoId) {
      this.sourceId = uuid();
      this.videoId = videoId;
      this.trackKey = "";
      this.cueSig = "";
      this.cueCount = -1;
      this.trackKind = "";
      this.trackLang = "";
      this.captureError = "";
      this.cache = { register: null, cues: null, sync: null };
    }
    health(done) {
      if (typeof GM_xmlhttpRequest !== "function") {
        done(true);
        return;
      }
      GM_xmlhttpRequest({
        method: "GET",
        url: "http://" + CFG.host + ":" + CFG.port + "/health",
        timeout: 2e3,
        onload: function(response) {
          done(response.status >= 200 && response.status < 300);
        },
        onerror: function() {
          done(false);
        },
        ontimeout: function() {
          done(false);
        }
      });
    }
    // Command-channel token (#219). The desktop serves GET /token with no CORS
    // headers, so page-world JS cannot read it; GM_xmlhttpRequest can. Failure
    // is not fatal: null keeps this connection upstream-only (frames flow,
    // commands do not) - also the compatibility path against an older desktop.
    fetchToken(done) {
      if (typeof GM_xmlhttpRequest !== "function") {
        done(null);
        return;
      }
      GM_xmlhttpRequest({
        method: "GET",
        url: "http://" + CFG.host + ":" + CFG.port + "/token",
        timeout: 2e3,
        onload: function(response) {
          if (response.status < 200 || response.status >= 300) {
            done(null);
            return;
          }
          try {
            const data = JSON.parse(response.responseText);
            done(typeof data.token === "string" && data.token ? data.token : null);
          } catch (error) {
            done(null);
          }
        },
        onerror: function() {
          done(null);
        },
        ontimeout: function() {
          done(null);
        }
      });
    }
    send(frame) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      try {
        this.ws.send(JSON.stringify(frame));
        return true;
      } catch (error) {
        return false;
      }
    }
    cacheAndSend(kind, frame) {
      this.cache[kind] = frame;
      return this.send(frame);
    }
    connect() {
      if (this.stopped) return;
      this.setState("probing");
      this.health((healthy) => {
        if (this.stopped) return;
        if (!healthy) {
          this.scheduleReconnect();
          return;
        }
        this.fetchToken((token) => {
          if (this.stopped) return;
          this.wsToken = token;
          this.openSocket();
        });
      });
    }
    openSocket() {
      this.setState("connecting");
      try {
        this.ws = new WebSocket("ws://" + CFG.host + ":" + CFG.port + "/ws");
      } catch (error) {
        this.scheduleReconnect();
        return;
      }
      this.ws.onopen = () => {
        this.attempts = 0;
        this.setState("connected");
        this.replay();
      };
      this.ws.onclose = () => {
        this.setState("closed");
        this.scheduleReconnect();
      };
      this.ws.onerror = () => {
        this.setState("error");
      };
      this.ws.onmessage = (ev) => {
        this.onCommand(ev.data);
      };
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
      this.setState("retry in " + Math.round(delay / 1e3) + "s");
      setTimeout(() => {
        this.connect();
      }, delay);
    }
    retryNow() {
      this.stopped = false;
      this.attempts = 0;
      this.connect();
    }
    stop() {
      this.stopped = true;
      if (this.ws) {
        try {
          this.ws.close();
        } catch (error) {
        }
      }
      this.setState("stopped");
    }
    buildRegister() {
      const frame = Object.assign({
        type: "register",
        provider: "youtube",
        source_id: this.sourceId,
        video_id: this.videoId,
        track_kind: this.trackKind,
        track_lang: this.trackLang,
        hook_error: this.hookError,
        capture_error: this.captureError
      }, videoMetadata());
      if (this.wsToken) frame.token = this.wsToken;
      return frame;
    }
    setHookError(msg) {
      msg = msg || "";
      if (msg === this.hookError) return;
      this.hookError = msg;
      if (msg) console.warn("[youtubesub] page hook not installed:", msg);
      this.republishRegister();
    }
    republishRegister() {
      this.send(this.buildRegister());
      this.setState(this.state);
    }
    sendSync() {
      const video = this.videoEl;
      if (!video) return;
      const frame = {
        type: "sync",
        source_id: this.sourceId,
        video_id: this.videoId,
        video_time_ms: Math.round(video.currentTime * 1e3),
        playing: !video.paused && !video.ended,
        playback_rate: video.playbackRate || 1,
        timestamp: Date.now()
      };
      if (typeof video.duration === "number" && Number.isFinite(video.duration)) {
        frame.duration_ms = Math.round(video.duration * 1e3);
      }
      this.cacheAndSend("sync", frame);
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
    onCommand(raw) {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (error) {
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      if (msg.source_id !== this.sourceId) return;
      const video = this.videoEl;
      if (!video) return;
      switch (msg.type) {
        case "play":
          video.play().catch(function() {
          });
          break;
        case "pause":
          video.pause();
          break;
        case "seek": {
          const delta = msg.delta_ms;
          if (typeof delta !== "number" || !Number.isFinite(delta)) return;
          const dur = typeof video.duration === "number" && Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
          const target = Math.min(Math.max(video.currentTime + delta / 1e3, 0), dur);
          try {
            video.currentTime = target;
          } catch (error) {
          }
          break;
        }
        case "mute":
          if (typeof msg.muted !== "boolean") return;
          video.muted = msg.muted;
          break;
        default:
          return;
      }
    }
    onTimedtextFailure(url, reason) {
      if (!isTimedtextUrl(url)) return;
      const message = String(reason || "caption response was unusable");
      if (message === this.captureError) return;
      this.captureError = message;
      console.warn("[youtubesub] caption capture failed:", message);
      this.send(this.buildRegister());
      this.setState(this.state);
    }
    onTimedtext(url, data) {
      if (!isTimedtextUrl(url)) return;
      this.captureError = "";
      const cues = parseJson3(data, url);
      if (!cues.length) return;
      const track = {
        key: normKey(url),
        signature: cuesSignature(cues),
        kind: trackKindFromUrl(url),
        lang: trackLangFromUrl(url)
      };
      if (track.key === this.trackKey && track.signature === this.cueSig && track.kind === this.trackKind && track.lang === this.trackLang) return;
      this.trackKey = track.key;
      this.cueSig = track.signature;
      this.trackKind = track.kind;
      this.trackLang = track.lang;
      this.cueCount = cues.length;
      this.send(this.buildRegister());
      this.cacheAndSend("cues", Object.assign({
        type: "cues",
        provider: "youtube",
        source_id: this.sourceId,
        video_id: this.videoId,
        track_kind: this.trackKind,
        track_lang: this.trackLang,
        cues
      }, videoMetadata()));
    }
    bindVideo(video) {
      this.videoEl = video;
      ["timeupdate", "play", "pause", "seeked", "ratechange"].forEach((event) => {
        video.addEventListener(event, () => {
          this.sendSync();
        });
      });
      this.sendSync();
    }
    newSource() {
      if (this.cache.sync) this.send({ type: "deactivate", source_id: this.sourceId });
      this.resetSource(videoIdFromLocation());
      this.send(this.buildRegister());
    }
    poll() {
      const video = document.querySelector("video");
      const videoId = videoIdFromLocation();
      if (videoId && videoId !== this.videoId) this.newSource();
      if (video && video !== this.videoEl) this.bindVideo(video);
    }
    // ---- status panel (minimal, mirrors dkitle's user-facing retry/stop) ----
    panelText(s) {
      if (this.hookError) {
        const max = 90;
        const why = this.hookError.length > max ? this.hookError.slice(0, max - 3) + "..." : this.hookError;
        return "youtubesub: NO PAGE HOOK - " + why + (s && s !== "connected" ? " (" + s + ")" : "");
      }
      return "youtubesub: " + s + (this.captureError ? " [NO CAPTION BODY]" : "");
    }
    setState(s) {
      this.state = s;
      if (!this.statusEl) return;
      this.statusEl.textContent = this.panelText(s);
      this.statusEl.title = (this.hookError ? this.hookError + "\n" : "") + "Click: retry now. Double-click: stop.";
      this.statusEl.style.color = this.hookError ? "#f88" : s === "connected" ? "#8f8" : s === "stopped" ? "#f88" : "#fd8";
    }
    mountPanel() {
      if (this.statusEl || !document.body) return;
      const el = document.createElement("div");
      el.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99999;font:11px Consolas,monospace;background:rgba(0,0,0,.6);color:#fd8;padding:3px 6px;border-radius:4px;pointer-events:auto;";
      el.textContent = this.panelText(this.state);
      el.title = "Click: retry now. Double-click: stop.";
      el.addEventListener("click", () => {
        this.retryNow();
      });
      el.addEventListener("dblclick", () => {
        this.stop();
      });
      document.body.appendChild(el);
      this.statusEl = el;
    }
  };
  function videoIdFromLocation() {
    const m = /[?&]v=([\w-]{6,})/.exec(location.search);
    return m ? m[1] : "";
  }
  var bridge = new Bridge();
  function onTimedtextEvent(ev) {
    try {
      const d = ev.detail || {};
      if (d.error) bridge.onTimedtextFailure(d.url, d.error);
      else bridge.onTimedtext(d.url, d.data);
    } catch (e) {
      console.warn("[youtubesub] cue handling failed", e);
    }
  }
  function afterDomReady() {
    bridge.videoId = videoIdFromLocation();
    bridge.mountPanel();
    bridge.connect();
    setInterval(function() {
      bridge.poll();
    }, CFG.videoPollMs);
    bridge.poll();
  }
  function boot() {
    window.addEventListener("youtubesub-timedtext", onTimedtextEvent);
    window.addEventListener("youtubesub-hook-ready", onHookReadyEvent);
    injectPageHooks(function(err) {
      bridge.setHookError(err || "");
      if (err) {
        _hookReceipt.onLateConfirmed = function() {
          bridge.setHookError("");
        };
      }
    });
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", afterDomReady);
    } else {
      afterDomReady();
    }
  }
  boot();
  window.addEventListener("beforeunload", function() {
    bridge.send({ type: "deactivate", source_id: bridge.sourceId });
  });
  window.__youtubesub = {
    parseJson3,
    cuesSignature,
    normKey,
    trackKindFromUrl,
    trackLangFromUrl,
    isTimedtextUrl,
    videoIdFromLocation,
    buildPageHookCode,
    Bridge,
    cfg: CFG,
    instance: bridge
  };
})();
