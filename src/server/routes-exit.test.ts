// Tests for a Claude CLI that exits without a result message, reaching the HTTP layer.
// Stand-in CLIs (selected through CLAUDE_BIN) drain stdin and then exit, so the real
// Claude CLI is never spawned and no tokens are used.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer, stopServer } from "./index.js";

const REQUEST_BODY = {
  model: "claude-haiku-5-5",
  messages: [{ role: "user", content: "hi" }],
};

let fixtureDir: string;
let silentExitPath: string;
let stderrExitPath: string;
let savedClaudeBin: string | undefined;
let server: Server;
let baseUrl: string;

/** Writes a stand-in CLI that drains stdin, then runs the given body. */
function writeFakeClaude(dir: string, name: string, onEnd: string): string {
  const script = [
    "#!/usr/bin/env node",
    "process.stdin.resume();",
    'process.stdin.on("end", () => {',
    `  ${onEnd}`,
    "});",
    "",
  ].join("\n");
  const file = path.join(dir, name);
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}

/** Extracts the payloads of all SSE data lines in a streamed body. */
function dataPayloads(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length).trim());
}

before(async () => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "routes-exit-test-"));
  silentExitPath = writeFakeClaude(fixtureDir, "silent-exit.cjs", "process.exit(0);");
  stderrExitPath = writeFakeClaude(
    fixtureDir,
    "stderr-exit.cjs",
    'process.stderr.write("warming up\\nfatal: bad flag\\n", () => process.exit(1));'
  );
  savedClaudeBin = process.env.CLAUDE_BIN;
  server = await startServer({ port: 0 });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  try {
    await stopServer();
  } finally {
    if (savedClaudeBin === undefined) {
      delete process.env.CLAUDE_BIN;
    } else {
      process.env.CLAUDE_BIN = savedClaudeBin;
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe("chat completions when the CLI exits without a result", () => {
  it("streams an error event containing 'without a result', then [DONE]", async () => {
    process.env.CLAUDE_BIN = silentExitPath;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...REQUEST_BODY, stream: true }),
    });
    const text = await res.text();

    const payloads = dataPayloads(text);
    const errorEvents = payloads
      .filter((payload) => payload !== "[DONE]")
      .map((payload) => JSON.parse(payload) as { error?: { message: string } })
      .filter((event) => event.error !== undefined);

    assert.equal(errorEvents.length, 1, `expected one error event in:\n${text}`);
    assert.ok(
      errorEvents[0].error?.message.includes("without a result"),
      `unexpected error message in:\n${text}`
    );
    assert.equal(payloads.at(-1), "[DONE]", `body must end with [DONE]:\n${text}`);
  });

  it("returns a 500 whose message includes the last stderr line for a non-streaming request", async () => {
    process.env.CLAUDE_BIN = stderrExitPath;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(REQUEST_BODY),
    });
    const body = (await res.json()) as { error: { message: string } };

    assert.equal(res.status, 500);
    assert.ok(body.error.message.includes("fatal: bad flag"), `message: ${body.error.message}`);
    assert.ok(body.error.message.includes("without response"), `message: ${body.error.message}`);
  });

  it("streams an error event including the last stderr line, then [DONE]", async () => {
    process.env.CLAUDE_BIN = stderrExitPath;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...REQUEST_BODY, stream: true }),
    });
    const text = await res.text();

    const payloads = dataPayloads(text);
    const errorEvents = payloads
      .filter((payload) => payload !== "[DONE]")
      .map((payload) => JSON.parse(payload) as { error?: { message: string } })
      .filter((event) => event.error !== undefined);

    assert.equal(errorEvents.length, 1, `expected one error event in:\n${text}`);
    assert.ok(
      errorEvents[0].error?.message.includes("fatal: bad flag"),
      `unexpected error message in:\n${text}`
    );
    assert.equal(payloads.at(-1), "[DONE]", `body must end with [DONE]:\n${text}`);
  });
});
