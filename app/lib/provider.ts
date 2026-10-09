// Re-export shim: the provider port now lives in src/main/provider.ts so the
// Electron main process can import it at runtime (tsconfig.build rootDir =
// "src" - files under app/lib are not emitted to dist). Relocated with ticket
// #205 (the settings/debug window previews prompts through the production
// build_instructions, identity-tested); the lib surface stays the test entry
// point, unchanged for every existing consumer.
export * from "../src/main/provider.ts";
