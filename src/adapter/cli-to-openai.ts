/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliAssistant, ClaudeCliResult } from "../types/claude-cli.js";
import type {
  OpenAIChatChunkDelta,
  OpenAIChatResponse,
  OpenAIChatChunk,
  OpenAIToolCall,
} from "../types/openai.js";

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
    content: content !== undefined ? content : result.result,
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
    usage: {
      prompt_tokens: result.usage?.input_tokens || 0,
      completion_tokens: result.usage?.output_tokens || 0,
      total_tokens:
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
    },
  };
}
