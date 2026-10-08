// Re-export shim: the settings port now lives in src/main/settings.ts so the
// Electron main process can import it (tsconfig.build rootDir = "src" - files
// under app/lib are not emitted to dist). Relocated with ticket #204; the lib
// surface stays the test entry point, unchanged for every existing consumer.
export * from "../src/main/settings.ts";
