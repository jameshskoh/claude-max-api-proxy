# Skip CLI permission prompts

- **Status:** Accepted, with known issues
- **Introduced:** bbeb4c7, 2026-02-08, Krzysztof Wende

## Context

- Every request runs the `claude` CLI in `--print` mode.
- `--print` has no terminal. Nobody is there to answer a permission prompt, so a tool call would block until timeout or fail.
- The OpenClaw integration needs the CLI to run tools (Bash, Read, Write, WebFetch) on its own.

## Decision

- Always pass `--dangerously-skip-permissions`.
- No environment variable, config option or request field changes this.
- The proxy passes no `--allowedTools`, `--disallowedTools`, `--permission-mode` or `--add-dir` flags.

## Consequences

- **Good:** tool calls work with no terminal and no approval step. Clients need no changes.
- **Bad:**
  - The model can run Bash, Write, Edit, WebFetch and WebSearch without asking, with your user account's rights.
  - The CLI starts in the proxy's working directory. Under launchd that is `/` unless the plist sets `WorkingDirectory`. Absolute paths reach the rest of the account anyway.
  - With no auth and CORS `*` ([localhost-only-no-auth-open-cors](localhost-only-no-auth-open-cors.md)), a web page may be able to run commands on your machine. This is the main risk in item 1 of the [bad-coding-practices review](../security-review/bad-coding-practices.md).
  - The README security section does not mention this flag.

## Affected components

The subprocess manager: argument building, and the working directory and environment it gives the CLI.

## Revisit when

- The proxy gets a non-local client, a browser-facing route, or a request field that can reach tool input.
- Alternatives, with recommendations:
  - **Tool allowlist** (`--allowedTools`, `--disallowedTools`). Recommended first step. Allow only the tools the clients need, and deny Bash and WebFetch if they are not needed. Test with OpenClaw first.
  - **Permission mode** (`--permission-mode`) plus a fixed empty working directory. Recommended only together with the allowlist. Its behaviour under `--print` is not checked here.
  - **Separate low-privilege OS user.** Recommended if the flag stays. It limits what a successful attack can reach and needs no code change.
