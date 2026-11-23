# Resolve the Windows `.exe` and kill the process tree

- **Status:** Accepted, with known issues
- **Introduced:** d39204e, 2026-08-08, AndySian (`.exe` lookup); 1322117, 2026-08-10, AndySian (tree kill)

## Context

- On Windows the global `claude` command is an npm `.cmd` shim that runs a bundled `claude.exe`.
- Running a `.cmd` needs `shell: true`, so cmd.exe parses the arguments. The appended system prompt contains `< > ( ) &`, which cmd.exe reads as redirection and chaining. Later arguments are corrupted, including `--session-id` and `--resume`, so sessions silently stop working.
- Killing a child process signals only that process. The CLI's Bash tool subprocesses kept running after a disconnect or timeout.

## Decision

- On Windows, run `where.exe claude`, read the `.cmd` shim, extract the `%dp0%\...exe` path, and spawn that `.exe` without a shell. Cache the result for the life of the process.
- If the `.exe` is not found, fall back to `claude` with a shell.
- `CLAUDE_BIN` overrides everything and is never cached.
- On Windows, kill with `taskkill /PID <pid> /T /F`, run by absolute path under `SystemRoot`. If taskkill fails, the process is not marked killed, so callers can retry.
- On macOS and Linux, signal the direct child only.

## Consequences

- **Good:** sessions work on Windows, and killing a request also stops its tool subprocesses.
- **Bad:**
  - The shell fallback is unsafe if a request ever supplies an argument. It is not exploitable today, because the server sets every argument (Windows fallback row of the [bad-coding-practices review](../security-review/bad-coding-practices.md)).
  - The lookup depends on the shim's text format. An npm change breaks it, and the fallback then applies silently.
  - The result is cached for the life of the process, so a CLI upgrade that moves the `.exe` needs a restart.
  - If taskkill fails, the root may stop while its children keep running, and the request still reports an error.
  - The process-tree tests run only on Windows, so macOS and Linux are unchecked.

## Affected components

The subprocess manager: CLI binary lookup and its cache, the process-tree kill, and the explicit-kill and timeout paths that use it. Also the Windows-only subprocess manager tests.

## Revisit when

- The npm package changes its shim or install layout.
- Any request field can become a CLI argument. Recommended: remove the shell fallback first and fail the request instead.
- The tests get a Windows CI job. Recommended: add it before the next change here.
- Taskkill failures happen in practice. Recommended: return them to the caller as errors.
