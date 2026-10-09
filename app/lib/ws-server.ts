// lib/ re-export shim (#206): the implementation moved to src/main/ so the
// Electron main process can import it (tsconfig.build rootDir=src). The
// lib path stays as the stable import surface for the test suite.
export * from "../src/main/ws-server.ts";
