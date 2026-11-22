# Malicious code review

> **Version reviewed:** commit `3e88f2fb98835385bd8d3dcc25ed54e09389a095` (`main`, committed 2026-08-16, `package.json` version `1.0.0`).
> All `file:line` references and commit hashes refer to that commit. Later versions may differ, so re-check before relying on this report.

Scope: the whole codebase at that commit: all `src/**/*.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, the docs, and the full git history.
Method: one broad sweep, then a separate follow-up review for each suspicious point.

## Verdict

**No malicious or backdoor code was found.**

- **Code:** no obfuscated strings, `eval`, `new Function`, `vm`, or dynamic imports. The only external programs run are the `claude` CLI, plus `where.exe`/`taskkill.exe` on Windows.
- **Credentials:** nothing reads `~/.ssh`, the keychain, or `~/.claude` credentials.
- **Routes:** there are no hidden HTTP routes. The only ones are `GET /health`, `GET /v1/models`, `POST /v1/chat/completions` and `OPTIONS *`.
- **Triggers:** nothing is gated on date, hostname or user. There are no delayed payloads.
- **Hidden text:** I scanned every tracked file for invisible or bidirectional Unicode and found none. The only non-ASCII characters are em-dashes, arrows and box-drawing characters in comments.

Two items need care. They are not malicious, but they are dangerous by design, and they matter because of the HTTP exposure described in `bad-coding-practices.md`.

## Suspicious points and follow-up verdicts

### 1. `--dangerously-skip-permissions` is passed on every request
- **Where:** `src/subprocess/manager.ts:298`, inside `buildArgs()`.
- **Origin:** commit `bbeb4c7`, by Krzysztof Wende, 2026-02-08: "feat: OpenClaw integration — tool mapping, content block support, permission skip". The commit message states the change openly, and the diff matches the message.
- **Behaviour:**
  - The flag is always on. No environment variable, config setting or request field can change it.
  - There is no `--allowedTools`, `--disallowedTools`, `--permission-mode` or `--add-dir` anywhere in `src/`.
  - The CLI runs in `process.cwd()`. Under launchd that is `/` unless the plist sets `WorkingDirectory`.
  - The CLI can use Bash, Read, Write, Edit, WebFetch and WebSearch without asking for approval.
- **Disclosure:** the README "Security" section (`README.md:220-225`) does not mention this flag.
- **Verdict:** **dangerous by design, not a backdoor.** It is there so the CLI can run tools without an interactive terminal.

### 2. Extra system prompt added to every request
- **Where:** `OPENCLAW_TOOL_MAPPING_PROMPT`, defined at `src/subprocess/manager.ts:55-92` and passed with `--append-system-prompt` at `manager.ts:305-306`.
- **Contents:** a fixed table that maps OpenClaw tool names to Claude Code tool names ("if you are asked to use X, use Y").
  - It has no hardcoded recipients, URLs, IDs, base64 or hidden text.
  - Nothing after the end of the array.
  - It contains only two instructions that are not mappings:
    - L89: "When a skill says to run a bash/python command, use the `Bash` tool directly."
    - L91: "Run `openclaw skills list --eligible --json`", a read-only listing.
- **Commands it mentions:** `openclaw message send --to <target>` (Telegram/Discord), `openclaw cron add`, `openclaw nodes run --node <id> "<shell command>"`.
- **History:** it was added in `bbeb4c7` and has not changed since.
- **The proxy itself never runs any `openclaw` binary.**
- **Verdict:** **benign but risky.**
  - If `openclaw` is not installed, the prompt adds about 1.5 KB to each request, and any `openclaw` command the model tries simply fails.
  - If `openclaw` is installed, instructions hidden in a prompt could use messaging, cron or remote nodes without approval.

### 3. Supply chain
- **Lockfile:** all 82 entries in `package-lock.json` resolve to `https://registry.npmjs.org/<name>/-/<name>-<version>.tgz`, with matching names and versions. Every entry has a sha512 `integrity` field.
  - No entry has `hasInstallScript`.
  - No name looks like a typosquat.
  - Every package fits the express 4.x, uuid, typescript or `@types/*` dependency trees.
  - The packages that ship command-line programs are standard ones: `mime`, `typescript`, `uuid`.
- **`package.json`:** has no `preinstall`, `install`, `postinstall` or `prepare` scripts. `prepublishOnly` runs only when publishing.
- **`clawdbot`:** the optional peer dependency is marked optional and is not installed. Confirm with `npm ls clawdbot` after installing.
- **Fork chain:** original author (`0a70bdd`, 2026-01-25) → atalovesyou (rename) → Krzysztof Wende (PRs #2, #13) → AndySian (PR #12: `d39204e`, `842584f`, `1322117`) → your fork.
  - I read AndySian's diffs. They still launch with `shell:false`, use an absolute `taskkill` path, and add no eval or network code.
- **Signatures:** commits are unsigned.
- **Not verified:** the integrity hashes were not checked against the registry, because the review was done offline.
- **Verdict:** **clean.**

### 4. Runtime helper code
- **`CLAUDE_BIN` override** (`manager.ts:110-113`): environment only, never set from a request. `shell` is false on macOS and Linux. **Benign.**
- **Environment passed to the CLI** (`manager.ts:217-219`): the whole `process.env` minus `CLAUDECODE`. No request data goes into the environment or the arguments.
  - `model` is restricted to `opus`, `sonnet` or `haiku` (`src/adapter/openai-to-cli.ts:38-52`).
  - `user` is replaced by a server-generated UUID (`routes.ts:48-50`).
  - The prompt goes through stdin (`manager.ts:241`).
  - **Benign.**
- **`src/session/manager.ts`:** not used when running the server. It is only re-exported for library use at `src/index.ts:243`.
  - It writes only IDs and timestamps to `~/.claude-code-cli-sessions.json`, not prompts.
  - The file path is fixed, so there is no path traversal.
  - **Benign.**
- **`verifyAuth`** (`manager.ts:454-464`): always returns `{ ok: true }` and reads no credentials. It is an empty check, not a security problem. **Benign.**

### 5. Logging, tests, docs and history
- **Logging:** `Authorization` headers and tokens are never logged. Prompt content is logged only under `DEBUG` or `DEBUG_SUBPROCESS`. **Benign.**
- **Tests:** `e2e.test.ts` talks only to 127.0.0.1 and launches the real `claude` CLI, which uses subscription tokens. `manager.test.ts` runs only on Windows. **Benign.**
- **`docs/macos-setup.md`:** no `curl | sh`, no `sudo`, no remote downloads. **Benign.**
- **Git history:**
  - The only file ever deleted is `start-proxy.bat` (added in `d39204e`, removed in `842584f`). It contains `cd /d C:\Users\canch\...` and `node dist/server/standalone.js 3456`. It is harmless, but it leaks a contributor's Windows username.
  - There are 15 commits on both `--all` and HEAD, no stash, and no hidden refs.
  - **Benign.**

## Recommendations
- Install with `npm ci --ignore-scripts`, then run `npm audit signatures` and `npm ls clawdbot`; the last should come back empty.
- If you don't use OpenClaw, consider removing or putting behind a setting the system prompt at `manager.ts:55-92`.
- See `bad-coding-practices.md` for the `--dangerously-skip-permissions` + CORS `*` combination, which is the real risk.
