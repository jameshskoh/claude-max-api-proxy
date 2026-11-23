# Flatten chat messages into one prompt

- **Status:** Accepted, with known issues
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal

## Context

- `--print` mode takes one prompt, not a message list.
- Old `PROTOCOL.md` proposed `--input-format stream-json` with `{"type": "user_message"}` lines. That section is marked TODO and was never verified.
- Old `DESIGN.md` showed `[System]:` and `[Previous response]:` prefixes. The code used XML-like tags from the first commit, so the prefix format never shipped.

## Decision

All messages are joined with a newline into one prompt:

- `system` becomes `<system>...</system>`, after OpenClaw tooling sections are stripped.
- `user` is raw text.
- `assistant` becomes `<previous_response>...</previous_response>`.
- `tool` is dropped.

For example:

```
<system>
You are helpful.
</system>

What is 2+2?
<previous_response>
4
</previous_response>

And times 3?
```

Content arrays keep only `text` and `input_text` blocks. Images are dropped without an error. The joined string goes to the CLI on stdin.

On resume, assistant messages are dropped, because the CLI already holds them.

## Consequences

- **Good:** Works with the CLI's single-prompt mode. No stream-json protocol to get right. Stdin avoids `E2BIG`.
- **Bad:**
  - Earlier turns are text the model did not write, so multi-turn is weaker than real turns. Session resume reduces this for clients that send `user` ([resume-cli-sessions-keyed-by-user](resume-cli-sessions-keyed-by-user.md)).
  - Message text can imitate the tags, so a user can inject a fake `<system>` block.
  - Images and tool messages are lost silently.

## Affected components

The request adapter, which extracts text from content blocks, maps roles to tags and builds the delta prompt on resume, and the subprocess manager, which writes the prompt to stdin.

## Revisit when

- The CLI accepts a stream-json input mode with real turns. Check the old `PROTOCOL.md` format against it first.
- Clients need images or tool results forwarded.
- A prompt-injection report or incident involves the tags.
