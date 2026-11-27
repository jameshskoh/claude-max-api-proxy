import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  ClaudeSubprocess,
  defaultCliCwd,
  resolveClaudeBin,
  type SubprocessOptions,
} from "./manager.js";

const WINDOWS_ONLY = process.platform !== "win32";
const WAIT_TIMEOUT_MS = 5_000;
const GENEROUS_REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 100;

it("defaultCliCwd returns a fixed temp folder that exists as a directory", async () => {
  const dir = defaultCliCwd();
  assert.equal(dir, path.join(tmpdir(), "claude-max-proxy"));
  const info = await stat(dir);
  assert.equal(info.isDirectory(), true);
});

describe("spawn failures", () => {
  let previousClaudeBin: string | undefined;

  before(() => {
    previousClaudeBin = process.env.CLAUDE_BIN;
  });

  after(() => {
    restoreEnvironmentVariable("CLAUDE_BIN", previousClaudeBin);
  });

  it("reports a missing CLI binary as an error event, followed by close", async () => {
    // A path under the temp dir that is never created, so spawn fails with ENOENT
    process.env.CLAUDE_BIN = path.join(
      tmpdir(),
      `claude-missing-${process.pid}-${Date.now()}`
    );
    const subprocess = new ClaudeSubprocess();
    const events: string[] = [];
    let error: Error | undefined;
    subprocess.on("error", (err: Error) => {
      events.push("error");
      error = err;
    });
    const closed = new Promise<void>((resolve) =>
      subprocess.once("close", () => {
        events.push("close");
        resolve();
      })
    );

    await subprocess.start("hi", {
      model: "claude-haiku-4-5",
      timeout: WAIT_TIMEOUT_MS,
    });
    await withTimeout(closed, "missing binary did not emit close");

    assert.deepEqual(events, ["error", "close"]);
    assert.match(error?.message ?? "", /Claude CLI not found/);
  });
});

describe("CLI argv for plain-LLM mode", { skip: !WINDOWS_ONLY }, () => {
  // Runs the real argv builder with a recorder script in place of the CLI, so
  // the flags are checked as they would reach the CLI.
  let fixtureDir: string;
  let argvPath: string;
  let fixturePath: string;
  let previousClaudeBin: string | undefined;
  let previousArgvOut: string | undefined;

  before(async () => {
    previousClaudeBin = process.env.CLAUDE_BIN;
    previousArgvOut = process.env.FIXTURE_ARGV_OUT;
    fixtureDir = await mkdtemp(path.join(tmpdir(), "claude-argv-"));
    argvPath = path.join(fixtureDir, "argv.json");
    fixturePath = path.join(fixtureDir, "record-argv.cjs");
    await writeFile(
      fixturePath,
      [
        'const { writeFileSync } = require("node:fs");',
        'process.stdin.resume();',
        'process.stdin.on("end", () => {',
        "  writeFileSync(process.env.FIXTURE_ARGV_OUT, JSON.stringify(process.argv.slice(2)));",
        "});",
      ].join("\n"),
      "utf8"
    );

    process.env.CLAUDE_BIN = process.execPath;
    process.env.FIXTURE_ARGV_OUT = argvPath;
  });

  after(async () => {
    restoreEnvironmentVariable("CLAUDE_BIN", previousClaudeBin);
    restoreEnvironmentVariable("FIXTURE_ARGV_OUT", previousArgvOut);
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("disables built-in tools and MCP, and sends only the proxy system prompt", async () => {
    const systemPrompt = "You are a test. Reply with <tool_call> blocks when asked.";
    const subprocess = new ClaudeSubprocess();
    subprocess.on("error", () => {});
    const testable = subprocess as unknown as {
      buildArgs: (options: SubprocessOptions) => string[];
    };
    const buildRealArgs = testable.buildArgs.bind(subprocess);
    // Node runs the recorder script first; the real CLI flags follow it.
    testable.buildArgs = (options) => [fixturePath, ...buildRealArgs(options)];

    const closed = new Promise<number | null>((resolve) =>
      subprocess.once("close", resolve)
    );
    await subprocess.start("hello", {
      model: "claude-haiku-4-5",
      systemPrompt,
      timeout: GENEROUS_REQUEST_TIMEOUT_MS,
    });
    await withTimeout(closed, "argv recorder did not exit");

    const argv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
    assert.ok(argv.includes("--tools"), "expected --tools");
    assert.equal(argv[argv.indexOf("--tools") + 1], "", "--tools must be followed by an empty value");
    assert.ok(argv.includes("--strict-mcp-config"), "expected --strict-mcp-config");
    assert.ok(argv.includes("--safe-mode"), "expected --safe-mode");
    assert.ok(argv.includes("--system-prompt"), "expected --system-prompt");
    assert.equal(argv[argv.indexOf("--system-prompt") + 1], systemPrompt);
    assert.ok(!argv.includes("--append-system-prompt"), "the append-system-prompt flag must not be used");
  });
});

describe("Windows process-tree termination", { skip: WINDOWS_ONLY }, () => {
  let fixtureDir: string;
  let fixturePath: string;
  let previousClaudeBin: string | undefined;
  const cleanupPids = new Set<number>();

  before(async () => {
    previousClaudeBin = process.env.CLAUDE_BIN;
    fixtureDir = await mkdtemp(path.join(tmpdir(), "claude-process-tree-"));
    const descendantPath = path.join(fixtureDir, "descendant.cjs");
    fixturePath = path.join(fixtureDir, "process-tree.cjs");
    await writeFile(
      descendantPath,
      [
        'const { writeFileSync } = require("node:fs");',
        "writeFileSync(process.argv[2], \"ready\");",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      fixturePath,
      [
        'const { spawn } = require("node:child_process");',
        'const { existsSync, unlinkSync } = require("node:fs");',
        'const { join } = require("node:path");',
        'const readyPath = join(__dirname, `descendant-${process.pid}.ready`);',
        'try { unlinkSync(readyPath); } catch {}',
        `const descendant = spawn(process.execPath, [${JSON.stringify(descendantPath)}, readyPath], { detached: true, stdio: "ignore" });`,
        "descendant.unref();",
        "const readinessCheck = setInterval(() => {",
        "  if (!existsSync(readyPath)) return;",
        "  clearInterval(readinessCheck);",
        '  process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + "\\n");',
        "}, 10);",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8"
    );

    // Use a controlled binary for every ClaudeSubprocess in this suite.
    process.env.CLAUDE_BIN = process.execPath;
  });

  afterEach(async () => {
    await cleanupTrackedProcesses(cleanupPids);
  });

  after(async () => {
    let cleanupError: unknown;
    try {
      await cleanupTrackedProcesses(cleanupPids);
      if (cleanupPids.size > 0) {
        cleanupError = new Error(
          `failed to terminate fixture processes: ${[...cleanupPids].join(", ")}`
        );
      }
    } catch (error) {
      cleanupError = error;
    } finally {
      restoreEnvironmentVariable("CLAUDE_BIN", previousClaudeBin);
      try {
        await rm(fixtureDir, { recursive: true, force: true });
      } catch (error) {
        cleanupError = cleanupError
          ? new AggregateError([cleanupError, error], "fixture cleanup failed")
          : error;
      }
    }
    if (cleanupError) throw cleanupError;
  });

  it("demonstrates that killing only the direct child leaves its descendant alive", async () => {
    const parent = spawn(process.execPath, [fixturePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackChild(parent, cleanupPids);
    const descendantPid = await readDescendantPid(parent);
    cleanupPids.add(descendantPid);

    assert.equal(parent.kill(), true, "the direct parent should accept termination");
    await waitForExit(parent);

    assert.equal(
      isProcessAlive(descendantPid),
      true,
      "direct-child termination should reproduce the leaked descendant"
    );
  });

  it("kills the full process tree when kill() is called", async () => {
    const subprocess = createFixtureSubprocess();
    const descendantPidPromise = readManagerDescendantPid(subprocess);
    subprocess.on("error", () => {});

    await subprocess.start("", { model: "claude-haiku-4-5", timeout: WAIT_TIMEOUT_MS });
    const rootPid = trackManagerProcess(subprocess, cleanupPids);
    const descendantPid = await descendantPidPromise;
    cleanupPids.add(descendantPid);

    subprocess.kill();

    await waitForProcessToStop(rootPid);
    await waitForProcessToStop(descendantPid);
    assert.equal(isProcessAlive(rootPid), false);
    assert.equal(isProcessAlive(descendantPid), false);
  });

  it("kills the full process tree when the request times out", async () => {
    const subprocess = createFixtureSubprocess();
    const descendantPidPromise = readManagerDescendantPid(subprocess);
    const timeoutErrorPromise = new Promise<Error>((resolve) => {
      subprocess.once("error", resolve);
    });

    await subprocess.start("", {
      model: "claude-haiku-4-5",
      timeout: GENEROUS_REQUEST_TIMEOUT_MS,
    });
    const rootPid = trackManagerProcess(subprocess, cleanupPids);
    const descendantPid = await descendantPidPromise;
    cleanupPids.add(descendantPid);
    const testable = subprocess as unknown as {
      armTimeout: (timeout: number) => void;
    };
    testable.armTimeout(REQUEST_TIMEOUT_MS);
    const timeoutError = await timeoutErrorPromise;

    assert.match(timeoutError.message, new RegExp(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    await waitForProcessToStop(rootPid);
    await waitForProcessToStop(descendantPid);
    assert.equal(isProcessAlive(rootPid), false);
    assert.equal(isProcessAlive(descendantPid), false);
  });

  it("keeps isKilled false when taskkill cannot launch", async () => {
    const subprocess = createFixtureSubprocess();
    const descendantPidPromise = readManagerDescendantPid(subprocess);
    subprocess.on("error", () => {});

    await subprocess.start("", {
      model: "claude-haiku-4-5",
      timeout: GENEROUS_REQUEST_TIMEOUT_MS,
    });
    const rootPid = trackManagerProcess(subprocess, cleanupPids);
    const descendantPid = await descendantPidPromise;
    cleanupPids.add(descendantPid);

    const testable = subprocess as unknown as {
      process: ChildProcess | null;
      isKilled: boolean;
    };
    assert.ok(testable.process, "manager did not retain its root process");
    const managedProcess = testable.process;
    const originalKill = managedProcess.kill.bind(managedProcess);
    let directKillSucceeded = false;
    managedProcess.kill = ((signal?: NodeJS.Signals | number) => {
      directKillSucceeded = originalKill(signal);
      return directKillSucceeded;
    }) as ChildProcess["kill"];

    const previousSystemRoot = process.env.SystemRoot;
    try {
      process.env.SystemRoot = path.join(fixtureDir, "missing-system-root");
      subprocess.kill();
    } finally {
      restoreEnvironmentVariable("SystemRoot", previousSystemRoot);
    }

    assert.equal(directKillSucceeded, true, "direct child kill should succeed");
    assert.equal(testable.isKilled, false, "failed taskkill must not set isKilled");
    await waitForProcessToStop(rootPid);
    assert.equal(isProcessAlive(rootPid), false);
    assert.equal(
      isProcessAlive(descendantPid),
      true,
      "failed tree termination should leave the detached descendant for retry"
    );
  });

  function createFixtureSubprocess(): ClaudeSubprocess {
    const subprocess = new ClaudeSubprocess();
    const testable = subprocess as unknown as { buildArgs: () => string[] };
    testable.buildArgs = () => [fixturePath];
    return subprocess;
  }
});

describe("CLI binary resolution", { skip: process.platform === "win32" }, () => {
  let previousClaudeBin: string | undefined;

  beforeEach(() => {
    previousClaudeBin = process.env.CLAUDE_BIN;
  });

  afterEach(() => {
    restoreEnvironmentVariable("CLAUDE_BIN", previousClaudeBin);
  });

  it("fails on win32 without CLAUDE_BIN and tells the operator to set it", () => {
    delete process.env.CLAUDE_BIN;
    assert.throws(() => resolveClaudeBin("win32"), /CLAUDE_BIN/);
  });

  it("returns CLAUDE_BIN on every platform when it is set", () => {
    process.env.CLAUDE_BIN = "/custom/claude";
    assert.equal(resolveClaudeBin("win32"), "/custom/claude");
    assert.equal(resolveClaudeBin("darwin"), "/custom/claude");
  });

  it("resolves to the bare claude command off win32 without CLAUDE_BIN", () => {
    delete process.env.CLAUDE_BIN;
    assert.equal(resolveClaudeBin("darwin"), "claude");
  });
});

describe("stdout tail and timeout handling without an error listener", () => {
  // Plain fixtures that run on every platform, so these checks do not depend
  // on the Windows-only process-tree suite.
  const STALL_TIMEOUT_MS = 50;
  let fixtureDir: string;
  let unterminatedResultPath: string;
  let stallPath: string;
  let previousClaudeBin: string | undefined;

  before(async () => {
    previousClaudeBin = process.env.CLAUDE_BIN;
    fixtureDir = await mkdtemp(path.join(tmpdir(), "claude-tail-"));
    unterminatedResultPath = path.join(fixtureDir, "unterminated-result.cjs");
    stallPath = path.join(fixtureDir, "stall.cjs");
    await writeFile(
      unterminatedResultPath,
      [
        "process.stdin.resume();",
        'process.stdin.on("end", () => {',
        'process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"hi",session_id:"s",duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}}));',
        "process.exitCode = 0;",
        "});",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      stallPath,
      [
        "process.stdin.resume();",
        'process.stdin.on("end", () => {',
        "  setTimeout(() => {}, 10_000);",
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

  it("emits a final result line that has no trailing newline before close", async () => {
    const subprocess = new ClaudeSubprocess();
    const testable = subprocess as unknown as {
      buildArgs: (options: SubprocessOptions) => string[];
    };
    const buildRealArgs = testable.buildArgs.bind(subprocess);
    testable.buildArgs = (options) => [unterminatedResultPath, ...buildRealArgs(options)];

    const events: string[] = [];
    let resultText: unknown;
    subprocess.on("result", (result: { result?: unknown }) => {
      events.push("result");
      resultText = result.result;
    });
    subprocess.on("error", () => {
      events.push("error");
    });
    const closed = new Promise<void>((resolve) =>
      subprocess.once("close", () => {
        events.push("close");
        resolve();
      })
    );

    await subprocess.start("hello", {
      model: "claude-haiku-4-5",
      timeout: GENEROUS_REQUEST_TIMEOUT_MS,
    });
    await withTimeout(closed, "unterminated result fixture did not close");

    assert.deepEqual(events, ["result", "close"]);
    assert.equal(resultText, "hi");
  });

  it("does not throw when the timeout fires with no error listener", async () => {
    const subprocess = new ClaudeSubprocess();
    const testable = subprocess as unknown as {
      buildArgs: (options: SubprocessOptions) => string[];
      armTimeout: (timeout: number) => void;
    };
    const buildRealArgs = testable.buildArgs.bind(subprocess);
    testable.buildArgs = (options) => [stallPath, ...buildRealArgs(options)];
    assert.equal(subprocess.listenerCount("error"), 0);

    // Spy so an uncaught throw from the timer is recorded instead of crashing the runner.
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => {
      uncaught.push(err);
    };
    process.on("uncaughtException", onUncaught);
    const closed = new Promise<number | null>((resolve) =>
      subprocess.once("close", resolve)
    );
    try {
      await subprocess.start("hello", {
        model: "claude-haiku-4-5",
        timeout: GENEROUS_REQUEST_TIMEOUT_MS,
      });
      testable.armTimeout(STALL_TIMEOUT_MS);
      await withTimeout(closed, "stalled fixture did not close after the timeout");

      assert.deepEqual(uncaught, [], "timeout must not throw without an error listener");
      assert.equal(subprocess.listenerCount("error"), 0);
    } finally {
      process.off("uncaughtException", onUncaught);
      // No-op once the fixture has exited; stops it if an assertion failed first.
      subprocess.kill();
    }
  });
});

describe("stdout decoding and early CLI exit", () => {
  // Plain fixtures again, so these run on every platform.
  const SPLIT_RESULT_TEXT = "é🙂";
  const LARGE_PROMPT_BYTES = 8 * 1024 * 1024;
  let fixtureDir: string;
  let utf8SplitPath: string;
  let earlyExitPath: string;
  let previousClaudeBin: string | undefined;

  before(async () => {
    previousClaudeBin = process.env.CLAUDE_BIN;
    fixtureDir = await mkdtemp(path.join(tmpdir(), "claude-decode-"));
    utf8SplitPath = path.join(fixtureDir, "utf8-split.cjs");
    earlyExitPath = path.join(fixtureDir, "early-exit.cjs");
    await writeFile(
      utf8SplitPath,
      [
        "process.stdin.resume();",
        'process.stdin.on("end", () => {',
        `  const line = JSON.stringify({type:"result",subtype:"success",is_error:false,result:${JSON.stringify(SPLIT_RESULT_TEXT)},session_id:"s",duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}}) + "\\n";`,
        '  const buf = Buffer.from(line, "utf8");',
        // Cut two bytes into the 4-byte emoji, so its bytes arrive in two chunks.
        '  const cut = buf.indexOf(Buffer.from("🙂", "utf8")) + 2;',
        "  process.stdout.write(buf.subarray(0, cut));",
        "  setTimeout(() => process.stdout.write(buf.subarray(cut)), 50);",
        "});",
      ].join("\n"),
      "utf8"
    );
    await writeFile(earlyExitPath, "process.exit(1);\n", "utf8");

    process.env.CLAUDE_BIN = process.execPath;
  });

  after(async () => {
    restoreEnvironmentVariable("CLAUDE_BIN", previousClaudeBin);
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("decodes a multi-byte character split across stdout chunks and emits no raw line", async () => {
    const subprocess = new ClaudeSubprocess();
    const testable = subprocess as unknown as {
      buildArgs: (options: SubprocessOptions) => string[];
    };
    const buildRealArgs = testable.buildArgs.bind(subprocess);
    testable.buildArgs = (options) => [utf8SplitPath, ...buildRealArgs(options)];

    const events: string[] = [];
    let resultText: unknown;
    const rawLines: string[] = [];
    subprocess.on("result", (result: { result?: unknown }) => {
      events.push("result");
      resultText = result.result;
    });
    subprocess.on("raw", (line: string) => {
      rawLines.push(line);
    });
    subprocess.on("error", () => {
      events.push("error");
    });
    const closed = new Promise<void>((resolve) =>
      subprocess.once("close", () => {
        events.push("close");
        resolve();
      })
    );

    await subprocess.start("hello", {
      model: "claude-haiku-4-5",
      timeout: GENEROUS_REQUEST_TIMEOUT_MS,
    });
    await withTimeout(closed, "split UTF-8 fixture did not close");

    assert.deepEqual(events, ["result", "close"]);
    assert.equal(resultText, SPLIT_RESULT_TEXT);
    assert.deepEqual(rawLines, [], "valid JSON must not be emitted as raw");
  });

  it("emits close without crashing when the CLI exits before reading a large prompt", async () => {
    const subprocess = new ClaudeSubprocess();
    const testable = subprocess as unknown as {
      buildArgs: (options: SubprocessOptions) => string[];
    };
    const buildRealArgs = testable.buildArgs.bind(subprocess);
    testable.buildArgs = (options) => [earlyExitPath, ...buildRealArgs(options)];

    const events: string[] = [];
    subprocess.on("error", () => {
      events.push("error");
    });
    const closed = new Promise<number | null>((resolve) =>
      subprocess.once("close", (code: number | null) => {
        events.push("close");
        resolve(code);
      })
    );

    // The fixture never reads stdin, so writing this prompt hits EPIPE.
    // The stdin error listener must absorb it; an unhandled error would crash the runner.
    await subprocess.start("x".repeat(LARGE_PROMPT_BYTES), {
      model: "claude-haiku-4-5",
      timeout: GENEROUS_REQUEST_TIMEOUT_MS,
    });
    const code = await withTimeout(closed, "early-exiting CLI did not emit close");

    assert.ok(events.includes("close"));
    assert.equal(code, 1);
  });
});

function trackChild(child: ChildProcess, cleanupPids: Set<number>): number {
  const pid = child.pid;
  assert.equal(typeof pid, "number", "fixture root did not receive a PID");
  cleanupPids.add(pid as number);
  return pid as number;
}

function trackManagerProcess(
  subprocess: ClaudeSubprocess,
  cleanupPids: Set<number>
): number {
  const managed = subprocess as unknown as { process: ChildProcess | null };
  assert.ok(managed.process, "manager did not retain its root process");
  return trackChild(managed.process, cleanupPids);
}

function readManagerDescendantPid(subprocess: ClaudeSubprocess): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve, reject) => {
      subprocess.on("message", (message: { descendantPid?: number }) => {
        if (typeof message.descendantPid !== "number") {
          reject(new Error("manager fixture reported an invalid descendant PID"));
          return;
        }
        resolve(message.descendantPid);
      });
    }),
    "manager fixture did not report its descendant PID"
  );
}

function readDescendantPid(parent: ChildProcess): Promise<number> {
  return withTimeout(
    new Promise<number>((resolve, reject) => {
      let stdout = "";
      parent.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const newline = stdout.indexOf("\n");
        if (newline !== -1) {
          try {
            const message = JSON.parse(stdout.slice(0, newline)) as {
              descendantPid?: number;
            };
            if (typeof message.descendantPid !== "number") {
              reject(new Error("fixture reported an invalid descendant PID"));
              return;
            }
            resolve(message.descendantPid);
          } catch (error) {
            reject(error);
          }
        }
      });
      parent.once("error", reject);
    }),
    "direct-child fixture did not report its descendant PID"
  );
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return withTimeout(
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    "direct child did not exit"
  );
}

async function waitForProcessToStop(pid: number): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} was still alive after ${WAIT_TIMEOUT_MS}ms`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateTree(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  const taskkill = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "taskkill.exe")
    : "taskkill.exe";
  const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return false;
  return waitForProcessToStopWithoutAssertion(pid);
}

async function cleanupTrackedProcesses(cleanupPids: Set<number>): Promise<void> {
  for (const pid of [...cleanupPids]) {
    if (await terminateTree(pid)) {
      cleanupPids.delete(pid);
    }
  }
}

async function waitForProcessToStopWithoutAssertion(pid: number): Promise<boolean> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessAlive(pid);
}

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
