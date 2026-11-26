# Run the CLI as a plain LLM and carry client tools in the prompt

- **Status:** Accepted, with known issues
- **Introduced:** 78fcbaf, 2026-02-18, Krzysztof Wende
- **Revised:** 2026-11-26

## Context

- OpenAI-compatible clients such as open-code-review send their own `tools` and expect native `tool_calls` in the reply.
- The CLI's own tools (Bash, file edits, WebFetch and others) confused the model. It told clients their tools did not exist. Clients could not see or veto the CLI's tool use.
- `--print` mode cannot take client tool definitions natively, so the tools travel as text in the prompt.

## Decision

- The CLI runs as a plain text model. It is started with built-in tools disabled (`--tools ""`), with MCP servers from settings ignored (`--strict-mcp-config`), in safe mode (`--safe-mode`, which skips CLAUDE.md, skills, plugins and hooks), and with a proxy-built system prompt that replaces the CLI's default (`--system-prompt`).
- The proxy builds the system prompt from three parts:
  - a base line: the model is a language model behind an OpenAI-compatible API, with no built-in tools, no file system and no shell;
  - the text of every `system` and `developer` message;
  - when the request has tools and `tool_choice` is not `none`, a catalog of the client's tools (name, description, JSON-schema parameters) and a text protocol.
- The text protocol: to call tools, the model ends its reply with one or more `<tool_call>` blocks, each holding a JSON object with `name` and `arguments`. It must not write tool results itself, and it stops after the calls. `tool_choice` set to `required` or to a named function adds a line that requires a call.

  ```
  <tool_call>
  {"name": "read_note", "arguments": {"id": "n-42"}}
  </tool_call>
  ```

- Conversation history on stdin:
  - user messages are passed as raw text;
  - earlier assistant turns are rendered as their text, plus a tool-call block for each call they made;
  - tool messages are rendered as a tool-result block that carries the call ID and the tool name.
- Replies with active tools: `<tool_call>` blocks are parsed out of the final text into OpenAI `tool_calls`, with generated IDs and arguments as a JSON string. The remaining text becomes `content` (or null), and `finish_reason` is `tool_calls`.
- Block boundaries: a block starts at an opening tag that is followed by a JSON object. The object ends at its matching closing brace. Braces, tags and escapes inside JSON strings are ignored, so an argument may contain a literal closing tag. The closing tag must follow the object. An opening tag with no object after it is ordinary text, not a block.
- A block is malformed if its JSON is invalid or not an object, its object never closes, no closing tag follows it, its arguments are neither an object nor a string holding valid JSON, or it names a tool the request did not declare.
- If any block is malformed, the whole raw text is returned as a plain reply with `finish_reason` `stop`, and a warning is logged. The warning carries the request ID and up to 200 characters of the failing block. Good blocks in the same reply are not kept.
- Streaming with active tools: text is buffered until the CLI finishes. The proxy then sends one content chunk (if there is text), one chunk with all tool calls, and the done chunk. Without tools, streaming is incremental as before.

## Consequences

- **Good:**
  - Clients get real `tool_calls` in the format they expect.
  - The model cannot run commands or touch files, because the CLI has no tools.
  - No OpenClaw-specific prompt is sent.
  - A reply with a broken block is returned whole, as text, rather than as the calls that parsed. Keeping only the good calls could lose work silently. Say the call that records a finding is broken, but the call that marks the review done is fine. The client would see a finished review with the finding missing, while the reply text says the finding was recorded. Returned as text, the reply shows the client that no call was made, so it can re-prompt. A real client did re-prompt this way and the model corrected itself.
- **Bad:**
  - Tool calls are parsed from text. A formatting slip by the model becomes a plain text reply with `finish_reason` `stop`, not a tool call.
  - Streaming with tools is not incremental. The client waits for the full reply.
  - The CLI still injects an account-context block with the logged-in user's email. The flags do not remove it.
  - The CLI's init event still lists skills and plugin metadata. When asked, the model reports none of them in its context, but that is only its own report.
  - The subprocess manager still emits tool events. They never fire, because the CLI has no tools.

## Affected components

The request adapter, which renders history and builds the tool catalog; the tool-prompt and parser component, which builds the protocol text and parses replies; the response adapter, which builds `tool_calls` and finish reasons; the request handlers' two response paths (streaming and non-streaming), which buffer when tools are active; and the subprocess manager, which builds the CLI arguments and system prompt.

## Revisit when

- The CLI accepts client tool definitions natively, or accepts stream-json input with tool results. Then move tool handling onto that path.
- Parse failures show up often in logs. Then tighten the format or add a retry.
- A client needs incremental streaming with tools.
