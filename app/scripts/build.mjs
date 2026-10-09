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
console.log("copied dist/renderer/{index,debug}.html");
