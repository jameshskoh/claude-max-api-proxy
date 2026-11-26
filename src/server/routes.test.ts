// Tests for an error result from the Claude CLI reaching the HTTP layer.
// A stand-in CLI (selected through CLAUDE_BIN) prints one result line with
// is_error set, so the real Claude CLI is never spawned and no tokens are used.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startServer, stopServer } from "./index.js";

const ERROR_MESSAGE = "API Error: rate limited";

const ERROR_RESULT = {
  type: "result",
  subtype: "success",
  is_error: true,
  result: ERROR_MESSAGE,
  session_id: "s",
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
};

const REQUEST_BODY = {
  model: "claude-haiku-5-5",
  messages: [{ role: "user", content: "hi" }],
};

let fixtureDir: string;
let fixturePath: string;
let savedClaudeBin: string | undefined;
let server: Server;
let baseUrl: string;

/** Writes the stand-in CLI: it drains stdin, prints one result line, and exits 0. */
function writeFakeClaude(dir: string): string {
  const resultLine = JSON.stringify(ERROR_RESULT) + "\n";
  const script = [
    "#!/usr/bin/env node",
    `const line = ${JSON.stringify(resultLine)};`,
    'process.stdin.resume();',
    'process.stdin.on("end", () => {',
    '  process.stdout.write(line, () => process.exit(0));',
    "});",
    "",
  ].join("\n");
  const file = path.join(dir, "fake-claude.cjs");
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}

before(async () => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "routes-test-"));
  fixturePath = writeFakeClaude(fixtureDir);
  savedClaudeBin = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = fixturePath;
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

describe("chat completions with an is_error CLI result", () => {
  it("returns a 500 OpenAI-style error for a non-streaming request", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(REQUEST_BODY),
    });
    const body = (await res.json()) as { error: { message: string; type: string } };

    assert.equal(res.status, 500);
    assert.equal(body.error.type, "server_error");
    assert.equal(body.error.message, ERROR_MESSAGE);
  });

  it("sends the error as an SSE event, then [DONE], for a streaming request", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...REQUEST_BODY, stream: true }),
    });
    const text = await res.text();

    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));

    const errorEvents = dataLines
      .filter((payload) => payload !== "[DONE]")
      .map((payload) => JSON.parse(payload) as { error?: { message: string } })
      .filter((event) => event.error !== undefined);

    assert.equal(errorEvents.length, 1, `expected one error event in:\n${text}`);
    assert.equal(errorEvents[0].error?.message, ERROR_MESSAGE);
    assert.ok(dataLines.includes("[DONE]"), `missing [DONE] in:\n${text}`);
    assert.ok(
      !text.includes('finish_reason":"stop"'),
      `an error stream must not finish with stop:\n${text}`
    );
  });
});
