# Spawn one CLI process per request

- **Status:** Accepted, with known issues
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal
- **Revised:** 2026-11-27

## Context

The CLI runs in `--print` mode. It takes one prompt, writes its output and exits, so the proxy maps each HTTP request to one CLI run. Old `DESIGN.md` planned a pool with `maxConcurrent: 3`. That was never built.

## Decision

Each request spawns its own `claude` process. There is no pool, no queue and no concurrency limit. Details:

- No shell on macOS and Linux, so no shell parses the arguments. The Windows fallback uses a shell when it cannot resolve the `.exe`.
- The prompt goes to stdin, not argv, to avoid `E2BIG` on large inputs.
- The environment is the proxy's minus `CLAUDECODE`. The proxy can then start inside a Claude Code session, where the CLI would otherwise refuse to nest.
- The working directory is a fixed folder under the OS temp directory, created if missing, not the proxy's own. No caller sets it. The fixed location keeps the CLI's session files in one place, so `--resume` works for sessions the proxy still holds.
- Every run uses the plain-LLM flags: `--tools ""` (no built-in tools), `--strict-mcp-config` (no MCP servers from settings), `--safe-mode` (no CLAUDE.md, skills, plugins or hooks), and `--system-prompt` with the proxy's own prompt in place of Claude Code's default. The conversation itself goes on stdin ([flatten-messages-into-one-prompt](flatten-messages-into-one-prompt.md)).
- A 15-minute timeout kills the process (the whole tree only on Windows).
- When the request has `user`, the CLI session is resumed with `--resume` ([resume-cli-sessions-keyed-by-user](resume-cli-sessions-keyed-by-user.md)).
- Every run passes `--dangerously-skip-permissions` ([skip-cli-permission-prompts](skip-cli-permission-prompts.md)).

## Consequences

- **Good:** Runs are simple to reason about. A failed run ends with its own request. Apart from the session map, no state is shared between runs. Resume avoids replaying history.
- **Bad:**
  - Each request pays a cold start (CLI boot and system prompt).
  - Concurrent processes are unbounded.
  - A client that disconnects kills the CLI, on streaming and non-streaming requests alike, so that run's output is lost.
  - Every run skips permission prompts.
  - The CLI still adds an account-context block (the logged-in account's email) that the plain-LLM flags do not remove.

## Affected components

The chat completions handler, which creates one subprocess per request, and the subprocess manager: spawn options (working directory, environment, shell choice), the stdin write, argument building and the timeout.

## Revisit when

- Load grows enough to need a bounded pool or queue, the `maxConcurrent` idea from old `DESIGN.md`.
- Cold-start latency becomes a problem for clients.
- The CLI offers a long-running or stream-json input mode that avoids a spawn per request.
