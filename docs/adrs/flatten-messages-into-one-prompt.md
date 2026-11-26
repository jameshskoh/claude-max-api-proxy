# Flatten chat messages into one prompt

- **Status:** Accepted, with known issues
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal
- **Revised:** 2026-11-25

## Context

- `--print` mode takes one prompt, not a message list.
- Old `PROTOCOL.md` proposed `--input-format stream-json` with `{"type": "user_message"}` lines. That section is marked TODO and was never verified.
- Old `DESIGN.md` showed `[System]:` and `[Previous response]:` prefixes. The code used XML-like tags from the first commit, so the prefix format never shipped.
- Clients send their own tools and expect native tool calls back, so earlier tool calls and tool results must reach the model as text.

## Decision

`system` and `developer` messages are not part of the prompt. They go to the CLI's system prompt, through the `--system-prompt` flag. When the request has tools, that system prompt also lists them and tells the model how to write a tool call.

The other messages are joined with a newline into one prompt, which goes to the CLI on stdin:

- `user` is raw text.
- `assistant` becomes `<previous_response>...</previous_response>`, holding its text and one `<tool_call>` block for each tool call it made.
- `tool` becomes a `<tool_result>` block that carries the call ID and the tool name. The name is taken from the earlier call with the same ID.

For example (made-up):

```
<previous_response>
<tool_call>{"name": "lookup_price", "arguments": {"sku": "A-100"}}</tool_call>
</previous_response>
<tool_result tool_call_id="call_1f3a" name="lookup_price">9.50</tool_result>

Thanks. And the next item?
```

Content arrays keep only `text` and `input_text` blocks. Images are dropped without an error.

On resume, only messages after the saved count are sent. Assistant messages are dropped, because the CLI already holds them. Tool messages are kept.

## Consequences

- **Good:** Works with the CLI's single-prompt mode. No stream-json protocol to get right. Stdin avoids `E2BIG`.
- **Bad:**
  - Earlier turns are text the model did not write, so multi-turn is weaker than real turns. Session resume reduces this for clients that send `user` ([resume-cli-sessions-keyed-by-user](resume-cli-sessions-keyed-by-user.md)).
  - Message text can imitate the tags. A user can inject a fake `<previous_response>` or `<tool_result>` block, or steer the model into writing a `<tool_call>` block, which the proxy then returns to the client as a real tool call.
  - Images are lost silently.

## Affected components

The request adapter, which extracts text from content blocks, maps roles to tags, builds the tool text and the delta prompt on resume; and the subprocess manager, which writes the prompt to stdin and passes the system prompt as a flag.

## Revisit when

- The CLI accepts a stream-json input mode with real turns. Check the old `PROTOCOL.md` format against it first.
- Clients need images forwarded.
- The text tool-call format fails often enough (malformed blocks fall back to plain text) that a native tool path is worth building.
- A prompt-injection report or incident involves the tags.
