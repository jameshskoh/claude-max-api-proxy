# Architecture decision records

Each record explains one design choice found in the code: why it was made, what it costs, and where it lives.
Line references were last updated on 2026-11-23. Re-check them if the code has moved.
"Old `DESIGN.md`", "old `PROTOCOL.md`" and "old root `ARCHITECTURE.md`" are planning notes removed after that commit. Read them with `git show 2074263:DESIGN.md`.

Start with `docs/ARCHITECTURE.md` for the map and `docs/WORKFLOW.md` for runtime flows. Come here when a task touches one of these choices.

| Decision | One line | Touch it when you… |
|---|---|---|
| [local-openai-proxy-over-clawdbot-backend](local-openai-proxy-over-clawdbot-backend.md) | Run a local OpenAI-compatible HTTP server instead of a custom Clawdbot backend. | change the entry points, the plugin wrapper, or how clients connect |
| [spawn-one-cli-process-per-request](spawn-one-cli-process-per-request.md) | A new `claude` process per request, no pool, prompt on stdin. | touch concurrency, cold start, spawn options, env or cwd |
| [flatten-messages-into-one-prompt](flatten-messages-into-one-prompt.md) | Join OpenAI `messages` into one tagged text prompt. | change prompt format, add image or tool-message support |
| [pass-full-model-ids-to-cli](pass-full-model-ids-to-cli.md) | Pass the requested model ID to `--model` unchanged; unlisted IDs → 404. | add or retire models, change model validation or the reported name |
| [resume-cli-sessions-keyed-by-user](resume-cli-sessions-keyed-by-user.md) | OpenAI `user` → CLI session; later turns `--resume` and send only new messages. | fix multi-turn bugs, change session TTL or storage |
| [stream-text-deltas-as-sse](stream-text-deltas-as-sse.md) | Turn CLI `stream_event` text deltas into OpenAI SSE chunks. | fix streaming output, disconnects or usage in the final chunk |
| [keep-tool-execution-inside-cli](keep-tool-execution-inside-cli.md) | The CLI runs its own tools; `tool_calls` forwarding is disabled. | want clients to see tool activity or pass their own tools |
| [adapt-openclaw-prompts](adapt-openclaw-prompts.md) | Strip OpenClaw tool sections and append a tool-name mapping prompt. | change OpenClaw behaviour or serve non-OpenClaw clients |
| [skip-cli-permission-prompts](skip-cli-permission-prompts.md) | Always pass `--dangerously-skip-permissions`. | restrict tools, harden the agent |
| [localhost-only-no-auth-open-cors](localhost-only-no-auth-open-cors.md) | Bind 127.0.0.1, no auth, CORS `*`. | add auth, fix CORS, expose the server |
| [resolve-windows-exe-and-kill-process-tree](resolve-windows-exe-and-kill-process-tree.md) | Spawn the bundled `.exe` without a shell; kill the whole tree. | fix Windows issues or orphaned processes |

## Template

```
# <Title>

- **Status:** Accepted | Accepted, with known issues | Partly built | Partly reverted
- **Introduced:** <commit, date, author>

## Context
## Decision
## Consequences
## Where in the code
## Revisit when
```
