# Resume CLI sessions keyed by the OpenAI user field

- **Status:** Accepted, with known issues
- **Introduced:** d39204e, 2026-08-08, AndySian
- **Revised:** 2026-11-27

## Context

- OpenAI-compatible clients resend the full message history on every turn.
- Without sessions, each request starts a new `claude` process. The CLI then replays the whole history, so cost and latency grow with each turn.
- The CLI keeps its own transcript, so the proxy can resume it instead.

## Decision

- Use the OpenAI `user` field as the session key.
- First turn: pass a new UUID as `--session-id`. On any `result` event, save the CLI session ID, the current message count and a last-used time. This happens even when `is_error` is true.
- Later turns: pass `--resume <id>` and the system prompt again, and send only messages after the saved message count. Assistant messages are dropped, because the CLI already generated them. Tool messages after the saved count are sent.
- No `user`: pass `--no-session-persistence`. There is no shared fallback key.
- Resume failure (a timeout, a failed spawn or an abnormal exit) clears the entry, so the next turn sends full history to a new session. An `is_error` result keeps the entry, as above.
- Store: in process memory. Entries expire 6 hours after last use; an `unref`'d timer sweeps every 30 minutes.

## Consequences

- **Good:**
  - Large token and latency savings on long chats.
  - The proxy writes no session state to disk.
- **Bad:**
  - The map is lost on restart. Transcripts stay under `~/.claude/projects/`, but the proxy cannot find them.
  - Two concurrent requests with the same `user` race on one session.
  - An edited or shortened history gives an empty delta. The code then sends the full history into the resumed session.
  - Changes to messages before the saved count are never sent. The system prompt is the exception: it is sent on every turn, so a changed one takes effect.
  - Two clients sending the same `user` value share a session.
  - The legacy session manager is a file store that the server does not use. It is easy to confuse with the session store.

## Affected components

Session resolution and the result, error and close listeners in both response paths of the request handlers; the session store; the request adapter's delta prompt; and the subprocess manager, which picks the session flag. The legacy session manager is only re-exported by the plugin entry.

## Revisit when

- The proxy runs as more than one process, or restarts often enough that cold starts hurt.
- Clients send concurrent requests with the same `user`.
- Clients start editing or compacting history, which makes the delta logic fail often.
- Claude Code changes how `--resume` or `--session-id` behave.
- Resume errors need a narrower check than "any error clears the session".
