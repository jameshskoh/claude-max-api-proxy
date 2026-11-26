# Claude Max API Proxy

OpenAI-compatible API proxy that wraps the Claude Code CLI.

## Build

```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode for development
```

## Service Management

The proxy is run by hand in a terminal, listening on http://127.0.0.1:3456. It is not a background service.

```bash
npm run build    # after any source change
npm run start    # runs dist/server/standalone.js
```

- All logs (stdout and stderr) go to that terminal.
- Stop with Ctrl+C.
- Restart: Ctrl+C, rebuild if the source changed, then `npm run start` again.
- Debug logging is off by default. Set `DEBUG` (request lines) or `DEBUG_SUBPROCESS` (CLI spawn args and prompt prefixes) to any non-empty value before `npm run start`; both log prompt fragments.
- For an optional macOS LaunchAgent that auto-starts the proxy, see the "Running as a macOS LaunchAgent" section in `docs/WORKFLOW.md`.

## Docs — read before scoping a task

- `docs/ARCHITECTURE.md` - Component map (the one place that maps components to files), interfaces (HTTP and CLI), the **Task → components** table, and sharp edges. Start here to decide which components a task touches.
- `docs/WORKFLOW.md` - Runtime flows (startup, request, subprocess events, streaming, sessions, timeouts), dev loop, tests, LaunchAgent setup.
- `docs/adrs/README.md` - Index and convention for design decisions. Read the matching ADR before changing that behaviour.
- `docs/security-review/` - Security, telemetry and malicious-code review of commit `3e88f2f`.
