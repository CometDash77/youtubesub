// Static asset copy for the skeleton build (no bundler per the Phase 1
// split decision). tsc emits dist/{main,preload,renderer}; this step copies
// the renderer HTML next to the emitted renderer.js.
import { cpSync, mkdirSync } from "node:fs";

mkdirSync(new URL("../dist/renderer", import.meta.url), { recursive: true });
cpSync(
  new URL("../src/renderer/index.html", import.meta.url),
  new URL("../dist/renderer/index.html", import.meta.url),
);
cpSync(
  new URL("../src/renderer/debug.html", import.meta.url),
  new URL("../dist/renderer/debug.html", import.meta.url),
);
// #227: the external control-bar window ships its own HTML shell.
cpSync(
  new URL("../src/renderer/bar.html", import.meta.url),
  new URL("../dist/renderer/bar.html", import.meta.url),
);
// #226: the external control-bar window ships its own classic-script page.
cpSync(
  new URL("../src/renderer/bar.html", import.meta.url),
  new URL("../dist/renderer/bar.html", import.meta.url),
);
// Vendored Web Awesome subset (#220) ships as-is: not compiled, just copied.
cpSync(
  new URL("../src/renderer/vendor", import.meta.url),
  new URL("../dist/renderer/vendor", import.meta.url),
  { recursive: true },
);
console.log("copied dist/renderer/{index,bar,debug}.html + vendor/");
