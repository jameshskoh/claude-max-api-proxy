// Tests for the Host allowlist and the absence of CORS headers. Uses only
// GET /health and OPTIONS requests, so the Claude CLI is never spawned.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer, stopServer } from "./index.js";

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let server: Server;
let port: number;

before(async () => {
  server = await startServer({ port: 0 });
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await stopServer();
});

describe("Host allowlist", () => {
  it("serves /health for 127.0.0.1, localhost and [::1] Host headers without CORS headers", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await send(port, "GET", "/health", { host });
      assert.equal(res.status, 200, `Host ${host}`);
      assert.equal(res.headers["access-control-allow-origin"], undefined, `Host ${host}`);
    }
  });

  it("serves /health for a local Host when a foreign Origin is sent, without CORS headers", async () => {
    const res = await send(port, "GET", "/health", {
      host: `localhost:${port}`,
      origin: "https://evil.example",
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });

  it("rejects a non-local Host with 403 and forbidden_host, with and without a port", async () => {
    for (const host of ["evil.example", `evil.example:${port}`]) {
      const res = await send(port, "GET", "/health", { host });
      assert.equal(res.status, 403, `Host ${host}`);
      const body = JSON.parse(res.body) as { error: { code: string; type: string; message: string } };
      assert.equal(body.error.code, "forbidden_host", `Host ${host}`);
      assert.equal(body.error.type, "invalid_request_error", `Host ${host}`);
      assert.equal(body.error.message, "Forbidden host", `Host ${host}`);
    }
  });

  it("OPTIONS preflight from a foreign Origin gets no access-control-allow-origin and not 200/204", async () => {
    const res = await send(port, "OPTIONS", "/v1/chat/completions", {
      host: `127.0.0.1:${port}`,
      origin: "https://evil.example",
      "access-control-request-method": "POST",
    });
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    assert.ok(
      res.status !== 200 && res.status !== 204,
      `expected a status other than 200/204, got ${res.status}`,
    );
  });
});
