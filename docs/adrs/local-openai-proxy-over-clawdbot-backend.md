# Local OpenAI-compatible proxy instead of a Clawdbot backend

- **Status:** Accepted
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal

## Context

Subscription OAuth tokens are restricted from direct API access (old `DESIGN.md`). The Claude Code CLI can use them, so requests go through the CLI.

Clawdbot's provider system handles authentication only. It has no subprocess backend (old root `ARCHITECTURE.md`). Three options were weighed there:

- **A:** a custom backend in Clawdbot core. Needs core changes.
- **B:** a local OpenAI-compatible HTTP server that wraps the CLI, registered as an `openai-completions` provider.
- **C:** hooks that intercept model calls and redirect them to the CLI.

Old root `ARCHITECTURE.md` recommended B as the most practical.

## Decision

- Build option B. A small Express server listens on `127.0.0.1:3456` and exposes `/v1/chat/completions`, `/v1/models` and `/health`. Any OpenAI-compatible client can use it.
- Keep a Clawdbot plugin wrapper. It registers the provider with a dummy `local` token, since the CLI handles auth, advertises a few models, and adds `claude-cli:start`, `claude-cli:stop` and `claude-cli:status` commands.
- A standalone entry runs the server without Clawdbot.

## Consequences

- **Good:** Clawdbot core needs no changes. Any OpenAI client can use the proxy. The server runs without Clawdbot.
- **Bad:**
  - Each request starts a CLI process ([spawn-one-cli-process-per-request](spawn-one-cli-process-per-request.md)).
  - The proxy has no auth, so it depends on the localhost bind ([localhost-only-no-auth-open-cors](localhost-only-no-auth-open-cors.md)).
  - Two entry points, the plugin and the standalone server, must both keep working.
  - Most of the old `DESIGN.md` plan was never built: process pool, configurable options, middleware module, tool bridging, cost tracking, caching and multi-account.

## Affected components

The plugin entry (provider registration, the dummy token, advertised models and commands), the standalone entry, and the HTTP app (its three routes and the loopback bind).

## Revisit when

- Anthropic changes the rules for subscription tokens, or the CLI stops accepting them.
- Clawdbot adds a subprocess backend, which would make option A cheap.
- The plugin wrapper is dropped, leaving only the standalone server.
- The proxy needs to be reachable beyond localhost, which would require auth.
