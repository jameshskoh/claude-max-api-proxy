# Pass full model IDs to the CLI

- **Status:** Accepted
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal
- **Revised:** 2026-11-23

## Context

The CLI's `--model` takes a full model name as well as an alias. Clients name a specific model and expect to get it, so the proxy passes the ID through unchanged.

## Decision

- One list of supported IDs is the only source of accepted models.
- The prefixes `claude-code-cli/` and `claude-max/` are stripped. The ID is kept only if it is in the list. The check is a plain list lookup, so names such as `constructor` cannot slip through.
- The full ID is passed to `--model` unchanged.
- A missing or unsupported `model` returns HTTP 404 with `code: "model_not_found"` and `param: "model"`. The message lists every supported ID.
- `GET /v1/models` returns the same list.
- The response `model` is the requested ID, prefix removed, on streaming chunks and non-streaming responses.

## Consequences

- **Good:**
  - Each ID runs the model it names.
  - An unsupported ID fails loudly, with the list of valid IDs, before any CLI call.
  - One list feeds validation, `/v1/models` and the e2e test.
- **Bad:**
  - When the CLI adds or retires a model, the list must be edited and the ID re-checked against the CLI.
  - The plugin's advertised models are a separate list.

## Affected components

The request adapter, which holds the supported-model list and the check; request validation and the models endpoint in the request handlers; both response paths, which report the requested ID; the subprocess manager, which passes the ID to `--model`; and the plugin entry's advertised list.

## Revisit when

- The CLI adds or retires models.
- A client needs aliases such as "latest opus".
