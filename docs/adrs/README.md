# Architecture decision records

Each record explains one design choice: why it was made, what it costs, and which components it touches.
"Old `DESIGN.md`", "old `PROTOCOL.md`" and "old root `ARCHITECTURE.md`" are planning notes removed after commit `2074263`. Read them with `git show 2074263:DESIGN.md`.

Start with [ARCHITECTURE.md](../ARCHITECTURE.md) for the map and [WORKFLOW.md](../WORKFLOW.md) for runtime flows. Come here when a task touches one of these choices.

## Convention

- **One ADR per decision, edited in place.** When a decision changes, rewrite its ADR to describe the current decision and update "Revised". Don't mark it superseded or write a replacement. Why: readers find today's decision without following a chain of stale records, and the old reasoning stays in Git history.
- **Retired decisions are deleted**, together with their row below.
- **Rename the file** when its name no longer describes the decision, and update the row and every link.
- **Describe behaviour, not code locations.** No line numbers. Name components and public contracts (HTTP API, CLI flags, config) instead of files and functions.

| Decision | One line | Touch it when you… |
|---|---|---|
| [run-as-standalone-openai-compatible-server](run-as-standalone-openai-compatible-server.md) | Run a standalone local OpenAI-compatible server that wraps the CLI. | change the entry points, the HTTP routes, or how clients connect |
| [spawn-one-cli-process-per-request](spawn-one-cli-process-per-request.md) | A new `claude` process per request, no pool, prompt on stdin. | touch concurrency, cold start, spawn options, env or cwd |
| [flatten-messages-into-one-prompt](flatten-messages-into-one-prompt.md) | Join OpenAI `messages` into one tagged text prompt. | change prompt format or add image support |
| [pass-full-model-ids-to-cli](pass-full-model-ids-to-cli.md) | Pass the requested model ID to `--model` unchanged; unlisted IDs → 404. | add or retire models, change model validation or the reported name |
| [resume-cli-sessions-keyed-by-user](resume-cli-sessions-keyed-by-user.md) | OpenAI `user` → CLI session; later turns `--resume` and send only new messages. | fix multi-turn bugs, change session TTL or storage |
| [stream-text-deltas-as-sse](stream-text-deltas-as-sse.md) | Turn CLI `stream_event` text deltas into OpenAI SSE chunks. | fix streaming output, disconnects or usage in the final chunk |
| [run-cli-as-plain-llm-with-prompt-tool-calls](run-cli-as-plain-llm-with-prompt-tool-calls.md) | The CLI has no tools; client `tools` go in the system prompt and `<tool_call>` replies become `tool_calls`. | change tool calling, CLI tool/config flags, or the system prompt |
| [skip-cli-permission-prompts](skip-cli-permission-prompts.md) | Always pass `--dangerously-skip-permissions`. | restrict tools, harden the agent |
| [localhost-only-no-auth-host-allowlist](localhost-only-no-auth-host-allowlist.md) | Bind 127.0.0.1, no auth, no CORS, Host must be a local name. | add auth, change the Host check or CORS, expose the server |
| [resolve-windows-exe-and-kill-process-tree](resolve-windows-exe-and-kill-process-tree.md) | Spawn the bundled `.exe` without a shell; kill the whole tree. | fix Windows issues or orphaned processes |

## Template

```markdown
# <Decision, stated as what we do>

- **Status:** Accepted | Accepted, with known issues
- **Introduced:** <commit>, <date>, <author>
- **Revised:** <date>          (add or update on each in-place revision)

## Context
## Decision
## Consequences
## Affected components
## Revisit when
```
