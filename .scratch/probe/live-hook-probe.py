"""One-off probe (O3): on the real site, is the userscript page hook still in the
fetch chain - and if it is, where does the chain break? Reuses the E2E harness
read-only: no product file, no test file, no user setting is touched.

Usage: python .scratch/probe/live-hook-probe.py [URL] [SECONDS]
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

# Tracer installed AFTER page load, so it wraps whatever the page/user script left
# behind. Keeping a reference to the function it wrapped is what tells us whether
# the page hook is still in the chain.
TRACER = r"""
(function () {
  if (window.__e2e_urls) return 'already installed';
  window.__e2e_urls = [];
  var f = window.fetch;
  window.__e2e_inner_fetch = f || null;
  if (f) {
    window.fetch = function () {
      try { window.__e2e_urls.push(String((arguments[0] && arguments[0].url) || arguments[0])); } catch (e) {}
      return f.apply(this, arguments);
    };
  }
  window.__e2e_outer_fetch = window.fetch;
  var oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { window.__e2e_urls.push(String(u)); } catch (e) {}
    return oo.apply(this, arguments);
  };
  return 'installed';
})()
"""

PROBE = r"""
(function () {
  var ys = window.__youtubesub;
  var inst = ys ? (ys.instance || {}) : {};
  var outer = String(window.fetch || '');
  var inner = window.__e2e_inner_fetch ? String(window.__e2e_inner_fetch) : '';
  var xhrSend = String(XMLHttpRequest.prototype.send || '');
  var urls = window.__e2e_urls || [];
  var tt = urls.filter(function (u) { return /timedtext|srv3|json3/i.test(u); });
  return JSON.stringify({
    scriptPresent: !!ys,
    fetchStillOurs: window.fetch === window.__e2e_outer_fetch,
    outerHasTracer: outer.indexOf('__e2e_urls') !== -1,
    innerIsHook: inner.indexOf('youtubesub-timedtext') !== -1,
    innerIsTracer: inner.indexOf('__e2e_urls') !== -1,
    innerHead: inner.slice(0, 120),
    xhrHookInstalled: xhrSend.indexOf('__ytusUrl') !== -1,
    timedtextUrls: tt.length,
    timedtextSample: (tt[0] || '').slice(0, 130),
    allUrlCount: urls.length,
    state: inst.state,
    hookError: inst.hookError,
    trackKey: inst.trackKey,
    cueCount: inst.cueCount
  });
})()
"""

DISPATCH = r"""
(function () {
  var payload = { events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'PROBE SENTENCE', tOffsetMs: 100 }] },
    { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: 'PROBE SENTENCE TWO', tOffsetMs: 100 }] }
  ] };
  var got = false;
  window.addEventListener('youtubesub-timedtext', function () { got = true; }, { once: true });
  window.dispatchEvent(new CustomEvent('youtubesub-timedtext', { detail: {
    url: 'https://www.youtube.com/api/timedtext?v=x&lang=en&fmt=json3&pot=probe',
    data: payload } }));
  var ys = window.__youtubesub;
  var inst = ys ? (ys.instance || {}) : {};
  return JSON.stringify({ listenerFired: got, cueCount: inst.cueCount,
                          trackKey: inst.trackKey, state: inst.state });
})()
"""


def main():
    import _tee
    _tee.tee(HERE, "probe1")
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
        while time.time() < deadline:
            print("probe    :", h.cdp.evaluate(PROBE))
            st = h.status() or {}
            print("app      : state=%s hook_error=%r orig=%r"
                  % (st.get("state"), st.get("hook_error"), (st.get("orig") or "")[:60]))
            time.sleep(5)
        print("dispatch :", h.cdp.evaluate(DISPATCH))
        print("probe#2  :", h.cdp.evaluate(PROBE))
        st = h.status() or {}
        print("app#2    :", json.dumps({k: st.get(k) for k in
              ("state", "orig", "trans", "sources", "active_source", "hook_error")},
              ensure_ascii=False))
        for kind, text in h.cdp.console_messages()[-25:]:
            print("console  : [%s] %s" % (kind, text[:200]))
    finally:
        h.stop()


if __name__ == "__main__":
    main()
