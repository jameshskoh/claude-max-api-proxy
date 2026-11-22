# Insecure coding practices and usage gotchas

> **Version reviewed:** commit `3e88f2fb98835385bd8d3dcc25ed54e09389a095` (`main`, committed 2026-08-16, `package.json` version `1.0.0`).
> All `file:line` references refer to that commit. Later versions may differ, so re-check before relying on this report.

Scope: the whole codebase at that commit.
Method: one broad vulnerability sweep, then a separate false-positive check for each candidate. Only findings scored 8/10 or higher count as formal vulnerabilities.

## Formal vulnerability filter

| Candidate | False-positive check | Reported? |
|---|---|---|
| Any website can drive the API from your browser (CORS `*`) | True positive, 7/10 | Below the 8 cutoff. Confirmed by manual code review; see item 1 below. |
| Other local processes can use the API without auth | 4/10 | No. Personal, loopback-only setup. |
| Prompt injection through forwarded content | False positive, 2/10 | No. Every agent that reads untrusted text has this risk. |
| One caller resuming another's session via `user` | False positive | No. There are no separate callers, and every caller can already read the transcripts. |
| Full environment passed to the CLI | False positive, 2/10 | No. Standard behaviour for a wrapper. |

## 1. Any web page you visit can likely run commands on your computer (the one to act on)

- **Category:** CORS misconfiguration / CSRF / DNS rebinding, leading to command execution.
- **Where:**
  - `src/server/index.ts:61-66`: `Access-Control-Allow-Origin: *`, with `Content-Type` and `Authorization` allowed.
  - `src/server/index.ts:69-71`: every browser preflight check (OPTIONS) is answered with 200.
  - `src/server/index.ts:74-76`: the routes have no auth.
  - No `Host` or `Origin` check anywhere.
  - `src/subprocess/manager.ts:298`: `--dangerously-skip-permissions`.
- **How it works:**
  1. A page sends `fetch("http://127.0.0.1:3456/v1/chat/completions", {method:"POST", headers:{"Content-Type":"application/json"}, body:…})`.
  2. The browser's preflight check passes because of the `*`.
  3. `messages[].content` becomes the prompt word for word (`src/adapter/openai-to-cli.ts:108-141`) and goes to the CLI's stdin.
  4. The CLI runs Bash, Read, Write and WebFetch without asking for approval.
  5. The output comes back as JSON (`routes.ts:372-378`). The `*` header lets the page read it.
  6. Only `messages` is required (`routes.ts:70-79`); `model` defaults to opus.
- **Impact:** a malicious or compromised site can read files such as `~/.ssh` keys, change shell rc files, send data out, and use up your subscription.
- **Reach:** the CLI runs in `process.cwd()` (`manager.ts:216`), which is `/` under launchd unless the plist sets one. Absolute paths work anyway, so the reach is your whole user account.
- **What limits it:** newer Chrome versions block or prompt before a public site can reach localhost, and this server never sends the `Access-Control-Allow-Private-Network` header Chrome asks for. Safari and Firefox enforce this less consistently. DNS rebinding works because `Host` is never checked. **Not tested in a browser.**
- **Code fixes:**
  1. Remove the `*` header; this API is for non-browser clients.
  2. Reject any `Host` other than `127.0.0.1:3456` or `localhost:3456`.
  3. Add a bearer-token check before the routes.
  4. Replace `--dangerously-skip-permissions` with `--allowedTools`/`--disallowedTools`, and give the CLI a fixed empty working directory.

## 2. Other insecure practices (lower severity)

| Location | Issue |
|---|---|
| `src/server/index.ts:74-76`, `src/index.ts:158` | No auth. Clients are told to send `apiKey: "local"`, which the server never checks. Any local process or OS user that can reach port 3456 gets a command line as you. |
| `src/subprocess/manager.ts:298` | Permissions are always skipped, with no tool allowlist. |
| `src/subprocess/manager.ts:55-92, 305-306` | The OpenClaw system prompt is added to every request even if you don't use OpenClaw. It names `message send`, `cron add` and `nodes run`. |
| `src/subprocess/manager.ts:216` | The CLI runs in `process.cwd()` rather than a fixed empty directory. |
| `src/subprocess/manager.ts:217-219` | The whole parent environment is passed to the CLI (secrets, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`). |
| `src/server/routes.ts:39-52`, `src/subprocess/session-store.ts:17,34-42` | Sessions are keyed by the client-supplied `user` string, so two clients sending the same value share one Claude session. This is a correctness problem in a single-user setup, but it would be a security problem if the proxy were shared. |
| `src/server/index.ts:90-98`, `routes.ts:92-101, 313-317, 394-400` | Raw `err.message` (spawn errors, file paths) is returned to callers. |
| `src/server/index.ts:29-38`, `manager.ts:206-208, 259-266` | `DEBUG` / `DEBUG_SUBPROCESS` log prompt fragments and the full CLI arguments. |
| `src/session/manager.ts:20-23, 163` | If imported as a library, it writes `~/.claude-code-cli-sessions.json` with default permissions, falls back to `/tmp` if `HOME` is unset, and starts a timer that keeps the process running. It isn't used when running the server. |
| `src/adapter/openai-to-cli.ts:40-51` | The `MODEL_MAP` lookup isn't protected against prototype keys: `model: "constructor"` puts a non-string into the CLI arguments. It can't inject flags (one argument, `shell:false`). Fix with `Object.hasOwn`. |
| `src/subprocess/manager.ts:140` | The Windows fallback uses `shell:true` and joins arguments without quoting. It isn't exploitable today, because every argument is set by the server, but any future argument taken from a request would allow command injection. Doesn't apply on macOS. |
| `src/subprocess/manager.ts:454-464` | `verifyAuth` always returns ok, so the server starts even when you're logged out of Claude. |
| `src/server/routes.ts:65` | A JSON `null` body throws outside `try`, causing an unhandled rejection that ends the process. launchd restarts it (availability only). |
| `docs/macos-setup.md:33-37` | Logs go to `/tmp`, where other local users can read them. |
| `README.md:220-225` | The "Security" section doesn't mention the lack of auth, the CORS `*` or the skipped permissions. It also says prompts are passed as CLI arguments, which is out of date; they go through stdin. |

## 3. Gotchas if you don't change the code

1. **Only run the service while you need it.**
   - Stop it with `launchctl bootout gui/$(id -u)/com.openclaw.claude-max-proxy`.
   - While it's running, treat every open browser tab as able to reach it.
   - Use a separate browser profile, or Chrome with local-network access blocked, for untrusted sites.
2. **Never expose port 3456 beyond loopback.**
   - That means no `0.0.0.0`, reverse proxy, ngrok or Tailscale Funnel, or Docker `-p`.
   - The default bind is 127.0.0.1 (`src/server/index.ts:108`). Check with `lsof -iTCP:3456 -sTCP:LISTEN`.
3. **Don't send untrusted text through the proxy.**
   - That includes chat-bot messages, scraped pages and email.
   - The agent will follow hidden instructions with Bash and WebFetch without asking you, and with `openclaw` if it's installed.
4. **Keep the launch environment minimal.**
   - Set only `HOME` and `PATH`, plus the telemetry switches in `telemetry.md`.
   - Make sure `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` are not set.
5. **Set `WorkingDirectory` in the plist** to an empty folder (e.g. `~/claude-proxy-sandbox`). It doesn't sandbox the agent, but it stops it starting from `/` or your home folder.
6. **Logs:** keep `DEBUG` and `DEBUG_SUBPROCESS` off, and keep logs outside `/tmp`.
7. **Installing:** use `npm ci --ignore-scripts`, then run `npm audit signatures` and `npm ls clawdbot`; the last should come back empty.
8. **Give each client its own `user` value**, or leave it out, so conversations don't get mixed together.
9. **Check your installed plist.** `~/Library/LaunchAgents/com.openclaw.claude-max-proxy.plist` wasn't present when this review ran. Review whatever plist you actually use for unexpected environment variables.
10. **For a stronger setup,** run the proxy as a separate low-privilege OS user, or in a VM or container, so a successful attack can't reach your main account's files.
