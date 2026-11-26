/**
 * OpenAI Chat Completions API types
 */

export interface OpenAIContentBlock {
  type: "text" | "input_text";
  text: string;
}

export interface OpenAIChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | OpenAIContentBlock[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

/**
 * A client-supplied function tool, as sent in the request `tools` array.
 */
export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

/**
 * The request `tool_choice` field: a mode string, or a pin to one named function.
 */
export type OpenAIToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string; // Used for session mapping
  tools?: OpenAIToolDefinition[];
  tool_choice?: OpenAIToolChoice;
  parallel_tool_calls?: boolean;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIToolCallChunk {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIChatResponseChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatResponseChoice[];
  usage: OpenAIUsage;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
  completion_tokens_details?: {
    reasoning_tokens: number;
  };
}

export interface OpenAIChatChunkDelta {
  role?: "assistant";
  content?: string;
  tool_calls?: OpenAIToolCallChunk[];
}

export interface OpenAIChatChunkChoice {
  index: number;
  delta: OpenAIChatChunkDelta;
  finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

export interface OpenAIChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChatChunkChoice[];
  usage?: OpenAIUsage;
}

export interface OpenAIModel {
  id: string;
  object: "model";
  owned_by: string;
  created?: number;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}
