# Pass full model IDs to the CLI

- **Status:** Accepted
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal
- **Revised:** 2026-11-23

## Context

The CLI's `--model` takes a full model name as well as an alias. Clients name a specific model and expect to get it, so the proxy passes the ID through unchanged.

## Decision

- `SUPPORTED_MODELS` in `openai-to-cli.ts` is the only list of accepted IDs.
- The prefixes `claude-code-cli/` and `claude-max/` are stripped. The ID is kept only if it is in the list. The lookup is an array `includes`, so it is prototype-safe.
- The full ID is passed to `--model` unchanged.
- A missing or unsupported `model` returns HTTP 404 with `code: "model_not_found"` and `param: "model"`. The message lists every supported ID.
- `GET /v1/models` lists the same list.
- The response `model` is the requested ID, prefix removed, on streaming chunks and non-streaming responses.

## Consequences

- **Good:**
  - Each ID runs the model it names.
  - An unsupported ID fails loudly, with the list of valid IDs.
  - One list feeds validation, `/v1/models` and the e2e test.
  - The lookup is prototype-safe.
- **Bad:**
  - When the CLI adds or retires a model, `SUPPORTED_MODELS` must be edited and re-checked against the CLI.
  - The plugin's `AVAILABLE_MODELS` is a separate list.

## Where in the code

- `src/adapter/openai-to-cli.ts:11-25`: `SUPPORTED_MODELS` and `SupportedModel`.
- `src/adapter/openai-to-cli.ts:38-46`: `extractModel`, which strips prefixes and checks the list.
- `src/adapter/openai-to-cli.ts:51-57`: `requireModel`, a safety net that throws on null.
- `src/subprocess/manager.ts:303-304`: `--model` receives the full ID.
- `src/server/routes.ts:81-91`: the 404 `model_not_found` check and its message.
- `src/server/routes.ts:157`: `responseModel`, the requested ID on streaming chunks.
- `src/server/routes.ts:416`: non-streaming response model.
- `src/adapter/cli-to-openai.ts:68-102`: `cliResultToOpenai`.
- `src/server/routes.ts:459-470`: `handleModels`, which lists `SUPPORTED_MODELS`.
- `src/index.ts:18-34`: `AVAILABLE_MODELS`, the plugin's list.

## Revisit when

- The CLI adds or retires models.
- A client needs aliases such as "latest opus".
