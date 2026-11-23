# Keep tool execution inside the Claude CLI

- **Status:** Accepted, with known issues
- **Introduced:** 78fcbaf, 2026-02-18, Krzysztof Wende

## Context

- The CLI runs its own tools (Bash, Read, Edit, WebFetch and others) inside `--print` mode.
- bbeb4c7 (2026-02-08) added `--dangerously-skip-permissions`, so those tools run without prompts. See [skip-cli-permission-prompts](skip-cli-permission-prompts.md).
- 78fcbaf added code to forward each tool use as an OpenAI `tool_calls` entry.
- OpenClaw read Claude Code's internal `tool_use` blocks as calls it had to run itself. It then sent new requests, which caused an agentic loop. Forwarding was disabled in the same commit, so it never shipped enabled.

## Decision

- Tool calls stay inside the CLI. The proxy forwards only text.
- The forwarding code is commented out, not deleted. A TODO says to show tool activity another way, such as inline text.
- Client-defined `tools` in requests are not read. The request type has no `tools` field.

## Consequences

- **Good:**
  - No agentic loop. OpenClaw gets one answer per request.
- **Bad:**
  - Clients cannot see or veto tool use. Bash commands and file edits happen without the client knowing.
  - Client-defined tools are ignored. A client that expects OpenAI tool calls gets none.
  - Dead code remains: a tool-call ID helper, an unused tool-calls parameter on the response adapter, and the tool events (`tool_use_start`, `input_json_delta`, `content_block_stop`), which are still emitted with nothing listening.
  - The OpenAI response types still allow `tool_calls`. Nothing fills them.

## Affected components

The request handlers, which hold the commented-out tool blocks in both response paths; the response adapter and the OpenAI types, which keep unused tool-call support; and the subprocess manager, which still emits tool events and runs the CLI with permissions skipped.

## Revisit when

- A client needs to see tool activity. Start with the inline-text approach from the TODO.
- The CLI adds an option to disable built-in tools, or to allow only some of them. Clients could then gate tool use.
- OpenClaw changes how it treats `tool_calls`. The loop risk may then be gone.
