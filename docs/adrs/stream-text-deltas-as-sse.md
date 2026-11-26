# Stream text deltas as SSE chunks

- **Status:** Accepted, with known issues
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal
- **Revised:** 2026-11-25

## Context

- A Claude turn can take minutes. Clients time out if no bytes arrive.
- The CLI can emit partial output, so the proxy can forward tokens as they arrive.

## Decision

- The CLI runs with `--include-partial-messages`. It then emits `stream_event` lines, which are raw Anthropic streaming events.
- Only `content_block_delta` with `text_delta` becomes an OpenAI chunk. Other events are ignored.
- A new text block after earlier text emits a `"\n\n"` separator chunk, so text from different blocks does not run together.
- Headers are flushed at once, followed by a `:ok` SSE comment.
- Client disconnect is detected on the response closing, not the request. The request's close fires as soon as the body is received. If the response is still open, the subprocess is killed.
- Without active tools, the final chunk carries `finish_reason: "stop"` and usage. Then the stream sends `data: [DONE]`.
- With active tools (a non-empty `tools` list and a `tool_choice` other than `"none"`), text is not streamed. Text deltas are buffered until the CLI's result arrives. The stream then sends, in order: one content chunk with any text left over, one chunk carrying all the `tool_calls`, and a final chunk with `finish_reason: "tool_calls"` and usage. If the reply has malformed tool-call blocks, the whole text is sent as content with `finish_reason: "stop"` instead.
- Errors are sent as a `data: {"error": ...}` line.
- Every chunk carries the requested model ID. The CLI's `assistant` event is not used.

## Consequences

- **Good:**
  - For requests without tools, tokens arrive in real time, so clients avoid timeouts.
  - A client disconnect stops the CLI.
- **Bad:**
  - With active tools, no text reaches the client until the turn ends, so the real-time benefit is lost for those requests.
  - `usage` counts `input_tokens` and `output_tokens` only. Cache tokens are left out, so the reported prompt size is low.
  - After headers are sent, an error cannot change the HTTP status. Clients must read the error line.

## Affected components

The streaming path of the request handlers (SSE headers, disconnect handling, the separator, text chunks, buffering for tool requests, the done chunk, error and close handling); the subprocess manager's arguments, stdout parsing and events; the CLI `stream_event` types; and the response adapter, which builds the tool-call chunk and the done chunk, and the reply parser that turns tool-call blocks into `tool_calls`.

## Revisit when

- The CLI changes its stream format or drops `--include-partial-messages`.
- Clients need tool calls streamed as they are generated, instead of at the end of the turn.
- Streaming and non-streaming results must match exactly.
- Clients need cache-token usage.
