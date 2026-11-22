# Local OpenAI-compatible proxy instead of a Clawdbot backend

- **Status:** Accepted
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal

## Context

Subscription OAuth tokens are restricted from direct API access (old `DESIGN.md:5`, `src/index.ts:4-5`). The Claude Code CLI can use them, so requests go through the CLI.

Clawdbot's provider system handles authentication only. It has no subprocess backend (old root `ARCHITECTURE.md:92-98`). Three options were weighed (old root `ARCHITECTURE.md:102-130`):

- **A:** a custom backend in Clawdbot core. Needs core changes.
- **B:** a local OpenAI-compatible HTTP server that wraps the CLI, registered as an `openai-completions` provider.
- **C:** hooks that intercept model calls and redirect them to the CLI.

Old root `ARCHITECTURE.md` recommended B as the most practical.

## Decision

Build option B. A small Express server listens on `127.0.0.1:3456` and exposes `/v1/chat/completions`, `/v1/models` and `/health`. Any OpenAI-compatible client can use it.

The Clawdbot plugin wrapper stays in `src/index.ts`. It registers the provider with a dummy `local` token, since the CLI handles auth, and adds `claude-cli:start`, `claude-cli:stop` and `claude-cli:status` commands. The standalone entry point runs the server without Clawdbot.

## Consequences

- **Good:** Clawdbot core needs no changes. Any OpenAI client can use the proxy. The server runs without Clawdbot.
- **Bad:** Each request starts a CLI process (see the spawn decision). The proxy has no auth, so it depends on the localhost bind ([localhost-only-no-auth-open-cors.md](localhost-only-no-auth-open-cors.md)). Two entry points, the plugin and the standalone server, must both keep working. Most of the old `DESIGN.md` plan was never built: process pool, configurable options, `middleware.ts`, tool bridging, cost tracking, caching and multi-account.

## Where in the code

- `src/index.ts:77-188`: `registerProvider` call, with the dummy `local` token at line 149.
- `src/index.ts:200-228`: `claude-cli:start`, `claude-cli:stop` and `claude-cli:status` commands.
- `src/index.ts:18-34`: `AVAILABLE_MODELS`, the models the plugin advertises.
- `src/server/index.ts:74-76`: the three routes.
- `src/server/index.ts:108`: default bind address `127.0.0.1`.
- `src/server/standalone.ts:16-73`: standalone entry point.

## Revisit when

- Anthropic changes the rules for subscription tokens, or the CLI stops accepting them.
- Clawdbot adds a subprocess backend, which would make option A cheap.
- The plugin wrapper is dropped, leaving only the standalone server.
- The proxy needs to be reachable beyond localhost, which would require auth.
