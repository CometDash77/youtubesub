// Builds the Tampermonkey artifact: src/youtubesub.ts -> youtubesub.user.js.
// esbuild direct-drive (docs/research/userscript-ts-toolchain.md): format iife so
// the artifact is a single file evaluated bare in a VM sandbox / CDP injection,
// platform browser, and the Tampermonkey metadata block injected as a verbatim
// banner so the artifact's first line stays `// ==UserScript==` and no header
// line can be dropped by the bundler. The attribution comments ride in the
// banner too: the bundler strips ordinary comments from the source.
// --watch: esbuild watch; the userscript still needs a manual Tampermonkey
// reload in Phase 1 (no live-reload plumbing on purpose).
import { build, context, type BuildOptions } from 'esbuild';

const BANNER = `// ==UserScript==
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
// Cue decoding mirrors yt-dual-subs parseJson3 (MIT, (c) 2026 Gythiro).`;

const options: BuildOptions = {
  entryPoints: ['src/youtubesub.ts'],
  outfile: 'youtubesub.user.js',
  bundle: true,
  format: 'iife' as const,
  platform: 'browser' as const,
  target: 'es2022',
  charset: 'utf8',
  sourcemap: false,
  banner: { js: BANNER },
  logLevel: 'info' as const,
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching src/youtubesub.ts -> youtubesub.user.js (reload Tampermonkey manually)');
} else {
  await build(options);
}
