# Spawn one CLI process per request

- **Status:** Accepted, with known issues
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal

## Context

The CLI runs in `--print` mode. It takes one prompt, writes its output and exits. The proxy has to map each HTTP request to one CLI run (`src/subprocess/manager.ts:194-291`). Old `DESIGN.md` planned a pool with `maxConcurrent: 3` (old `DESIGN.md:761`). That was never built.

## Decision

Each request creates a new `ClaudeSubprocess` and spawns `claude` (`src/server/routes.ts:83`). There is no pool, no queue and no concurrency limit. Details:

- `spawn()` runs with `shell: false` on macOS and Linux, so no shell parses the arguments. The Windows fallback uses `shell: true` when it cannot resolve the `.exe` (`manager.ts:136-146`).
- The prompt goes to stdin, not argv, to avoid `E2BIG` on large inputs (`manager.ts:240-242`).
- The environment is `process.env` minus `CLAUDECODE` (`manager.ts:217-219`). The proxy can then start inside a Claude Code session, where the CLI would otherwise refuse to nest.
- `cwd` is `process.cwd()` (`manager.ts:216`). No caller sets it.
- A 15-minute timeout kills the process (the whole tree only on Windows) (`manager.ts:48`).
- When the request has `user`, the CLI session is resumed with `--resume` (`manager.ts:311-316`). The session IDs live in an in-memory map with a 6-hour TTL (`session-store.ts:14-17`).
- Every run passes `--dangerously-skip-permissions` (`manager.ts:298`; see [skip-cli-permission-prompts.md](skip-cli-permission-prompts.md)).

## Consequences

- **Good:** Runs are simple to reason about. A failed run ends with its own request. Apart from the session map, no state is shared between runs. Resume avoids replaying history ([resume-cli-sessions-keyed-by-user.md](resume-cli-sessions-keyed-by-user.md)).
- **Bad:** Each request pays a cold start (CLI boot and system prompt). Concurrent processes are unbounded. A streaming client that disconnects kills the CLI (`routes.ts:152-156`). A non-streaming client that disconnects does not, because that path has no close handler (`routes.ts:358`), so the CLI keeps running. Every run skips permission prompts.

## Where in the code

- `src/server/routes.ts:60-105`: `handleChatCompletions` creates the subprocess and picks streaming or non-streaming.
- `src/subprocess/manager.ts:194-291`: `start()` sets cwd, env, shell flag and the stdin write.
- `src/subprocess/manager.ts:136-146`: `resolveClaudeBin()` chooses the shell flag.
- `src/subprocess/manager.ts:295-324`: `buildArgs()`, including resume and session flags.
- `src/subprocess/manager.ts:48`: default timeout.
- `src/subprocess/session-store.ts:14-17`: session TTL and the in-memory map.

## Revisit when

- Load grows enough to need a bounded pool or queue, the `maxConcurrent` idea from old `DESIGN.md`.
- Cold-start latency becomes a problem for clients.
- The CLI offers a long-running or stream-json input mode that avoids a spawn per request.
- Non-streaming disconnects need to kill the CLI.
