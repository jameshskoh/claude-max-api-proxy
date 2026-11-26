import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ClaudeSubprocess, type SubprocessOptions } from "./manager.js";

const WAIT_TIMEOUT_MS = 5_000;
const GENEROUS_REQUEST_TIMEOUT_MS = 30_000;

const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "hi",
  session_id: "s",
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
});

describe("stderr tail and listener errors in the subprocess manager", () => {
  let fixtureDir: string;
  let resultPath: string;
  let stderrPath: string;
  let previousClaudeBin: string | undefined;

  before(async () => {
    previousClaudeBin = process.env.CLAUDE_BIN;
    fixtureDir = await mkdtemp(path.join(tmpdir(), "claude-stderr-"));
    resultPath = path.join(fixtureDir, "result.cjs");
    stderrPath = path.join(fixtureDir, "stderr-exit.cjs");

    // Drain the prompt on stdin, print one valid result line, exit 0 with no stderr.
    await writeFile(
      resultPath,
      [
        "process.stdin.resume();",
        'process.stdin.on("end", () => {',
        `  process.stdout.write(${JSON.stringify(RESULT_LINE)} + "\\n");`,
        "  process.exitCode = 0;",
        "});",
      ].join("\n"),
      "utf8"
    );

    // Drain the prompt, write two stderr lines, then exit 1 once stderr is flushed.
    await writeFile(
      stderrPath,
      [
        "process.stdin.resume();",
        'process.stdin.on("end", () => {',
        '  process.stderr.write("warming up\\nfatal: bad flag\\n", () => process.exit(1));',
        "});",
      ].join("\n"),
      "utf8"
    );

    process.env.CLAUDE_BIN = process.execPath;
  });

  after(async () => {
    restoreEnvironmentVariable("CLAUDE_BIN", previousClaudeBin);
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("still closes and skips raw output when a result listener throws", async () => {
    const subprocess = new ClaudeSubprocess();
    const testable = subprocess as unknown as {
      buildArgs: (options: SubprocessOptions) => string[];
    };
    const buildRealArgs = testable.buildArgs.bind(subprocess);
    testable.buildArgs = (options) => [resultPath, ...buildRealArgs(options)];

    const rawLines: string[] = [];
    subprocess.on("result", () => {
      throw new Error("listener boom");
    });
    subprocess.on("raw", (line: string) => {
      rawLines.push(line);
    });
    const closed = new Promise<number | null>((resolve) =>
      subprocess.once("close", resolve)
    );

    // The manager logs the caught listener error; keep it out of the test output.
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await subprocess.start("hello", {
        model: "claude-haiku-4-5",
        timeout: GENEROUS_REQUEST_TIMEOUT_MS,
      });
      await withTimeout(closed, "fixture did not close after a listener threw");
    } finally {
      console.error = originalConsoleError;
      subprocess.kill();
    }

    assert.deepEqual(rawLines, [], "a valid result line must not be emitted as raw");
  });

  it("reports the last non-empty stderr line after a failing exit", async () => {
    const subprocess = new ClaudeSubprocess();
    const testable = subprocess as unknown as {
      buildArgs: (options: SubprocessOptions) => string[];
    };
    const buildRealArgs = testable.buildArgs.bind(subprocess);
    testable.buildArgs = (options) => [stderrPath, ...buildRealArgs(options)];

    const closed = new Promise<number | null>((resolve) =>
      subprocess.once("close", resolve)
    );
    try {
      await subprocess.start("hello", {
        model: "claude-haiku-4-5",
        timeout: GENEROUS_REQUEST_TIMEOUT_MS,
      });
      await withTimeout(closed, "stderr fixture did not close");
    } finally {
      subprocess.kill();
    }

    assert.equal(subprocess.stderrLastLine(), "fatal: bad flag");
  });

  it("returns an empty string for stderrLastLine when stderr is empty", async () => {
    const subprocess = new ClaudeSubprocess();
    const testable = subprocess as unknown as {
      buildArgs: (options: SubprocessOptions) => string[];
    };
    const buildRealArgs = testable.buildArgs.bind(subprocess);
    testable.buildArgs = (options) => [resultPath, ...buildRealArgs(options)];

    const closed = new Promise<number | null>((resolve) =>
      subprocess.once("close", resolve)
    );
    try {
      await subprocess.start("hello", {
        model: "claude-haiku-4-5",
        timeout: GENEROUS_REQUEST_TIMEOUT_MS,
      });
      await withTimeout(closed, "empty-stderr fixture did not close");
    } finally {
      subprocess.kill();
    }

    assert.equal(subprocess.stderrLastLine(), "");
  });
});

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), WAIT_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
