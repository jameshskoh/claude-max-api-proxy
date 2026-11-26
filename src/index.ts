/**
 * Library entry: re-exports the HTTP server and Claude CLI helpers.
 * The proxy is normally run with the standalone server entry.
 */

export { startServer, stopServer, getServer } from "./server/index.js";
export type { ServerConfig } from "./server/index.js";
export { ClaudeSubprocess, verifyClaude, verifyAuth } from "./subprocess/manager.js";
