# Keep tool execution inside the Claude CLI

- **Status:** Partly reverted
- **Introduced:** 78fcbaf, 2026-02-18, Krzysztof Wende

## Context

- The CLI runs its own tools (Bash, Read, Edit, WebFetch and others) inside `--print` mode.
- bbeb4c7 (2026-02-08) added `--dangerously-skip-permissions`, so those tools run without prompts. See `skip-cli-permission-prompts.md`.
- 78fcbaf added types and accumulators to forward each tool use as an OpenAI `tool_calls` entry.
- OpenClaw read Claude Code's internal `tool_use` blocks as calls it had to run itself. It then sent new requests, which caused an agentic loop. Forwarding was disabled in the same commit, so it never shipped enabled.

## Decision

- Tool calls stay inside the CLI. The proxy forwards only text.
- The forwarding code is commented out, not deleted. A TODO says to show tool activity another way, such as inline text.
- Client-defined `tools` in requests are not read. `OpenAIChatRequest` has no `tools` field.

## Consequences

- **Good:**
  - No agentic loop. OpenClaw gets one answer per request.
- **Bad:**
  - Clients cannot see or veto tool use. Bash commands and file edits happen without the client knowing.
  - Client-defined tools are ignored. A client that expects OpenAI tool calls gets none.
  - Dead code remains: `toOpenAICallId`, the `toolCalls` parameter of `cliResultToOpenai`, and the `tool_use_start`, `input_json_delta` and `content_block_stop` events. The manager still emits those events, and nothing listens to them.
  - The types in `src/types/openai.ts` still allow `tool_calls` in responses. Nothing fills them.

## Where in the code

- `src/server/routes.ts:107-113`: `toOpenAICallId`. Used only in the disabled block.
- `src/server/routes.ts:206-275`: disabled streaming handlers for tool events.
- `src/server/routes.ts:365-383`: disabled non-streaming accumulator for `tool_use` blocks.
- `src/adapter/cli-to-openai.ts:65-106`: `cliResultToOpenai` with an optional `toolCalls` argument that no caller passes.
- `src/types/openai.ts:28-45`: `OpenAIToolCall` and `OpenAIToolCallChunk` types.
- `src/subprocess/manager.ts:346-356`: still emits the tool events that no handler reads.
- `src/subprocess/manager.ts:297-298`: `--print` with `--dangerously-skip-permissions`.

## Revisit when

- A client needs to see tool activity. Start with the inline-text approach from the TODO.
- The CLI adds an option to disable built-in tools, or to allow only some of them. Clients could then gate tool use.
- OpenClaw changes how it treats `tool_calls`. The loop risk may then be gone.
