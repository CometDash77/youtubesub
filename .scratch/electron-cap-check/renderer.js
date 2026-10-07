// 穿透态 + 局部可点区域：forward 转发的 mousemove 驱动 elementFromPoint，
// 指针落在解锁图标热区时切回可点，离开热区恢复穿透。
let clickThrough = false;
const statusEl = document.getElementById("status");
const origEl = document.getElementById("orig");

window.capcheck.onClickThrough((on) => {
  clickThrough = on;
  document.body.classList.toggle("ct", on);
  if (!on) document.body.classList.remove("hot");
  statusEl.textContent = on ? "click-through ON (Ctrl+Alt+U unlock)" : "";
});

let lastHot = null;
document.addEventListener("mousemove", (e) => {
  if (!clickThrough) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const hot = !!(el && el.closest && el.closest(".hot"));
  if (hot !== lastHot) {              // 状态变化才打点，避免日志洪水
    lastHot = hot;
    window.capcheck.rendererLog("hot=" + hot + " at " + Math.round(e.clientX) + "," + Math.round(e.clientY));
  }
  window.capcheck.setIgnore(!hot);   // 热区内可点，热区外穿透
  // body 的状态类不能与热区标记 .hot 同名：closest(".hot") 会命中 body
  // 自身，热区判定从此恒真。状态类改名 hot-bg。
  document.body.classList.toggle("hot-bg", hot);
});

document.getElementById("unlock").addEventListener("click", () => {
  window.capcheck.rendererLog("unlock icon clicked -> click_through off");
  window.capcheck.setIgnore(false);
});

// 协议 v1 帧 -> 渲染层显示（证明 WS -> 主进程 -> 渲染进程互通）。
window.capcheck.onWsFrame((ev) => {
  if (ev.type === "register") {
    statusEl.textContent = "waiting for subtitles..." + (ev.tab_title ? "  [" + ev.tab_title + "]" : "");
  } else if (ev.type === "cues") {
    const c = (ev.cues || []).slice(-1)[0];
    origEl.textContent = "【原】" + ((c && c.text) || "");
  } else if (ev.type === "sync") {
    if (!ev.playing) statusEl.textContent = "[Paused]";
  }
});
