// Re-export shim: the connection-test port now lives in
// src/main/connection-test.ts so the Electron main process can run the
// settings page tester at runtime (tsconfig.build rootDir = "src").
// Relocated with ticket #205; the lib surface stays the test entry point.
export * from "../src/main/connection-test.ts";
