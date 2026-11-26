/**
 * Prompt-level tool calling: the Claude CLI has no built-in tools here, so
 * client `tools` are described in a proxy-owned system prompt, and the model
 * answers with <tool_call> blocks that the proxy parses back out.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  OpenAIChatRequest,
  OpenAIContentBlock,
  OpenAIToolCall,
} from "../types/openai.js";

/**
 * First line of every system prompt the proxy builds. Tells the model it has
 * no tools of its own, so client tools are the only ones it may call.
 */
export const BASE_SYSTEM_PROMPT =
  "You are a language model behind an OpenAI-compatible API. You have no built-in tools, no file system and no shell. Follow the system instructions below.";

/**
 * Extract text from a content field that may be a string, an array of content
 * blocks, or null. OpenAI API allows content as either:
 *   - A plain string: "Hello"
 *   - An array of content blocks: [{"type": "text", "text": "Hello"}]
 *   - null (e.g. an assistant message that only carries tool_calls)
 */
export function extractText(
  content: string | OpenAIContentBlock[] | null
): string {
  if (content === null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" || block.type === "input_text")
      .map((block) => block.text)
      .join("\n");
  }
  return String(content || "");
}

/**
 * Render a model-issued function call as a <tool_call> block. The arguments
 * string is embedded as parsed JSON when it parses, otherwise as the raw string.
 */
export function formatToolCallBlock(name: string, args: string): string {
  let parsed: unknown = args;
  try {
    parsed = JSON.parse(args);
  } catch {
    // Arguments were not valid JSON; keep the raw string
  }
  return (
    "<tool_call>\n" + JSON.stringify({ name, arguments: parsed }) + "\n</tool_call>"
  );
}

/**
 * Render a client tool result as a <tool_result> block for the next turn.
 * The tool_call_id and name attributes are omitted when undefined.
 */
export function formatToolResult(
  content: string,
  toolCallId?: string,
  name?: string
): string {
  const attrs: string[] = [];
  if (toolCallId !== undefined) {
    attrs.push(`tool_call_id="${toolCallId}"`);
  }
  if (name !== undefined) {
    attrs.push(`name="${name}"`);
  }
  const open = attrs.length ? `<tool_result ${attrs.join(" ")}>` : "<tool_result>";
  return `${open}\n${content}\n</tool_result>`;
}

/**
 * Build the proxy-owned system prompt for a request: the base prompt, then the
 * text of every system/developer message, then (unless tool_choice is "none")
 * a description of the client tools and how to call them.
 */
export function buildSystemPrompt(request: OpenAIChatRequest): string {
  const sections: string[] = [BASE_SYSTEM_PROMPT];

  const systemTexts = request.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => extractText(m.content))
    .filter((text) => text.length > 0);
  if (systemTexts.length > 0) {
    sections.push(systemTexts.join("\n\n"));
  }

  const tools = request.tools ?? [];
  const toolChoice = request.tool_choice;
  if (tools.length > 0 && toolChoice !== "none") {
    const lines: string[] = [
      "# Tools",
      "You can call these client tools. Each has a JSON schema for its arguments.",
    ];
    for (const tool of tools) {
      const fn = tool.function;
      lines.push(`- name: ${fn.name}`);
      lines.push(`  description: ${fn.description || "(none)"}`);
      lines.push(
        `  parameters: ${JSON.stringify(fn.parameters ?? { type: "object", properties: {} })}`
      );
    }
    sections.push(lines.join("\n"));

    sections.push(
      [
        "# How to call tools",
        "To call tools, end your reply with one or more blocks in exactly this form, one JSON object per block:",
        "<tool_call>",
        '{"name": "<tool name>", "arguments": {<arguments matching the schema>}}',
        "</tool_call>",
        "You may write normal text before the blocks. Only call the tools listed above. Never write <tool_result> blocks yourself; stop right after your last tool call. Tool results will arrive in the next message as <tool_result> blocks.",
      ].join("\n")
    );

    if (toolChoice === "required") {
      sections.push("You must call at least one tool in this reply.");
    } else if (toolChoice && typeof toolChoice === "object") {
      sections.push(
        `You must call the tool \`${toolChoice.function.name}\` in this reply.`
      );
    }
  }

  return sections.join("\n\n");
}

/**
 * True when the request declares client tools the model may call. Mirrors the
 * condition under which buildSystemPrompt describes tools.
 */
export function toolsActive(request: OpenAIChatRequest): boolean {
  return (request.tools?.length ?? 0) > 0 && request.tool_choice !== "none";
}

/**
 * Names of the client tools declared on the request.
 */
export function toolNamesOf(request: OpenAIChatRequest): Set<string> {
  return new Set((request.tools ?? []).map((tool) => tool.function.name));
}

const TOOL_CALL_BLOCK = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

/**
 * Parse <tool_call> blocks out of a model reply into OpenAI tool calls.
 *
 * Returns null when the reply has no blocks, or when any block is unusable
 * (bad JSON, a name not in toolNames, or a non-object payload). In that case
 * the caller should treat the whole reply as plain text. Otherwise returns the
 * reply text with the blocks removed (null if nothing is left) and the calls.
 */
export function parseToolCalls(
  text: string,
  toolNames: Set<string>
): { content: string | null; toolCalls: OpenAIToolCall[] } | null {
  const blocks = [...text.matchAll(TOOL_CALL_BLOCK)];
  if (blocks.length === 0) {
    return null;
  }

  const toolCalls: OpenAIToolCall[] = [];
  for (const block of blocks) {
    const reject = (reason: string): null => {
      console.warn("[tools] Unparseable tool call, returning text:", reason);
      return null;
    };

    let payload: unknown;
    try {
      payload = JSON.parse(block[1]);
    } catch {
      return reject("tool call is not valid JSON");
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return reject("tool call is not a JSON object");
    }

    const { name, arguments: args } = payload as {
      name?: unknown;
      arguments?: unknown;
    };
    if (typeof name !== "string" || !toolNames.has(name)) {
      return reject(`unknown tool name ${JSON.stringify(name)}`);
    }

    let argumentsJson: string;
    if (args === undefined || args === null) {
      argumentsJson = "{}";
    } else if (typeof args === "string") {
      // Clients JSON.parse arguments, so a string must itself be valid JSON
      try {
        JSON.parse(args);
      } catch {
        return reject("tool call arguments string is not valid JSON");
      }
      argumentsJson = args;
    } else if (typeof args === "object" && !Array.isArray(args)) {
      argumentsJson = JSON.stringify(args);
    } else {
      return reject("tool call arguments are not an object or string");
    }

    toolCalls.push({
      id: `call_${uuidv4().replace(/-/g, "")}`,
      type: "function",
      function: { name, arguments: argumentsJson },
    });
  }

  const content = text.replace(TOOL_CALL_BLOCK, "").trim();
  return { content: content.length > 0 ? content : null, toolCalls };
}
