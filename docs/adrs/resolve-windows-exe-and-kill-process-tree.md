# Resolve the Windows `.exe` and kill the process tree

- **Status:** Accepted, with known issues
- **Introduced:** d39204e, 2026-08-08, AndySian (`.exe` lookup); 1322117, 2026-08-10, AndySian (tree kill)
- **Revised:** 2026-11-27

## Context

- On Windows the global `claude` command is an npm `.cmd` shim that runs a bundled `claude.exe`.
- Running a `.cmd` needs `shell: true`, so cmd.exe parses the arguments. The appended system prompt contains `< > ( ) &`, which cmd.exe reads as redirection and chaining. Later arguments are corrupted, including `--session-id` and `--resume`, so sessions silently stop working.
- Killing a child process signals only that process. The CLI's Bash tool subprocesses kept running after a disconnect or timeout.

## Decision

- On Windows, run `where.exe claude`, read the `.cmd` shim, extract the `%dp0%\...exe` path, and spawn that `.exe`. Cache a successful result for the life of the process; a failure is retried on the next call.
- If the `.exe` cannot be found, fail with an error that tells the operator to set `CLAUDE_BIN` to the full path of `claude.exe`. The CLI is never run through a shell, so there is no fallback to the shim.
- `CLAUDE_BIN` overrides everything and is never cached.
- On Windows, kill with `taskkill /PID <pid> /T /F`, run by absolute path under `SystemRoot`. If taskkill fails, the process is not marked killed, so callers can retry.
- On macOS and Linux, signal the direct child only.

## Consequences

- **Good:** sessions work on Windows, killing a request also stops its tool subprocesses, and no request text reaches a shell on any platform.
- **Bad:**
  - The lookup depends on the shim's text format. An npm change breaks it, and the proxy then fails with a clear error until `CLAUDE_BIN` is set.
  - The result is cached for the life of the process, so a CLI upgrade that moves the `.exe` needs a restart.
  - If taskkill fails, the root may stop while its children keep running, and the request still reports an error.
  - The process-tree tests run only on Windows, so macOS and Linux are unchecked.

## Affected components

The subprocess manager: CLI binary lookup and its cache, the process-tree kill, and the explicit-kill and timeout paths that use it. The startup check and the request paths that report a failed lookup. Also the Windows-only subprocess manager tests.

## Revisit when

- The npm package changes its shim or install layout.
- The tests get a Windows CI job. Recommended: add it before the next change here.
- Taskkill failures happen in practice. Recommended: return them to the caller as errors.
