/**
 * One-line operational summary for a chat-completion request. Pure formatting:
 * the route collects the fields and decides when the request has finished.
 */

import type { OpenAIUsage } from "../types/openai.js";

export type RequestFinish = "stop" | "tool_calls" | "error" | "aborted";

export interface RequestLogFields {
  requestId: string;
  model: string;
  stream: boolean;
  messages: number;
  tools: number;
  finish: RequestFinish;
  /** Tool calls returned to the client (0 when none). */
  toolCalls: number;
  /** Token usage; absent when the request produced none (errors, aborts). */
  usage?: OpenAIUsage;
  /** Error message; printed quoted and cut to a fixed length. */
  error?: string;
  durationMs: number;
}

const ERROR_MAX_CHARS = 200;

function count(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

/**
 * Format the summary line for one request. The model name and error text are
 * escaped so the line stays on one line whatever the client sent.
 */
export function formatRequestLog(fields: RequestLogFields): string {
  const usage = fields.usage;
  const model = JSON.stringify(fields.model).slice(1, -1);
  const parts = [
    `[req ${fields.requestId}]`,
    `model=${model}`,
    `stream=${fields.stream}`,
    `messages=${fields.messages}`,
    `tools=${fields.tools}`,
    `finish=${fields.finish}`,
    `tool_calls=${fields.toolCalls}`,
    `prompt=${count(usage?.prompt_tokens)}`,
    `cached=${count(usage?.prompt_tokens_details?.cached_tokens)}`,
    `completion=${count(usage?.completion_tokens)}`,
    `reasoning=${count(usage?.completion_tokens_details?.reasoning_tokens)}`,
    `${fields.durationMs}ms`,
  ];
  let line = parts.join(" ");
  if (fields.error !== undefined) {
    line += ` error=${JSON.stringify(fields.error.slice(0, ERROR_MAX_CHARS))}`;
  }
  return line;
}
