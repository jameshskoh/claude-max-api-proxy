# Skip CLI permission prompts

- **Status:** Accepted, with known issues
- **Introduced:** bbeb4c7, 2026-02-08, Krzysztof Wende
- **Revised:** 2026-11-25

## Context

- Every request runs the `claude` CLI in `--print` mode.
- `--print` has no terminal. Nobody is there to answer a permission prompt, so a tool call would block until timeout or fail.
- The CLI runs with no built-in tools (`--tools ""`), no MCP servers, and no CLAUDE.md, skills, plugins or hooks. It acts as a text-only model.

## Decision

- Always pass `--dangerously-skip-permissions`. It is a guard: a stray tool or permission check can never block a headless run.
- No environment variable, config option or request field changes this.
- The proxy passes no `--allowedTools`, `--disallowedTools`, `--permission-mode` or `--add-dir` flags.

## Consequences

- **Good:** A stray tool or permission check cannot block a run. Clients need no changes.
- **Bad:**
  - The flag lets any tool that does run proceed without asking, with your user account's rights. With no tools enabled, the model can only return text, so the risk is limited to what a text-only model can do. If built-in tools or MCP servers are turned on again, the flag applies to them too.
  - The CLI starts in a fixed folder under the OS temp directory, not the proxy's own. That folder is not a sandbox: it only sets where session files go. If tools come back, absolute paths reach the rest of the account.
  - With no auth, no CORS headers and a Host allowlist ([localhost-only-no-auth-host-allowlist](localhost-only-no-auth-host-allowlist.md)), a web page in the browser cannot read its replies, and the model can only return text.
  - The README security section does not mention this flag.

## Affected components

The subprocess manager: argument building, and the working directory and environment it gives the CLI.

## Revisit when

- The CLI is given built-in tools or MCP servers again, or the proxy gets a non-local client.
- Alternatives, with recommendations:
  - **Tool allowlist** (`--allowedTools`, `--disallowedTools`). Recommended first step if tools come back. Allow only the tools the clients need, and deny Bash and WebFetch if they are not needed.
  - **Permission mode** (`--permission-mode`) plus an empty working directory. The CLI runs in a fixed temp folder, but nothing empties or checks it, so this part is only partly done. Recommended only together with the allowlist. Its behaviour under `--print` is not checked here.
  - **Separate low-privilege OS user.** Recommended if tools come back and the flag stays. It limits what a successful attack can reach and needs no code change.
