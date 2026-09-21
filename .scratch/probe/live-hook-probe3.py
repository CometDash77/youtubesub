"""Probe v3 (O3 follow-up 2): did the page actually play and show captions, what is
the FULL timedtext URL, and does a manual re-fetch of that URL return a body?
Read-only; reuses the E2E harness.

Usage: python .scratch/probe/live-hook-probe3.py [URL] [SECONDS]
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
SECONDS = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0
PROXY = "http://127.0.0.1:10809"

TRACER = r"""
(function () {
  if (window.__e2e_urls) return 'already installed';
  window.__e2e_urls = [];
  var test = /timedtext|srv3|json3/i;
  var oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { window.__e2e_urls.push(String(u)); } catch (e) {}
    return oo.apply(this, arguments);
  };
  var os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    var u = String(xhr.__ytusUrl || '');
    if (test.test(u)) {
      window.__e2e_tt_full = u;
      xhr.addEventListener('load', function () {
        try { window.__e2e_tt_len = xhr.responseText.length; }
        catch (e) { window.__e2e_tt_len = 'ERR ' + e; }
      });
    }
    return os.apply(this, arguments);
  };
  var of = window.fetch;
  if (of) {
    window.fetch = function () {
      try { window.__e2e_urls.push(String((arguments[0] && arguments[0].url) || arguments[0])); } catch (e) {}
      return of.apply(this, arguments);
    };
  }
  return 'installed';
})()
"""

STATE = r"""
(function () {
  var v = document.querySelector('video');
  var seg = document.querySelector('.ytp-caption-segment');
  var p = document.querySelector('#movie_player');
  var ys = window.__youtubesub, inst = ys ? (ys.instance || {}) : {};
  return JSON.stringify({
    paused: v ? v.paused : null, t: v ? Math.round(v.currentTime * 10) / 10 : null,
    playerState: p && p.getPlayerState ? p.getPlayerState() : null,
    ccEnabled: p && p.getOption ? String(p.getOption('captions', 'track')) : null,
    captionDom: seg ? seg.textContent.slice(0, 90) : null,
    ttLen: window.__e2e_tt_len === undefined ? null : window.__e2e_tt_len,
    ttFull: window.__e2e_tt_full || null,
    cueCount: inst.cueCount, trackKey: inst.trackKey, state: inst.state
  });
})()
"""

REFETCH = r"""
(function () {
  var u = window.__e2e_tt_full;
  if (!u) return JSON.stringify({ skipped: 'no timedtext url captured' });
  window.__e2e_refetch = 'pending';
  fetch(u, { credentials: 'include' })
    .then(function (r) { return r.text().then(function (t) {
      window.__e2e_refetch = JSON.stringify({ status: r.status, ct: r.headers.get('content-type'),
        len: t.length, head: t.slice(0, 160) });
    }); })
    .catch(function (e) { window.__e2e_refetch = 'ERR ' + e; });
  return JSON.stringify({ started: true, url: u });
})()
"""

ALLURLS = r"""
(function () {
  var urls = window.__e2e_urls || [];
  return JSON.stringify(urls.slice(-30).map(function (u) { return u.slice(0, 110); }));
})()
"""


def main():
    import _tee
    _tee.tee(HERE, "probe3")
    print("url      :", URL)
    headed = os.environ.get("PROBE_HEADED") == "1"
    print("headed   :", headed)
    h = E2E.Harness(headed=headed, proxy=PROXY, bypass_csp=True)
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
            s = h.cdp.evaluate(STATE)
            if s != last:
                print("state    :", s)
                last = s
            time.sleep(3)
        st = h.status() or {}
        print("app      :", json.dumps({k: st.get(k) for k in
              ("state", "orig", "trans", "sources", "hook_error")}, ensure_ascii=True))
        print("bridge   :", h.cdp.evaluate(
            "JSON.stringify({cueCount: window.__youtubesub.instance.cueCount,"
            " trackKey: window.__youtubesub.instance.trackKey})"))
        print("refetch  :", h.cdp.evaluate(REFETCH))
        time.sleep(4)
        print("refetch#2:", h.cdp.evaluate("window.__e2e_refetch"))
        print("state#2  :", h.cdp.evaluate(STATE))
        print("urls     :", h.cdp.evaluate(ALLURLS))
    finally:
        h.stop()


if __name__ == "__main__":
    main()
