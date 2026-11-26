/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type {
  OpenAIChatMessage,
  OpenAIChatRequest,
} from "../types/openai.js";
import {
  buildSystemPrompt,
  extractText,
  formatToolCallBlock,
  formatToolResult,
} from "./tools.js";

/**
 * Full model IDs passed unchanged to `claude --model`.
 * Checked against the Claude CLI on 2026-11-23.
 */
export const SUPPORTED_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export interface CliInput {
  prompt: string;
  systemPrompt: string;
  model: SupportedModel;
  sessionId?: string;
}

/**
 * Validate a request model ID against SUPPORTED_MODELS.
 * Strips a `claude-code-cli/` or `claude-max/` provider prefix first.
 * Returns null if the model is not a string or is not supported.
 */
export function extractModel(model: unknown): SupportedModel | null {
  if (typeof model !== "string") {
    return null;
  }
  const id = model.replace(/^(?:claude-code-cli|claude-max)\//, "");
  return (SUPPORTED_MODELS as readonly string[]).includes(id)
    ? (id as SupportedModel)
    : null;
}

/**
 * Resolve a model that the route has already validated. Throws if it is not supported.
 */
function requireModel(model: unknown): SupportedModel {
  const resolved = extractModel(model);
  if (resolved === null) {
    throw new Error(`Unsupported model: ${String(model)}`);
  }
  return resolved;
}

/**
 * Find the function name for a tool call id by searching the tool_calls of
 * every assistant message. Returns undefined if no assistant message has it.
 */
function findToolName(
  toolCallId: string | undefined,
  allMessages: OpenAIChatMessage[]
): string | undefined {
  if (toolCallId === undefined) {
    return undefined;
  }
  for (const msg of allMessages) {
    if (msg.role !== "assistant") {
      continue;
    }
    const call = msg.tool_calls?.find((c) => c.id === toolCallId);
    if (call) {
      return call.function.name;
    }
  }
  return undefined;
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 *
 * Mapping per role:
 *   - system / developer: omitted here; they go into the system prompt.
 *   - user: raw text.
 *   - assistant: wrapped in a previous_response block. Any tool_calls it made
 *     follow its text as <tool_call> blocks. Empty text adds no blank line.
 *   - tool: a <tool_result> block carrying the tool_call_id, and the function
 *     name looked up from the matching tool call in allMessages.
 *
 * allMessages defaults to messages. Pass the full request history when
 * messages is a slice, so tool names can still be resolved.
 */
export function messagesToPrompt(
  messages: OpenAIChatMessage[],
  allMessages: OpenAIChatMessage[] = messages
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content);
    switch (msg.role) {
      case "system":
      case "developer":
        // Rendered into the system prompt instead (see buildSystemPrompt)
        break;

      case "user":
        // User messages are the main prompt
        parts.push(text);
        break;

      case "assistant": {
        // Previous assistant responses for context, including any tool calls
        const inner: string[] = [];
        if (text.trim().length > 0) {
          inner.push(text);
        }
        for (const call of msg.tool_calls ?? []) {
          inner.push(formatToolCallBlock(call.function.name, call.function.arguments));
        }
        parts.push(`<previous_response>\n${inner.join("\n")}\n</previous_response>\n`);
        break;
      }

      case "tool": {
        // Client tool output, named after the call it answers
        const name = findToolName(msg.tool_call_id, allMessages);
        parts.push(formatToolResult(text, msg.tool_call_id, name));
        break;
      }
    }
  }

  return parts.join("\n").trim();
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  return {
    prompt: messagesToPrompt(request.messages),
    systemPrompt: buildSystemPrompt(request),
    model: requireModel(request.model),
    sessionId: request.user, // Use OpenAI's user field for session mapping
  };
}

/**
 * Build CLI input for a request that will --resume an existing Claude CLI
 * session. Since the CLI already remembers everything up to `sinceIndex`
 * (it generated the assistant turns itself), we only need to forward the
 * messages appended since then — not the full history again.
 */
export function openaiToCliDelta(
  request: OpenAIChatRequest,
  sinceIndex: number
): CliInput {
  const newMessages = request.messages
    .slice(sinceIndex)
    .filter((m) => m.role !== "assistant");

  // Fallback to full history if nothing new was rendered (shouldn't happen,
  // but never send an empty prompt to the CLI). Checks the rendered string,
  // since system-only messages render to nothing.
  const delta = messagesToPrompt(newMessages, request.messages);
  return {
    prompt: delta.length > 0 ? delta : messagesToPrompt(request.messages),
    systemPrompt: buildSystemPrompt(request),
    model: requireModel(request.model),
    sessionId: request.user,
  };
}
