# Localhost-only binding, no auth, no CORS and a Host allowlist

- **Status:** Accepted, with known issues
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal
- **Revised:** 2026-11-27

## Context

- The proxy is a local helper for OpenAI-compatible clients on the same machine.
- The original design assumed that binding to loopback was enough (old `DESIGN.md`). It is not: a web page open in the user's browser can try to reach a loopback server, and DNS rebinding can make a remote name resolve to it.
- The OpenClaw provider setup starts the server and gives clients a dummy key, `local`. The server never checks it.

## Decision

- Bind to `127.0.0.1` by default.
- No auth on any route. Keys are accepted and ignored.
- Serve a request only when its Host names localhost, `127.0.0.1`, the IPv6 loopback address, or the configured bind host. Any other Host gets 403 with the error code `forbidden_host`, before anything else runs.
- Send no CORS headers, and do not handle OPTIONS requests. OPTIONS gets the normal 404.

## Consequences

- **Good:**
  - Clients need no setup. Any OpenAI-compatible SDK works with a dummy key.
  - A web page in the browser cannot read replies: there are no CORS headers, and its JSON requests fail the browser's preflight check.
  - DNS rebinding is blocked, because a rebound name is not a local Host.
- **Bad:**
  - Any local process or OS user that can reach port 3456 can use the API, which gives free use of your Claude subscription through a text-only model (the CLI has no tools, see [skip-cli-permission-prompts](skip-cli-permission-prompts.md)).
  - Clients that address the server by another name, such as a LAN IP or a container service name, get 403 unless that name is the bind host.
  - Error responses return the raw error message to callers, which can include spawn errors and file paths.

## Affected components

The HTTP app (bind address, the Host check, routing with no auth layer, and the error handler that returns the raw message) and the plugin entry's provider setup, which starts the server and hands out the dummy key.

## Revisit when

- Anyone plans a non-loopback bind, reverse proxy, tunnel or container port mapping. Add auth first, and review the Host allowlist.
- A browser-based client needs the API. CORS would then have to be designed together with auth, not added as a wildcard.
- Fixes, in recommended order:
  - **Add a bearer token check.** Recommended before any shared or multi-user use. Clients would then need a real key instead of `local`.
  - **Keep as is.** Acceptable only on a single-user machine, with the gotchas in section 3 of the security review followed.
- Return a generic error message to callers and keep the detail in the local log.
