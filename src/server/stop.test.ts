// Checks that stopServer() does not wait on an idle keep-alive connection.
// Runs in its own process because the server is a module singleton. Uses only
// GET /health, so the Claude CLI is never spawned.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent, request } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer, stopServer } from "./index.js";

const STOP_TIMEOUT_MS = 2000;

describe("stopServer with an idle keep-alive connection", () => {
  it("resolves within 2000 ms after the keep-alive socket goes idle", async () => {
    const server = await startServer({ port: 0 });
    const port = (server.address() as AddressInfo).port;
    const agent = new Agent({ keepAlive: true });
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      // Fully read one response so the socket returns to the agent's pool, idle but open.
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            method: "GET",
            path: "/health",
            headers: { host: "127.0.0.1" },
            agent,
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", () => resolve());
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();
      });

      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), STOP_TIMEOUT_MS);
      });
      const outcome = await Promise.race([
        stopServer().then(() => "stopped" as const),
        timeout,
      ]);
      assert.equal(outcome, "stopped", `stopServer() did not resolve within ${STOP_TIMEOUT_MS} ms`);
    } finally {
      clearTimeout(timer);
      agent.destroy();
    }
  });
});
