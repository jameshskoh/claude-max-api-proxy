# Localhost-only binding, no auth and open CORS

- **Status:** Accepted, with known issues
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal

## Context

- The proxy is a local helper for OpenAI-compatible clients on the same machine.
- The original design assumed that binding to loopback was enough (old `DESIGN.md:768-774`).
- The OpenClaw provider setup starts the server and gives clients a dummy key, `local` (`src/index.ts:146`, `src/index.ts:155`). The server never checks it.

## Decision

- Bind to `127.0.0.1` by default (`src/server/index.ts:108`).
- No auth on any route. Keys are accepted and ignored.
- Send `Access-Control-Allow-Origin: *` on every response, and answer every OPTIONS request with 200 "for local development" (`src/server/index.ts:60-71`).
- Do not check `Host` or `Origin`.

## Consequences

- **Good:** clients need no setup. Any OpenAI-compatible SDK works with a dummy key, and browser-based tools can call the API directly.
- **Bad:**
  - Any local process or OS user that can reach port 3456 can use the API, which gives it a command line as you (see `skip-cli-permission-prompts.md`).
  - Any website is likely able to send requests from your browser. CORS allows it, and DNS rebinding works because `Host` is never checked. Chrome's private-network-access rules block some of this, but this has not been tested in a browser. See item 1 of `docs/security-review/bad-coding-practices.md`.
  - Error responses return the raw `err.message` to callers, which can include spawn errors and file paths (`src/server/index.ts:90-99`).

## Where in the code

- `src/server/index.ts:108`: default host `127.0.0.1`.
- `src/server/index.ts:60-71`: CORS headers and the OPTIONS handler.
- `src/server/index.ts:74-76`: routes, with no auth middleware.
- `src/server/index.ts:90-99`: error handler that returns `err.message`.
- `src/index.ts:137-159`: provider setup. Starts the server and sends the dummy key `local`.

## Revisit when

- Anyone plans a non-loopback bind, reverse proxy, tunnel or container port mapping. Add auth first.
- A browser-based client needs the API.
- Fixes, in recommended order:
  - **Remove the `*` header and reject unexpected `Host` values.** Recommended now. It is a small change, and no client in this repo needs CORS.
  - **Add a bearer token check.** Recommended before any shared or multi-user use. Clients would then need a real key instead of `local`.
  - **Keep as is.** Acceptable only on a single-user machine, with the gotchas in section 3 of the security review followed.
- Return a generic error message to callers and keep the detail in the local log.
