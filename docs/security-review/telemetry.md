# Telemetry / phone-home review

> **Version reviewed:** commit `3e88f2fb98835385bd8d3dcc25ed54e09389a095` (`main`, committed 2026-08-16, `package.json` version `1.0.0`).
> All `file:line` references refer to that commit. Later versions may differ, so re-check before relying on this report.

Scope: the whole codebase at that commit.

## Verdict

**The proxy code itself makes no outbound network calls.**

- It has no fetch, http client, analytics or crash-reporting library.
- `express` and `uuid` don't phone home.
- The only `fetch` calls are in `src/e2e.test.ts:42-168`, and they go to 127.0.0.1.
- The URLs in `package.json:35-40` are package metadata only.

The only outbound traffic comes from the `claude` CLI that the proxy launches.

## 1. Data you knowingly send

### Prompts and responses go to Anthropic
- **What is sent:** every message in the request: system, user and assistant turns.
- **How:** the messages are combined into one prompt (`src/adapter/openai-to-cli.ts:108-146`) and written to the CLI's stdin (`src/subprocess/manager.ts:241-242`).
- **Also sent:** the fixed OpenClaw system prompt (`manager.ts:55-92`) is added to every request.
- **Can it be disabled?** No. This is how the proxy uses your subscription.

### Claude Code CLI telemetry and error reporting
- **The proxy neither enables nor disables these.**
- It passes its whole environment to the CLI, minus `CLAUDECODE` (`manager.ts:217-219`), so you can turn them off with environment variables in the LaunchAgent plist:

  ```xml
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/Users/you</string>
    <key>PATH</key><string>...</string>
    <!-- turns off telemetry, error reporting, auto-update checks and other non-essential traffic -->
    <key>CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC</key><string>1</string>
    <!-- or set them separately: -->
    <key>DISABLE_TELEMETRY</key><string>1</string>
    <key>DISABLE_ERROR_REPORTING</key><string>1</string>
    <key>DISABLE_AUTOUPDATER</key><string>1</string>
  </dict>
  ```

  Reload afterwards:

  ```bash
  launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist
  ```

  The variable names come from Claude Code's documented settings. The CLI code isn't in this repo, so I couldn't verify its behaviour here.

## 2. Data that could be sent without you choosing it

### Agent tool use
- The CLI runs with `--dangerously-skip-permissions` (`manager.ts:298`) and no tool allowlist.
- So the model can send data out without asking you, through:
  - `WebFetch` or `WebSearch`;
  - `curl` or similar via `Bash`;
  - `openclaw message send --to <target>` (Telegram/Discord), if `openclaw` is installed and set up. The system prompt at `manager.ts:74` names this command.
- This happens only if a prompt tells it to. Such a prompt could come from any website through the CORS hole (see `bad-coding-practices.md`), or be hidden in content you forward to the proxy.
- **How to prevent it:** stop the service when you're not using it, and don't send untrusted content through it. In code: replace the flag with `--allowedTools`/`--disallowedTools` and fix CORS.

### Environment passed through
- **`ANTHROPIC_BASE_URL`:** if it is set in the proxy's environment, every prompt goes to that host instead of Anthropic.
- **`ANTHROPIC_API_KEY`:** if it is set, usage may be billed to that API key instead of your subscription.
- **Fix:** keep the launch environment minimal. The setup doc's plist (`docs/macos-setup.md:39-45`) sets only `HOME` and `PATH`, which is good.

### Dependencies
- About 82 packages, all HTTP and utility libraries from the express 4 tree, plus uuid and typescript/`@types`.
- None are network clients or telemetry SDKs, and none have install scripts.
- The optional peer `clawdbot` is not installed. If you use the OpenClaw/Clawdbot host app, it may have its own telemetry, which is outside this repo.

## 3. Local-only data (never leaves the machine)

| What | Where | Notes |
|---|---|---|
| Claude session transcripts | `~/.claude/projects/` | Saved when a request includes `user` (`routes.ts:39-52`, `manager.ts:310-316`). Requests without `user` use `--no-session-persistence`. |
| Prompt fragments in logs | stdout/stderr → launchd log files | Only when `DEBUG` is set (first 200–300 characters of each request body: `src/server/index.ts:29-38`) or `DEBUG_SUBPROCESS` is set (full CLI arguments and the first 200 characters of the prompt: `manager.ts:206-208`). Off by default. |
| Error messages | logs | Only `err.message` by default. JSON parse errors log just the length, method and URL. `Authorization` is never logged. |
| Session ID map | `~/.claude-code-cli-sessions.json` | Written only if `src/session/manager.ts` is imported as a library, not when running the server. Contains IDs only. |

**Log location:** `docs/macos-setup.md:33-37` uses `/tmp/claude-provider*.log`, which other local users can read. `~/.openclaw/logs/` (from CLAUDE.md) or `~/Library/Logs/` is better.

## Checklist
- [ ] Add `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` to the plist's `EnvironmentVariables` and reload.
- [ ] Make sure `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` are not in the plist environment.
- [ ] Keep `DEBUG` and `DEBUG_SUBPROCESS` unset.
- [ ] Run `which openclaw`. If it's installed, check which channels and nodes it can reach.
- [ ] Keep logs outside `/tmp`.
