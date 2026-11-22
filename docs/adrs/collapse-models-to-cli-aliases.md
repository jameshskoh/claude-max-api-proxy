# Collapse model IDs to CLI aliases

- **Status:** Accepted, with known issues
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal

## Context

The CLI takes `--model` as an alias: `opus`, `sonnet` or `haiku`. Clients send many model IDs, so the proxy maps each one to an alias (`src/adapter/openai-to-cli.ts:7-52`). The alias means whatever the installed CLI resolves it to. The proxy cannot pin a model version.

## Decision

- `MODEL_MAP` maps full IDs and bare aliases to `opus`, `sonnet` or `haiku` (`openai-to-cli.ts:15-33`). The prefixes `claude-code-cli/` and `claude-max/` are stripped first (`openai-to-cli.ts:44-45`).
- An unknown ID defaults to `opus` (`openai-to-cli.ts:50-51`). This default has been in place since the first commit.
- Responses report a normalized name: `claude-opus-4`, `claude-sonnet-4` or `claude-haiku-4`, whatever version actually ran (`cli-to-openai.ts:112-118`).
- Non-streaming responses take the first key of `result.modelUsage` as the model name (`cli-to-openai.ts:74-76`). That key may not be the main model.

## Consequences

- **Good:** Clients can use familiar IDs. Requests follow the CLI's default version without code changes.
- **Bad:** A client that asks for a specific version gets whatever the CLI picks. The reported name can hide the real version. Unknown IDs run on opus, which may not be what the client expected. The model list is copied in three places: `MODEL_MAP`, `handleModels` and `AVAILABLE_MODELS`, plus the e2e test. `MODEL_MAP` lookups are not prototype-safe, so `model: "constructor"` puts a non-string into the CLI arguments (`openai-to-cli.ts:40-41`; see `docs/security-review/bad-coding-practices.md`).

## Where in the code

- `src/adapter/openai-to-cli.ts:7-52`: `ClaudeModel`, `MODEL_MAP` and `extractModel`.
- `src/adapter/cli-to-openai.ts:68-106`: `cliResultToOpenai`, which takes the `modelUsage` key.
- `src/adapter/cli-to-openai.ts:112-118`: `normalizeModelName`.
- `src/server/routes.ts:447-474`: `handleModels`, a hardcoded list.
- `src/index.ts:18-37`: `AVAILABLE_MODELS`, the plugin's model list.

## Revisit when

- The CLI accepts pinned model versions, or the alias scheme changes.
- A client needs the exact version reported back.
- The model list moves to one shared constant, or the lookups switch to `Object.hasOwn`.
