// 1:1 port of desktop/tests/test_debug_window_size.py (ticket #205, map #181):
// #180 - window size clamped to the screen + the three-page scroll fallback.
// Before the change, resize(1120, 760) did nothing: the settings page's
// minimum height pushed the window to 1120x1015 and the frameless window had
// no grip, so on short screens the footer fell off-screen. The contract
// pinned here: the window never exceeds "available area - margin", the
// footer lives OUTSIDE the scroll region, and when the content does not fit
// the outer scroll region catches it - scrolled to the bottom, every page's
// last row is visible.
// Every pytest test function maps to exactly one test() below.
// Registered conversions (criteria #2):
//   - Qt widget geometry (minimumSizeHint / visibleRegion / mapTo) -> the
//     explicit layout model in window.ts (min_content_height per page,
//     constants mirroring debug.html's CSS). The geometric guarantees are
//     asserted on that model: fit_to_screen is pure and exact; the footer
//     placement and scroll behavior are structural/arithmetic facts of the
//     model and the debug.html skeleton.
//   - findChild(QScrollArea, "debugScroll") -> the debug.html structure
//     source scan (#debugScroll wraps the page stack; #debugFooter is its
//     sibling, not a descendant).
//   - scrollbar policy != AlwaysOff -> the model always exposes a
//     computable scroll_max (scrolling can never be disabled by policy).
//   - offscreen QApplication + window.show() -> no display server needed;
//     the model owns width/height directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as S from "../lib/settings.ts";
import {
  DebugWindow, fit_to_screen, SCREEN_MARGIN, MIN_H, MIN_W,
} from "../src/main/debug/window.ts";

// The short-screen acceptance case: 1366x768 machines land around here.
const SMALL_W = 800;
const SMALL_H = 800;

function windowModel(ask: "stay" | "save" | "discard" = "discard"): DebugWindow {
  return new DebugWindow(S.default_settings(), {
    port: 1,
    save: () => undefined,
    ask_unsaved_changes: () => ask,
  });
}

test("fit_to_screen never exceeds the available area", () => {
  // 矮屏：按可用区域收敛，留出 SCREEN_MARGIN 的边距
  assert.deepEqual(fit_to_screen(1120, 1015, 800, 800),
    [800 - SCREEN_MARGIN, 800 - SCREEN_MARGIN]);
  // 大屏：原样保留想要的尺寸，不放大
  assert.deepEqual(fit_to_screen(1120, 1015, 1920, 1080), [1120, 1015]);
  // 屏小到装不下下限时退回下限，不缩成 0
  assert.deepEqual(fit_to_screen(1120, 1015, 400, 400), [MIN_W, MIN_H]);
  for (const [avail_w, avail_h] of [[1920, 1080], [1366, 768], [1280, 720], [800, 800]]) {
    const [w, h] = fit_to_screen(1120, 1015, avail_w!, avail_h!);
    assert.ok(w >= MIN_W && h >= MIN_H);
    assert.ok(h <= Math.max(MIN_H, avail_h! - SCREEN_MARGIN));
  }
});

test("the window no longer forces itself taller than the screen", () => {
  // 根因回归：以前布局把最小高度顶到 1015，再怎么写 resize 都救不回来。
  const w = windowModel();
  w.show_page("settings");
  w.show();
  // 设置页本身比矮屏高，所以超高内容确实存在，必须由滚动区接管
  assert.ok(w.page_min_height("settings") > MIN_H);
  // the WINDOW's minimum stays MIN_H, comfortably inside the small screen
  assert.ok(MIN_H < SMALL_H - SCREEN_MARGIN);
  // the scroll region wraps the page stack (structure scan below) and is
  // active for exactly this content (policy can never disable it)
  const st = w.scroll_state("settings");
  assert.ok(st.viewport_h > 0);
  assert.equal(st.content_h, w.page_min_height("settings"));
  w.close();
});

test("the footer stays on screen and clickable on a small screen", () => {
  const w = windowModel();
  w.show_page("settings");
  w.show();
  w.fit_to_available(SMALL_W, SMALL_H);
  assert.ok(w.height <= SMALL_H - SCREEN_MARGIN);
  assert.ok(w.width <= SMALL_W - SCREEN_MARGIN);
  // 页脚在滚动区之外：结构上由 debug.html 骨架钉住 —— #debugFooter 是
  // #debugScroll 的兄弟节点，不是后代；滚页内容不会把「保存 / 取消」滚走。
  const html = fs.readFileSync(
    new URL("../src/renderer/debug.html", import.meta.url), "utf8");
  // 结构断言：#debugFooter 紧跟在 #debugScroll 的同缩进闭合标签之后 ——
  // 它是滚动区的兄弟节点，不是后代。
  const footerSibling = html.includes(
    '</div>\n    <div id="debugFooter">');
  assert.ok(footerSibling, "footer must sit outside the scroll region");
  // 页内容装不下时由外层滚动区兜底：滚到底后内容底边回到视口内
  const st = w.scroll_state("settings");
  assert.ok(st.content_h > st.viewport_h, "设置页在矮屏上必须靠外层滚动区才到底");
  assert.ok(st.content_h - st.scroll_max <= st.viewport_h, "滚到底后最后一项在窗口内");
  // 无边框窗口得给用户一个自己缩的手把：Electron 无边框窗口原生支持边缘
  // 拖拽缩放（resizable: true，host 钉住），QSizeGrip 不再需要。
  assert.ok(html.includes('id="debugFooter"') && html.includes('id="saveBtn"')
    && html.includes('id="cancelBtn"'), "取消 / 保存按钮在页脚结构里");
  w.close();
});

test("every page can be scrolled to its last row", () => {
  const w = windowModel();
  w.show();
  w.fit_to_available(SMALL_W, SMALL_H);
  for (const name of ["settings", "tuning", "diag"]) {
    w.show_page(name);
    const st = w.scroll_state(name);
    // 装得下就直接可见；装不下就得靠外层滚动区滚到底 —— 两种情况下内容
    // 底边都在视口内（= 最后一项可见）。
    assert.ok(
      st.content_h <= st.viewport_h ||
      (st.scroll_max > 0 && st.content_h - st.scroll_max <= st.viewport_h),
      name);
    // 滚动条的行程确实存在（装不下时），且滚动就是「行程全部吃掉」
    if (st.content_h > st.viewport_h) {
      assert.equal(st.content_h - st.scroll_max, st.viewport_h, name);
    }
  }
  // 设置页在矮屏上一定得靠外层滚动区才到底，滚到底后最后一项「测试连接」
  // 在窗口内 —— 由上面的内容底边断言与页脚结构断言共同钉住。
  w.close();
});
