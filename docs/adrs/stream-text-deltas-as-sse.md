# Stream text deltas as SSE chunks

- **Status:** Accepted, with known issues
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal

## Context

- A Claude turn can take minutes. Clients time out if no bytes arrive.
- The CLI can emit partial output, so the proxy can forward tokens as they arrive.

## Decision

- The CLI runs with `--include-partial-messages`. It then emits `stream_event` lines, which are raw Anthropic streaming events.
- Only `content_block_delta` with `text_delta` becomes an OpenAI chunk. Other events are ignored.
- A new text block after earlier text emits a `"\n\n"` separator chunk, so text from different blocks does not run together.
- Headers are flushed at once, followed by a `:ok` SSE comment.
- Client disconnect is detected with `res.on("close")`, not `req.on("close")`. The `req` event fires when the body is received. If the response is still open, the subprocess is killed.
- The final chunk carries `finish_reason: "stop"` and usage. Then the stream sends `data: [DONE]`.
- Errors are sent as a `data: {"error": ...}` line.
- The `assistant` event only updates the model name.

## Consequences

- **Good:**
  - Tokens arrive in real time, so clients avoid timeouts.
  - A client disconnect stops the CLI.
- **Bad:**
  - Text from every assistant turn in the CLI's internal tool loop is streamed. Non-streaming returns only `result.result`, so the two modes can differ. This is inferred from the code and not tested.
  - `usage` counts `input_tokens` and `output_tokens` only. Cache tokens are left out, so the reported prompt size is low.
  - After headers are sent, an error cannot change the HTTP status. Clients must read the error line.

## Where in the code

- `src/server/routes.ts:122-141`: SSE headers, immediate flush and the `:ok` comment.
- `src/server/routes.ts:152-158`: `res.on("close")` kills the subprocess on early disconnect.
- `src/server/routes.ts:162-179`: text block separator chunk.
- `src/server/routes.ts:182-204`: `content_delta` handler that writes text chunks.
- `src/server/routes.ts:278-280`: `assistant` handler, model name only.
- `src/server/routes.ts:282-303`: `result` handler writes the final chunk with usage, then `[DONE]`.
- `src/server/routes.ts:305-341`: error and close handlers.
- `src/subprocess/manager.ts:295-371`: argument list with `--include-partial-messages`, line parsing and event emission.
- `src/types/claude-cli.ts:102-197`: `stream_event` type and type guards.
- `src/adapter/cli-to-openai.ts:46-63`: `createDoneChunk`.

## Revisit when

- The CLI changes its stream format or drops `--include-partial-messages`.
- A client needs tool activity or other non-text events.
- Streaming and non-streaming results must match exactly.
- Clients need cache-token usage.
