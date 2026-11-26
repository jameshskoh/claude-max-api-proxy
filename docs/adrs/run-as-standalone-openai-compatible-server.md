# Run as a standalone local OpenAI-compatible server

- **Status:** Accepted
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal
- **Revised:** 2026-11-27

## Context

Subscription OAuth tokens are restricted from direct API access (old `DESIGN.md`). The Claude Code CLI can use them, so requests go through the CLI.

OpenAI-compatible clients are widespread. An endpoint that speaks the OpenAI API lets all of them work without any change on their side.

## Decision

- A small Express server listens on `127.0.0.1:3456` and exposes `/v1/chat/completions`, `/v1/models` and `/health`. Any OpenAI-compatible client can use it.
- The server runs as a standalone process, started by hand in a terminal or by an optional macOS LaunchAgent.
- A library entry re-exports server start and stop and the CLI helpers, so other code can embed the server.
- There is no host-app plugin. Clients connect to the endpoint directly.

## Consequences

- **Good:** Any OpenAI client works, with no host-app changes.
- **Bad:**
  - Each request starts a CLI process ([spawn-one-cli-process-per-request](spawn-one-cli-process-per-request.md)).
  - The proxy has no auth, so it depends on the localhost bind ([localhost-only-no-auth-host-allowlist](localhost-only-no-auth-host-allowlist.md)).
  - Most of the old `DESIGN.md` plan was never built: process pool, configurable options, middleware module, tool bridging, cost tracking, caching and multi-account.

## Affected components

The standalone entry, the library entry, and the HTTP app (its three routes and the loopback bind).

## Revisit when

- Anthropic changes the rules for subscription tokens, or the CLI stops accepting them.
- The proxy needs to be reachable beyond localhost, which would require auth.
- A host app needs a native plugin rather than an OpenAI endpoint.
