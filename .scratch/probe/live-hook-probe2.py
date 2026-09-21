"""Probe v2 (O3 follow-up): which channel carries the real timedtext request, and
what does its payload actually look like? Read-only, reuses the E2E harness.

Usage: python .scratch/probe/live-hook-probe2.py [URL] [SECONDS]
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "desktop", "tests"))

import browser_e2e as E2E  # noqa: E402

URL = sys.argv[1] if len(sys.argv) > 1 else "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
SECONDS = float(sys.argv[2]) if len(sys.argv) > 2 else 25.0
PROXY = "http://127.0.0.1:10809"
TT = "/timedtext|srv3|json3/i"

TRACER = r"""
(function () {
  if (window.__e2e_urls) return 'already installed';
  window.__e2e_urls = [];
  window.__e2e_fetch_urls = [];
  window.__e2e_xhr_urls = [];
  var test = /timedtext|srv3|json3/i;

  var f = window.fetch;
  window.__e2e_inner_fetch = f || null;
  if (f) {
    window.fetch = function () {
      var args = arguments;
      var url = String((args[0] && args[0].url) || args[0] || '');
      window.__e2e_urls.push(url);
      window.__e2e_fetch_urls.push(url);
      var p = f.apply(this, args);
      if (test.test(url)) {
        window.__e2e_tt_full = url;
        window.__e2e_tt_channel = 'fetch';
        p.then(function (res) {
          var rec = { status: res.status, ok: res.ok, type: res.type,
                      ct: res.headers.get('content-type'),
                      cl: res.headers.get('content-length') };
          window.__e2e_resp = rec;
          try {
            var c = res.clone();
            c.text().then(function (t) {
              window.__e2e_body = { len: t.length, head: t.slice(0, 200) };
              try {
                var j = JSON.parse(t);
                window.__e2e_json = { events: (j.events || []).length,
                                      first: String(JSON.stringify((j.events || [])[0] || null)).slice(0, 220) };
              } catch (e) { window.__e2e_json = { parseError: String(e) }; }
            }).catch(function (e) { window.__e2e_body = { err: String(e) }; });
          } catch (e) { window.__e2e_resp.cloneError = String(e); }
        }).catch(function (e) { window.__e2e_resp = { promiseError: String(e) }; });
      }
      return p;
    };
  }
  window.__e2e_outer_fetch = window.fetch;

  var oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { window.__e2e_urls.push(String(u)); window.__e2e_xhr_urls.push(String(u)); } catch (e) {}
    return oo.apply(this, arguments);
  };
  var os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var u = String(xhr.__ytusUrl || '');
    if (test.test(u)) {
      window.__e2e_tt_full = u;
      window.__e2e_tt_channel = (window.__e2e_tt_channel || '') + '+xhr';
      xhr.addEventListener('load', function () {
        var rec = { url: u.slice(0, 200), responseType: xhr.responseType, status: xhr.status,
                    textLen: null, textErr: null, json: null };
        try {
          var t = xhr.responseText;
          rec.textLen = t.length;
          rec.head = t.slice(0, 200);
          try {
            var j = JSON.parse(t);
            rec.json = { events: (j.events || []).length,
                         first: String(JSON.stringify((j.events || [])[0] || null)).slice(0, 200) };
          } catch (e) { rec.json = { parseError: String(e) }; }
        } catch (e) { rec.textErr = String(e); }
        window.__e2e_xhr_diag = rec;
      });
    }
    return os.apply(this, arguments);
  };
  return 'installed';
})()
"""

PROBE = r"""
(function () {
  var ys = window.__youtubesub;
  var inst = ys ? (ys.instance || {}) : {};
  var urls = window.__e2e_urls || [];
  var fetches = window.__e2e_fetch_urls || [];
  var xhrs = window.__e2e_xhr_urls || [];
  function tt(a) { return a.filter(function (u) { return /timedtext|srv3|json3/i.test(u); }); }
  return JSON.stringify({
    state: inst.state, hookError: inst.hookError, trackKey: inst.trackKey, cueCount: inst.cueCount,
    ttChannel: window.__e2e_tt_channel || null,
    ttFull: (window.__e2e_tt_full || '').slice(0, 400),
    ttInFetch: tt(fetches).length, ttInXhr: tt(xhrs).length,
    fetchCount: fetches.length, xhrCount: xhrs.length,
    resp: window.__e2e_resp || null,
    body: window.__e2e_body || null,
    json: window.__e2e_json || null,
    xhrDiag: window.__e2e_xhr_diag || null
  });
})()
"""


def main():
    import _tee
    _tee.tee(HERE, "probe2")
    print("url      :", URL)
    h = E2E.Harness(headed=False, proxy=PROXY, bypass_csp=True)
    h.start()
    try:
        h.cdp.call("Page.navigate", {"url": URL})
        E2E.wait_for(lambda: h.cdp.evaluate("document.readyState") == "complete",
                     timeout=60, what="the real page to load")
        time.sleep(3)
        print("tracer   :", h.cdp.evaluate(TRACER))
        print("captions :", h.cdp.evaluate(E2E.LIVE_BOOTSTRAP))
        deadline = time.time() + SECONDS
        last = None
        while time.time() < deadline:
            p = h.cdp.evaluate(PROBE)
            if p != last:
                print("probe    :", p)
                last = p
            time.sleep(3)
        print("final    :", h.cdp.evaluate(PROBE))
        st = h.status() or {}
        print("app      :", json.dumps({k: st.get(k) for k in
              ("state", "orig", "trans", "sources", "hook_error")}, ensure_ascii=False))
    finally:
        h.stop()


if __name__ == "__main__":
    main()
