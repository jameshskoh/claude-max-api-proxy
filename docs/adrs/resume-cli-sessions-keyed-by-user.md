# Resume CLI sessions keyed by the OpenAI user field

- **Status:** Accepted, with known issues
- **Introduced:** d39204e, 2026-08-08, AndySian

## Context

- OpenAI-compatible clients resend the full message history on every turn.
- Without sessions, each request starts a new `claude` process. The CLI then replays the whole history, so cost and latency grow with each turn.
- The CLI keeps its own transcript, so the proxy can resume it instead.

## Decision

- Use the OpenAI `user` field as the session key.
- First turn: pass a new UUID as `--session-id`. On any `result` event, save `{claudeSessionId, messageCount: messages.length, lastUsed}`. This happens even when `is_error` is true.
- Later turns: pass `--resume <id>` and send only messages after `messageCount`. Assistant messages are dropped, because the CLI already generated them.
- No `user`: pass `--no-session-persistence`. There is no shared fallback key.
- Resume failure (error or abnormal exit) clears the entry, so the next turn sends full history to a new session.
- Store: in-memory `Map`. Entries expire 6 hours after `lastUsed`; an unref'd timer sweeps every 30 minutes.

## Consequences

- **Good:**
  - Large token and latency savings on long chats.
  - The proxy writes no session state to disk.
- **Bad:**
  - The map is lost on restart. Transcripts stay under `~/.claude/projects/`, but the proxy cannot find them.
  - Two concurrent requests with the same `user` race on one session.
  - An edited or shortened history gives an empty delta. The code then sends the full history into the resumed session.
  - Changes to messages before `messageCount`, such as a new system prompt, are never sent.
  - Two clients sending the same `user` value share a session.
  - `src/session/manager.ts` is a legacy file store that the server does not use. It is easy to confuse with `session-store.ts`.

## Where in the code

- `src/server/routes.ts:30-53`: `resolveCliInput` picks resume or first turn from `body.user`.
- `src/server/routes.ts:289-310`: streaming `result` handler saves the session.
- `src/server/routes.ts:312-348`: streaming error and close handlers clear a failed resume.
- `src/server/routes.ts:392-432`: non-streaming handlers save on success and clear on failure.
- `src/subprocess/session-store.ts:1-54`: in-memory map, TTL, 30-minute sweep, get, set and clear.
- `src/adapter/openai-to-cli.ts:153-174`: `openaiToCliDelta` keeps messages after `messageCount` and drops assistant turns.
- `src/subprocess/manager.ts:310-321`: chooses `--resume`, `--session-id` or `--no-session-persistence`.
- `src/session/manager.ts`: legacy file store. Only re-exported from `src/index.ts:240`.

## Revisit when

- The proxy runs as more than one process, or restarts often enough that cold starts hurt.
- Clients send concurrent requests with the same `user`.
- Clients start editing or compacting history, which makes the delta logic fail often.
- Claude Code changes how `--resume` or `--session-id` behave.
- Resume errors need a narrower check than "any error clears the session".
