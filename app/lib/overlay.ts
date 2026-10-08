// Re-export shim, same reason as lib/settings.ts: the Electron main process
// imports the overlay display port at runtime and tsconfig.build rootDir is
// "src", so the implementation lives in src/main/overlay.ts (zero relative
// imports, so the node --test strip runner loads it through this shim fine).
// The lib surface stays the test entry point for the #204 equivalence tests.
export * from "../src/main/overlay.ts";
