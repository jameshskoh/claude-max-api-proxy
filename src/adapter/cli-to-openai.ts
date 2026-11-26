/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type {
  OpenAIChatChunkDelta,
  OpenAIChatResponse,
  OpenAIChatChunk,
  OpenAIToolCall,
  OpenAIUsage,
} from "../types/openai.js";

/**
 * Convert CLI token usage to OpenAI usage. Anthropic's input_tokens leaves out
 * cached tokens, so prompt_tokens adds cache reads and cache writes back in.
 * Thinking tokens are already part of output_tokens, as reasoning tokens are
 * part of OpenAI's completion_tokens, so they are only broken out as a detail.
 * Missing usage or missing fields count as zero.
 */
export function cliUsageToOpenai(
  usage: ClaudeCliResult["usage"] | undefined
): OpenAIUsage {
  const inputTokens = usage?.input_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;
  const cacheReadTokens = usage?.cache_read_input_tokens || 0;
  const cacheCreationTokens = usage?.cache_creation_input_tokens || 0;
  const thinkingTokens = usage?.output_tokens_details?.thinking_tokens || 0;
  const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: cacheReadTokens },
    completion_tokens_details: { reasoning_tokens: thinkingTokens },
  };
}

/**
 * Extract text content from Claude CLI assistant message
 */
export function extractTextContent(message: ClaudeCliAssistant): string {
  return message.message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n\n");
}

/**
 * Convert Claude CLI assistant message to OpenAI streaming chunk
 */
export function cliToOpenaiChunk(
  message: ClaudeCliAssistant,
  requestId: string,
  isFirst: boolean = false
): OpenAIChatChunk {
  const text = extractTextContent(message);

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: message.message.model,
    choices: [
      {
        index: 0,
        delta: {
          role: isFirst ? "assistant" : undefined,
          content: text,
        },
        finish_reason: message.message.stop_reason ? "stop" : null,
      },
    ],
  };
}

/**
 * Create a streaming chunk with an arbitrary delta and no finish reason
 */
export function createDeltaChunk(
  requestId: string,
  model: string,
  delta: OpenAIChatChunkDelta
): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
      },
    ],
  };
}

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(
  requestId: string,
  model: string,
  finishReason: "stop" | "tool_calls" = "stop"
): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
}

/**
 * Message for a result that reports a failure, or null when the result is a
 * normal reply. Looks at is_error only, not the subtype. Error results may have
 * no reply text, so the message falls back to the CLI's error list, then to the subtype.
 */
export function cliResultErrorMessage(result: ClaudeCliResult): string | null {
  if (!result.is_error) return null;
  if (result.result) return result.result;
  const errors = "errors" in result ? result.errors : undefined;
  const joined = Array.isArray(errors) ? errors.join("; ") : "";
  if (joined) return joined;
  return `Claude CLI error: ${result.subtype}`;
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response.
 *
 * `content` overrides the text taken from the result (null when a reply is
 * entirely tool calls). Non-empty `toolCalls` make the reply a tool-call reply.
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  model: string,
  toolCalls?: OpenAIToolCall[],
  content?: string | null
): OpenAIChatResponse {
  const message: OpenAIChatResponse["choices"][0]["message"] = {
    role: "assistant",
    content: content !== undefined ? content : (result.result ?? ""),
  };

  const hasToolCalls = toolCalls !== undefined && toolCalls.length > 0;
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: hasToolCalls ? "tool_calls" : "stop",
      },
    ],
    usage: cliUsageToOpenai(result.usage),
  };
}
