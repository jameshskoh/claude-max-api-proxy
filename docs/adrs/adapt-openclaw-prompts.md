# Adapt OpenClaw system prompts for Claude Code

- **Status:** Accepted, with known issues
- **Introduced:** bbeb4c7, 2026-02-08, Krzysztof Wende

## Context

- OpenClaw sends a large system prompt.
- The prompt names tools that Claude Code does not have, such as `exec`, `read`, `web_search`, `message`, `cron` and `nodes`.
- The model then tries to call tools that do not exist.

## Decision

Two parts.

1. Strip four system-prompt sections from `system` messages. Each runs from its `## ` heading to the next `## ` heading, or to the end of the text: `## Tooling`, `## Tool Call Style`, `## OpenClaw CLI Quick Reference`, `## OpenClaw Self-Update`.
2. Append `OPENCLAW_TOOL_MAPPING_PROMPT` to every request with `--append-system-prompt`. It maps OpenClaw tool names to Claude Code tools, such as `exec` to `Bash`. It maps OpenClaw features that have no Claude Code tool to `openclaw` CLI commands run through `Bash`.

## Consequences

- **Good:**
  - OpenClaw works without changes on its side.
  - Tool names in the prompt point at tools that exist.
- **Bad:**
  - The mapping prompt is about 2.5 KB (2,473 bytes). It is sent on every request, including from non-OpenClaw clients. There is no switch.
  - If the `openclaw` binary is installed, injected instructions could send messages, add cron jobs or run commands on nodes. Permissions are skipped, so nothing asks first. See `docs/security-review/malicious-intention.md`, item 2.
  - The regex depends on OpenClaw's exact heading names. If they change, the strip fails silently and the tool names stay in the prompt.

## Where in the code

- `src/subprocess/manager.ts:50-92`: `OPENCLAW_TOOL_MAPPING_PROMPT`.
- `src/subprocess/manager.ts:305-306`: appends the mapping prompt on every request.
- `src/adapter/openai-to-cli.ts:73-100`: `stripOpenClawTooling`, with the four headings and the regex.
- `src/adapter/openai-to-cli.ts:116-120`: applies the strip to `system` messages only.

## Revisit when

- OpenClaw renames its headings or adds tool names. Check the regex and the mapping.
- Claude Code gains native tools that match OpenClaw's, such as `message` or `cron`. Then remove the matching mapping lines.
- Non-OpenClaw clients need a clean prompt. Make the mapping conditional, for example on a request header.
- The `openclaw` binary is installed on the machine that runs the proxy. Review the command list in the mapping first.
