# Vendored: Web Awesome dist-cdn subset

- Source: `@awesome.me/webawesome@3.14.0` (npm tarball, MIT — see LICENSE.md,
  Copyright (c) 2025 Fonticons, Inc.). Core components only; no Pro code.
- Vendored for issue #220 (WA over Electron file:// prototype); the #216
  display migration keeps the same vendored copy. Files are consumed verbatim
  at runtime — this directory is intentionally NOT compiled
  (`tsconfig.json` does not include it; `scripts/build.mjs` copies it to
  `dist/renderer/vendor/webawesome`).
- Subset: the autoloader + its chunks + the migrated components
  (button/input/select/option/switch, plus slider/textarea added for #216) +
  internal/events/utilities helpers + the minimal style closure (layers.css +
  themes/default.css + color/palettes/default.css). native.css /
  utilities.css are deliberately excluded: they restyle bare HTML elements
  and would fight the existing hand-written debug window cards.
- Upgrade path: re-pack the tarball, re-copy the same subset, keep this note
  and LICENSE.md. Rollback = delete this directory and the two references in
  `debug.html` (issue #220, failure branch of the Phase 2 component
  reselection map).
