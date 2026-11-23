# Claude Max API Proxy

OpenAI-compatible API proxy that wraps the Claude Code CLI.

## Build

```bash
npm run build    # Compile TypeScript
npm run dev      # Watch mode for development
```

## Service Management

The proxy runs as a macOS LaunchAgent on port 3456.

**Plist location:** `~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist`

**Logs:**
- stdout: `~/.openclaw/logs/claude-max-proxy.log`
- stderr: `~/.openclaw/logs/claude-max-proxy.err.log`

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.openclaw.claude-max-proxy
```

### Stop the service

```bash
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy
```

### Start the service (after stop or plist change)

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist
```

### Reload after plist changes

```bash
launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist
```

### Check status

```bash
launchctl list com.openclaw.claude-max-proxy
```

## Docs — read before scoping a task

- `docs/ARCHITECTURE.md` - Component map (the one place that maps components to files), interfaces (HTTP and CLI), the **Task → components** table, and sharp edges. Start here to decide which components a task touches.
- `docs/WORKFLOW.md` - Runtime flows (startup, request, subprocess events, streaming, sessions, timeouts), dev loop, tests, LaunchAgent setup.
- `docs/adrs/README.md` - Index and convention for design decisions. Read the matching ADR before changing that behaviour.
- `docs/security-review/` - Security, telemetry and malicious-code review of commit `3e88f2f`.
