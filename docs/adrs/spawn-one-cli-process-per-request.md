# Spawn one CLI process per request

- **Status:** Accepted, with known issues
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal
- **Revised:** 2026-11-23

## Context

The CLI runs in `--print` mode. It takes one prompt, writes its output and exits, so the proxy maps each HTTP request to one CLI run. Old `DESIGN.md` planned a pool with `maxConcurrent: 3`. That was never built.

## Decision

Each request spawns its own `claude` process. There is no pool, no queue and no concurrency limit. Details:

- No shell on macOS and Linux, so no shell parses the arguments. The Windows fallback uses a shell when it cannot resolve the `.exe`.
- The prompt goes to stdin, not argv, to avoid `E2BIG` on large inputs.
- The environment is the proxy's minus `CLAUDECODE`. The proxy can then start inside a Claude Code session, where the CLI would otherwise refuse to nest.
- The working directory is a fixed folder under the OS temp directory, created if missing, not the proxy's own. No caller sets it. Claude Code loads project context (CLAUDE.md, git state) from the working directory and its parents, so a folder outside any project keeps the repo's context out of every request. User-level context (global rules, skills, MCP servers) still loads. The fixed location keeps the CLI's session files in one place, so `--resume` works for sessions the proxy still holds.
- A 15-minute timeout kills the process (the whole tree only on Windows).
- When the request has `user`, the CLI session is resumed with `--resume` ([resume-cli-sessions-keyed-by-user](resume-cli-sessions-keyed-by-user.md)).
- Every run passes `--dangerously-skip-permissions` ([skip-cli-permission-prompts](skip-cli-permission-prompts.md)).

## Consequences

- **Good:** Runs are simple to reason about. A failed run ends with its own request. Apart from the session map, no state is shared between runs. Resume avoids replaying history.
- **Bad:**
  - Each request pays a cold start (CLI boot and system prompt).
  - Concurrent processes are unbounded.
  - A streaming client that disconnects kills the CLI. A non-streaming client that disconnects does not, because that path has no close listener, so the CLI keeps running.
  - Every run skips permission prompts.

## Affected components

The chat completions handler, which creates one subprocess per request, and the subprocess manager: spawn options (working directory, environment, shell choice), the stdin write, argument building and the timeout.

## Revisit when

- Load grows enough to need a bounded pool or queue, the `maxConcurrent` idea from old `DESIGN.md`.
- Cold-start latency becomes a problem for clients.
- The CLI offers a long-running or stream-json input mode that avoids a spawn per request.
- Non-streaming disconnects need to kill the CLI.
