# Resolve the Windows `.exe` and kill the process tree

- **Status:** Accepted, with known issues
- **Introduced:** d39204e, 2026-08-08, AndySian (`.exe` lookup); 1322117, 2026-08-10, AndySian (tree kill)

## Context

- On Windows the global `claude` command is an npm `.cmd` shim that runs a bundled `claude.exe`.
- Running a `.cmd` needs `shell: true`, so cmd.exe parses the arguments. The appended system prompt contains `< > ( ) &`, which cmd.exe reads as redirection and chaining. Later arguments are corrupted, including `--session-id` and `--resume`, so sessions silently stop working.
- `ChildProcess.kill()` signals only the direct child. The CLI's Bash tool subprocesses kept running after a disconnect or timeout.

## Decision

- On Windows, run `where.exe claude`, read the `.cmd` shim, extract the `%dp0%\...exe` path, and spawn that `.exe` with `shell: false`. Cache the result (`src/subprocess/manager.ts:118-135`).
- If the `.exe` is not found, fall back to `claude` with `shell: true` (`src/subprocess/manager.ts:140-141`).
- `CLAUDE_BIN` overrides everything and is never cached (`src/subprocess/manager.ts:110-114`).
- On Windows, kill with `taskkill /PID <pid> /T /F` by absolute path under `SystemRoot`. If taskkill fails, `isKilled` stays false so callers can retry (`src/subprocess/manager.ts:164-184`).
- On macOS and Linux, signal the direct child only (`src/subprocess/manager.ts:186-191`).

## Consequences

- **Good:** sessions work on Windows, and killing a request also stops its tool subprocesses.
- **Bad:**
  - The `shell: true` fallback is unsafe if a request ever supplies an argument. It is not exploitable today, because the server sets every argument (`docs/security-review/bad-coding-practices.md`, Windows fallback row).
  - The lookup depends on the shim's text format. An npm change breaks the regex, and the fallback then applies silently.
  - The result is cached for the life of the process, so a CLI upgrade that moves the `.exe` needs a restart.
  - If taskkill fails, the root may stop while its children keep running, and the request still reports an error.
  - The tests run only on Windows (`src/subprocess/manager.test.ts:14`), so macOS and Linux are unchecked.

## Where in the code

- `src/subprocess/manager.ts:94-146`: `resolveClaudeBin()` and its cache.
- `src/subprocess/manager.ts:157-192`: `killProcessTree()`.
- `src/subprocess/manager.ts:386-407`: `kill()` and the timeout path, both of which call `killProcessTree()`.
- `src/subprocess/manager.test.ts:14`: Windows-only suite, including "kills the full process tree when kill() is called" and "keeps isKilled false when taskkill cannot launch".

## Revisit when

- The npm package changes its shim or install layout.
- Any request field can become a CLI argument. Recommended: remove the `shell: true` fallback first and fail the request instead.
- The tests get a Windows CI job. Recommended: add it before the next change here.
- Taskkill failures happen in practice. Recommended: return them to the caller as errors.
