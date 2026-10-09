// Re-export shim: the wire-protocol port now lives in src/main/protocol.ts
// so the Electron main process can import it at runtime (tsconfig.build
// rootDir = "src"). Relocated with ticket #205 (the debug probe reads
// STATUS_PATH from the same module the server serves); the lib surface
// stays the test entry point, unchanged for every existing consumer.
export * from "../src/main/protocol.ts";
