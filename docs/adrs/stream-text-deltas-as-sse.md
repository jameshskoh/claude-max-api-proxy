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
- Client disconnect is detected on the response closing, not the request. The request's close fires as soon as the body is received. If the response is still open, the subprocess is killed.
- The final chunk carries `finish_reason: "stop"` and usage. Then the stream sends `data: [DONE]`.
- Errors are sent as a `data: {"error": ...}` line.
- Every chunk carries the requested model ID. The CLI's `assistant` event is not used.

## Consequences

- **Good:**
  - Tokens arrive in real time, so clients avoid timeouts.
  - A client disconnect stops the CLI.
- **Bad:**
  - Text from every assistant turn in the CLI's internal tool loop is streamed. Non-streaming returns only the result message's final text, so the two modes can differ. This is inferred from the code and not tested.
  - `usage` counts `input_tokens` and `output_tokens` only. Cache tokens are left out, so the reported prompt size is low.
  - After headers are sent, an error cannot change the HTTP status. Clients must read the error line.

## Affected components

The streaming path of the request handlers (SSE headers, disconnect handling, the separator, text chunks, the done chunk, error and close handling); the subprocess manager's arguments, stdout parsing and events; the CLI `stream_event` types; and the response adapter, which builds the done chunk.

## Revisit when

- The CLI changes its stream format or drops `--include-partial-messages`.
- A client needs tool activity or other non-text events.
- Streaming and non-streaming results must match exactly.
- Clients need cache-token usage.
