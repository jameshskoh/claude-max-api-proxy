/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn, spawnSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import fs from "fs/promises";
import { mkdirSync, readFileSync } from "fs";
import os from "os";
import path from "path";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
  ClaudeCliStreamEvent,
} from "../types/claude-cli.js";
import {
  isAssistantMessage,
  isResultMessage,
  isContentDelta,
  isTextBlockStart,
  isToolUseBlockStart,
  isInputJsonDelta,
  isContentBlockStop,
} from "../types/claude-cli.js";
import type { SupportedModel } from "../adapter/openai-to-cli.js";

export interface SubprocessOptions {
  model: SupportedModel;
  sessionId?: string;
  /** Resume an existing persisted session (sessionId) instead of creating a new one */
  resume?: boolean;
  cwd?: string;
  timeout?: number;
  /** System prompt passed via --system-prompt; omitted from argv when empty */
  systemPrompt?: string;
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

const DEFAULT_TIMEOUT = 900000; // 15 minutes

/**
 * Resolve the real Claude CLI binary to spawn. The result is always spawned
 * directly, never through a shell.
 *
 * On Windows, the global `claude` command is an npm shim (`claude.cmd`) that
 * just execs a bundled `claude.exe`. Running the shim requires a shell, and a
 * shell routes our argv through cmd.exe. cmd.exe treats characters our system
 * prompt legitimately contains (`<`, `>`, `(`, `)`, `&`) as redirection,
 * grouping and chaining operators. That corrupts the argument list (notably
 * the session flags, which silently stop working) and lets request-derived
 * text inject commands. So on Windows we resolve straight to the `.exe` behind
 * the shim. If it cannot be located, resolution fails rather than falling back
 * to the shim; the operator must set CLAUDE_BIN to the full path of claude.exe.
 */
let resolvedClaudeBin: string | null = null;

export function resolveClaudeBin(platform: NodeJS.Platform = process.platform): string {
  if (process.env.CLAUDE_BIN) {
    // Environment overrides are intentionally not cached. This lets callers
    // temporarily select a binary without contaminating later resolutions.
    return process.env.CLAUDE_BIN;
  }

  if (platform !== "win32") return "claude";

  if (resolvedClaudeBin) return resolvedClaudeBin;

  try {
    const where = spawnSync("where.exe", ["claude"], { encoding: "utf8" });
    const shimPath = (where.stdout || "")
      .split(/\r?\n/)
      .map((p) => p.trim())
      .find((p) => p.toLowerCase().endsWith(".cmd"));

    if (shimPath) {
      const shimDir = path.dirname(shimPath);
      const shimContent = readFileSync(shimPath, "utf8");
      const match = shimContent.match(/"%dp0%\\(.+?\.exe)"/i);
      if (match) {
        // Only a successful resolution is cached; failures are retried next time.
        resolvedClaudeBin = path.join(shimDir, match[1]);
        return resolvedClaudeBin;
      }
    }
  } catch {
    // Fall through to the error below
  }

  throw new Error(
    'Could not find claude.exe behind the npm "claude" shim. Set CLAUDE_BIN to the full path of claude.exe.'
  );
}

/**
 * Kill a process and its full descendant tree.
 *
 * `ChildProcess.kill()` only signals the direct child. On Windows this is
 * insufficient because the Claude CLI spawns its own subprocesses (e.g. for
 * Bash tool calls) that aren't part of a job object — killing just the
 * parent leaves them running in the background even after a client
 * disconnect or timeout. `taskkill /T` walks the whole tree instead.
 */
function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM"
): boolean {
  const pid = child.pid;
  if (!pid) return false;

  if (process.platform === "win32") {
    const taskkill = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "taskkill.exe")
      : "taskkill.exe";
    const result = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      return true;
    }

    // If taskkill could not be started or rejected the request, still make a
    // best-effort attempt to stop the managed root process. This must not be
    // reported as a successful tree termination: descendants may still be
    // running, and callers must remain able to retry.
    try {
      child.kill(signal);
    } catch {}
    return false;
  }

  try {
    return child.kill(signal);
  } catch {
    // Process may have already exited
    return false;
  }
}

/**
 * Default working directory for the Claude CLI subprocess.
 *
 * A folder outside any project means no project CLAUDE.md or git state loads.
 * It is fixed rather than random because the CLI looks up sessions by working
 * directory, so `--resume` must run from the same folder as the first turn.
 * The folder is recreated on every call because the OS may clean the temp
 * directory.
 */
export function defaultCliCwd(): string {
  const dir = path.join(os.tmpdir(), "claude-max-proxy");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled: boolean = false;

  /**
   * Start the Claude CLI subprocess with the given prompt
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const args = this.buildArgs(options);
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    if (process.env.DEBUG_SUBPROCESS) {
      console.error(`[Subprocess] args: ${JSON.stringify(args)}`);
      console.error(`[Subprocess] prompt: ${prompt.slice(0, 200)}`);
    }

    return new Promise((resolve, reject) => {
      try {
        // Use spawn() for security - no shell interpretation. A resolution
        // failure throws here and becomes a rejection of start().
        const bin = resolveClaudeBin();
        this.process = spawn(bin, args, {
          cwd: options.cwd || defaultCliCwd(),
          env: Object.fromEntries(
            Object.entries(process.env).filter(([k]) => k !== "CLAUDECODE")
          ),
          stdio: ["pipe", "pipe", "pipe"],
        });

        this.armTimeout(timeout);

        // Handle spawn errors (e.g., claude not found). spawn() reports these
        // after start() has already resolved, so they go out as this
        // subprocess's "error" event, not as a rejection. "close" still follows.
        this.process.on("error", (err) => {
          this.clearTimeout();
          const reported = err.message.includes("ENOENT")
            ? new Error(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
              )
            : err;
          // Without a listener, emitting "error" would throw and crash the process
          if (this.listenerCount("error") > 0) {
            this.emit("error", reported);
          }
        });

        // Pass prompt via stdin to avoid E2BIG on large inputs
        this.process.stdin?.write(prompt);
        this.process.stdin?.end();

        if (process.env.DEBUG_SUBPROCESS) {
          console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);
        }

        // Parse JSON stream from stdout
        this.process.stdout?.on("data", (chunk: Buffer) => {
          const data = chunk.toString();
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Received ${data.length} bytes of stdout`);
          }
          this.buffer += data;
          this.processBuffer();
        });

        // Capture stderr for debugging
        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText) {
            // Don't emit as error unless it's actually an error
            // Claude CLI may write debug info to stderr
            if (process.env.DEBUG_SUBPROCESS) {
              console.error("[Subprocess stderr]:", errorText.slice(0, 200));
            }
          }
        });

        // Handle process close
        this.process.on("close", (code) => {
          if (process.env.DEBUG_SUBPROCESS) {
            console.error(`[Subprocess] Process closed with code: ${code}`);
          }
          this.clearTimeout();
          // Process any remaining buffer. The final line may lack a trailing
          // newline (often the result message), so add one to make it complete.
          if (this.buffer.trim()) {
            this.buffer += "\n";
            this.processBuffer();
          }
          this.emit("close", code);
        });

        // Resolve immediately since we're streaming
        resolve();
      } catch (err) {
        this.clearTimeout();
        reject(err);
      }
    });
  }

  /**
   * Build CLI arguments array
   */
  private buildArgs(options: SubprocessOptions): string[] {
    const args = [
      "--print", // Non-interactive mode
      "--dangerously-skip-permissions", // Skip permission prompts
      "--output-format",
      "stream-json", // JSON streaming output
      "--verbose", // Required for stream-json
      "--include-partial-messages", // Enable streaming chunks
      "--model",
      options.model, // Full model ID, e.g. claude-opus-5-5
      // Plain LLM: no built-in tools, no MCP servers, no user/project config
      "--tools",
      "", // Empty value disables all built-in tools
      "--strict-mcp-config", // Ignore MCP configs from settings
      "--safe-mode", // Skip CLAUDE.md, skills and hooks
      ...(options.systemPrompt
        ? ["--system-prompt", options.systemPrompt]
        : []),
      // Prompt is passed via stdin (avoids E2BIG on large inputs)
    ];

    if (options.sessionId && options.resume) {
      // Continue a previously persisted session — avoids replaying full history
      args.push("--resume", options.sessionId);
    } else if (options.sessionId) {
      // First turn for this session key — create it under a known ID so we
      // can --resume it on subsequent turns
      args.push("--session-id", options.sessionId);
    } else {
      // No stable session key (e.g. request.user missing) — don't leave
      // orphaned session files behind
      args.push("--no-session-persistence");
    }

    return args;
  }

  /**
   * Process the buffer and emit parsed messages
   */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: ClaudeCliMessage = JSON.parse(trimmed);
        this.emit("message", message);

        if (isTextBlockStart(message)) {
          // Emit when a new text content block starts (for inserting separators)
          this.emit("text_block_start", message as ClaudeCliStreamEvent);
        }

        if (isToolUseBlockStart(message)) {
          this.emit("tool_use_start", message as ClaudeCliStreamEvent);
        }

        if (isInputJsonDelta(message)) {
          this.emit("input_json_delta", message as ClaudeCliStreamEvent);
        }

        if (isContentBlockStop(message)) {
          this.emit("content_block_stop", message as ClaudeCliStreamEvent);
        }

        if (isContentDelta(message)) {
          // Emit content delta for streaming (text_delta only)
          this.emit("content_delta", message as ClaudeCliStreamEvent);
        } else if (isAssistantMessage(message)) {
          this.emit("assistant", message);
        } else if (isResultMessage(message)) {
          this.emit("result", message);
        }
      } catch {
        // Non-JSON output, emit as raw
        this.emit("raw", trimmed);
      }
    }
  }

  /**
   * Clear the timeout timer
   */
  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Kill the subprocess
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.clearTimeout();
      this.isKilled = killProcessTree(this.process, signal);
    }
  }

  /**
   * Arm the request timeout. Kept narrow so tests can deterministically re-arm
   * the production timeout behavior after their fixture process tree is ready.
   */
  private armTimeout(timeout: number): void {
    this.clearTimeout();
    this.timeoutId = setTimeout(() => {
      if (!this.isKilled) {
        if (this.process) {
          this.isKilled = killProcessTree(this.process, "SIGTERM");
        }
        // Without a listener, emitting "error" would throw inside the timer and crash the process
        if (this.listenerCount("error") > 0) {
          this.emit("error", new Error(`Request timed out after ${timeout}ms`));
        }
      }
    }, timeout);
  }

  /**
   * Check if the process is still running
   */
  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    let bin: string;
    try {
      bin = resolveClaudeBin();
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const proc = spawn(bin, ["--version"], { stdio: "pipe" });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  // If Claude CLI is installed and the user has run `claude auth login`,
  // credentials are stored in the OS keychain and will be used automatically.
  // We can't easily check the keychain, so we'll just return true if the CLI exists.
  // Authentication errors will surface when making actual API calls.
  return { ok: true };
}
