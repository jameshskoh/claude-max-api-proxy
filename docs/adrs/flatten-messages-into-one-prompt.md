# Flatten chat messages into one prompt

- **Status:** Accepted, with known issues
- **Introduced:** 0a70bdd, 2026-01-25, Atal Agarwal

## Context

`--print` mode takes one prompt, not a message list (`src/adapter/openai-to-cli.ts:102-107`). Old `PROTOCOL.md` proposed `--input-format stream-json` with `{"type": "user_message"}` lines. That section is marked TODO and was never verified (old `PROTOCOL.md:139-145`).

Old `DESIGN.md` showed `[System]:` and `[Previous response]:` prefixes (old `DESIGN.md:326`, `331`). The code used XML-like tags from the first commit, so the prefix format never shipped.

## Decision

`messagesToPrompt` joins all messages with a newline (`openai-to-cli.ts:108-135`):

- `system` becomes `<system>...</system>`, after OpenClaw tooling sections are stripped (`openai-to-cli.ts:80-100`).
- `user` is raw text.
- `assistant` becomes `<previous_response>...</previous_response>`.
- `tool` is dropped.

Content arrays keep only `text` and `input_text` blocks (`openai-to-cli.ts:60-71`). Images are dropped without an error. The joined string goes to stdin (`manager.ts:240-242`).

On resume, assistant messages are dropped, because the CLI already holds them (`openai-to-cli.ts:154-169`).

## Consequences

- **Good:** Works with the CLI's single-prompt mode. No stream-json protocol to get right. Stdin avoids `E2BIG`.
- **Bad:** Earlier turns are text the model did not write, so multi-turn is weaker than real turns. Message text can imitate the tags, so a user can inject a fake `<system>` block. Images and tool messages are lost silently. Session resume reduces the multi-turn problem for clients that send `user` ([resume-cli-sessions-keyed-by-user.md](resume-cli-sessions-keyed-by-user.md)).

## Where in the code

- `src/adapter/openai-to-cli.ts:60-71`: `extractText`, keeps text blocks only.
- `src/adapter/openai-to-cli.ts:80-100`: `stripOpenClawTooling`.
- `src/adapter/openai-to-cli.ts:108-135`: `messagesToPrompt`, role mapping.
- `src/adapter/openai-to-cli.ts:154-169`: `openaiToCliDelta`, drops assistant turns on resume.
- `src/subprocess/manager.ts:240-242`: prompt written to stdin.

## Revisit when

- The CLI accepts a stream-json input mode with real turns. Check the old `PROTOCOL.md` format against it first.
- Clients need images or tool results forwarded.
- A prompt-injection report or incident involves the tags.
