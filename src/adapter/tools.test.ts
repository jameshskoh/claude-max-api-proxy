// Unit tests for prompt-level tool calling helpers. Needs no CLI.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  OpenAIChatRequest,
  OpenAIToolDefinition,
} from "../types/openai.js";
import {
  BASE_SYSTEM_PROMPT,
  buildSystemPrompt,
  parseToolCalls,
  toolNamesOf,
  toolsActive,
} from "./tools.js";

const WEATHER_TOOL: OpenAIToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Look up the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

const TOOL_NAMES = new Set(["get_weather"]);

function request(overrides: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
  return {
    model: "claude-haiku-4-5",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

function toolCallBlock(payload: unknown): string {
  return `<tool_call>\n${JSON.stringify(payload)}\n</tool_call>`;
}

describe("parseToolCalls", () => {
  it("parses a single valid block into one OpenAI tool call", () => {
    const result = parseToolCalls(
      toolCallBlock({ name: "get_weather", arguments: { city: "Paris" } }),
      TOOL_NAMES
    );

    assert.ok(result, "expected the block to parse");
    assert.equal(result.content, null);
    assert.equal(result.toolCalls.length, 1);
    const [call] = result.toolCalls;
    assert.equal(call.type, "function");
    assert.match(call.id, /^call_[0-9a-f]{32}$/);
    assert.equal(call.function.name, "get_weather");
    assert.equal(call.function.arguments, '{"city":"Paris"}');
  });

  it("keeps text before two blocks as content and returns both calls in order", () => {
    const text = [
      "Let me check both cities.",
      toolCallBlock({ name: "get_weather", arguments: { city: "Paris" } }),
      toolCallBlock({ name: "get_weather", arguments: { city: "Tokyo" } }),
    ].join("\n");

    const result = parseToolCalls(text, TOOL_NAMES);

    assert.ok(result, "expected both blocks to parse");
    assert.equal(result.content, "Let me check both cities.");
    assert.deepEqual(
      result.toolCalls.map((call) => call.function.arguments),
      ['{"city":"Paris"}', '{"city":"Tokyo"}']
    );
    assert.notEqual(result.toolCalls[0].id, result.toolCalls[1].id);
  });

  it("keeps a string arguments value exactly as given", () => {
    const result = parseToolCalls(
      toolCallBlock({ name: "get_weather", arguments: '{"city": "Paris"}' }),
      TOOL_NAMES
    );

    assert.ok(result, "expected the block to parse");
    assert.equal(result.toolCalls[0].function.arguments, '{"city": "Paris"}');
  });

  it("returns null when a string arguments value is not valid JSON", (t) => {
    t.mock.method(console, "warn", () => {});
    const text = toolCallBlock({ name: "get_weather", arguments: "city=Paris" });

    assert.equal(parseToolCalls(text, TOOL_NAMES), null);
  });

  it("uses an empty object when arguments are missing", () => {
    const result = parseToolCalls(toolCallBlock({ name: "get_weather" }), TOOL_NAMES);

    assert.ok(result, "expected the block to parse");
    assert.equal(result.toolCalls[0].function.arguments, "{}");
  });

  it("returns null when a block is not valid JSON", (t) => {
    t.mock.method(console, "warn", () => {});
    const text = '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"\n</tool_call>';

    assert.equal(parseToolCalls(text, TOOL_NAMES), null);
  });

  it("returns null when a block's payload is not a JSON object", (t) => {
    t.mock.method(console, "warn", () => {});

    assert.equal(parseToolCalls("<tool_call>\n[1, 2]\n</tool_call>", TOOL_NAMES), null);
  });

  it("returns null when a block names a tool that was not offered", (t) => {
    t.mock.method(console, "warn", () => {});

    assert.equal(
      parseToolCalls(
        toolCallBlock({ name: "delete_files", arguments: {} }),
        TOOL_NAMES
      ),
      null
    );
  });

  it("returns null for the whole reply when only one of several blocks is bad", (t) => {
    t.mock.method(console, "warn", () => {});
    const text = [
      toolCallBlock({ name: "get_weather", arguments: { city: "Paris" } }),
      toolCallBlock({ name: "delete_files", arguments: {} }),
    ].join("\n");

    assert.equal(parseToolCalls(text, TOOL_NAMES), null);
  });

  it("returns null when the reply has no tool call blocks", () => {
    assert.equal(parseToolCalls("Just a normal answer.", TOOL_NAMES), null);
  });

  it("does not end a block at a closing tag inside a string argument", () => {
    const commentTools = new Set(["post_comment"]);
    const block = toolCallBlock({
      name: "post_comment",
      arguments: { body: "Stray </tool_call> tag in the reply." },
    });

    const result = parseToolCalls(`Here is my review.\n${block}`, commentTools);

    assert.ok(result, "expected the block to parse");
    assert.equal(result.content, "Here is my review.");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(
      result.toolCalls[0].function.arguments,
      JSON.stringify({ body: "Stray </tool_call> tag in the reply." })
    );
  });

  it("ignores opening tags and braces inside a string argument", () => {
    const commentTools = new Set(["post_comment"]);
    const body = "Use <tool_call> and {braces} like } this {";
    const block = toolCallBlock({ name: "post_comment", arguments: { body } });

    const result = parseToolCalls(block, commentTools);

    assert.ok(result, "expected the block to parse");
    assert.equal(result.content, null);
    assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { body });
  });

  it("handles escaped quotes and backslashes inside strings", () => {
    const args = { path: 'C:\\temp\\', quote: 'Say "hi" then }', tail: 'a\\"}' };
    const result = parseToolCalls(toolCallBlock({ name: "get_weather", arguments: args }), TOOL_NAMES);

    assert.ok(result, "expected the block to parse");
    assert.equal(result.toolCalls.length, 1);
    assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), args);
  });

  it("skips prose that mentions the opening tag and parses the real block after it", () => {
    const text = [
      "Emit <tool_call> blocks only when you call a tool.",
      toolCallBlock({ name: "get_weather", arguments: { city: "Paris" } }),
    ].join("\n");

    const result = parseToolCalls(text, TOOL_NAMES);

    assert.ok(result, "expected the real block to parse");
    assert.equal(result.content, "Emit <tool_call> blocks only when you call a tool.");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.arguments, '{"city":"Paris"}');
  });

  it("returns null when the reply only mentions the opening tag in prose", () => {
    assert.equal(
      parseToolCalls("You write <tool_call> tags around JSON. Never mind.", TOOL_NAMES),
      null
    );
  });

  it("returns null for the whole reply when a later block has unbalanced braces", (t) => {
    t.mock.method(console, "warn", () => {});
    const text = [
      toolCallBlock({ name: "get_weather", arguments: { city: "Paris" } }),
      '<tool_call>\n{"name": "get_weather", "arguments": {\n</tool_call>',
    ].join("\n");

    assert.equal(parseToolCalls(text, TOOL_NAMES), null);
  });

  it("returns null when the JSON object is never closed", (t) => {
    t.mock.method(console, "warn", () => {});
    const text = '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}\n';

    assert.equal(parseToolCalls(text, TOOL_NAMES), null);
  });

  it("returns null when the closing tag is missing after the JSON", (t) => {
    t.mock.method(console, "warn", () => {});
    const text = '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n';

    assert.equal(parseToolCalls(text, TOOL_NAMES), null);
  });
});

describe("buildSystemPrompt", () => {
  it("starts with the base line and appends system and developer text", () => {
    const prompt = buildSystemPrompt(
      request({
        messages: [
          { role: "system", content: "Answer in one word." },
          { role: "user", content: "USER-ONLY-TEXT" },
          {
            role: "developer",
            content: [{ type: "text", text: "Never mention forecasts." }],
          },
        ],
      })
    );

    assert.ok(prompt.startsWith(BASE_SYSTEM_PROMPT));
    assert.ok(prompt.includes("Answer in one word."));
    assert.ok(prompt.includes("Never mention forecasts."));
    assert.ok(!prompt.includes("USER-ONLY-TEXT"), "user text must not enter the system prompt");
    assert.ok(!prompt.includes("# Tools"), "no tools were declared");
  });

  it("includes the tool catalog and call protocol when tools are present", () => {
    const prompt = buildSystemPrompt(request({ tools: [WEATHER_TOOL] }));

    assert.ok(prompt.includes("# Tools"));
    assert.ok(prompt.includes("- name: get_weather"));
    assert.ok(prompt.includes("Look up the weather for a city"));
    assert.ok(prompt.includes(JSON.stringify(WEATHER_TOOL.function.parameters)));
    assert.ok(prompt.includes("# How to call tools"));
    assert.ok(prompt.includes("<tool_call>"));
    assert.ok(!prompt.includes("You must call"), "auto should not force a call");
  });

  it("omits the catalog and protocol when tool_choice is none", () => {
    const prompt = buildSystemPrompt(
      request({ tools: [WEATHER_TOOL], tool_choice: "none" })
    );

    assert.ok(prompt.startsWith(BASE_SYSTEM_PROMPT));
    assert.ok(!prompt.includes("# Tools"));
    assert.ok(!prompt.includes("# How to call tools"));
    assert.ok(!prompt.includes("get_weather"));
  });

  it("omits the catalog and protocol when no tools are declared", () => {
    for (const tools of [undefined, []]) {
      const prompt = buildSystemPrompt(request({ tools }));
      assert.ok(!prompt.includes("# Tools"));
      assert.ok(!prompt.includes("# How to call tools"));
    }
  });

  it("adds a must-call line for tool_choice required", () => {
    const prompt = buildSystemPrompt(
      request({ tools: [WEATHER_TOOL], tool_choice: "required" })
    );

    assert.ok(prompt.includes("You must call at least one tool in this reply."));
  });

  it("adds a line naming the function for a named tool_choice", () => {
    const prompt = buildSystemPrompt(
      request({
        tools: [WEATHER_TOOL],
        tool_choice: { type: "function", function: { name: "get_weather" } },
      })
    );

    assert.ok(prompt.includes("You must call the tool `get_weather` in this reply."));
  });
});

describe("toolsActive", () => {
  it("is true when tools are declared and tool_choice is not none", () => {
    assert.equal(toolsActive(request({ tools: [WEATHER_TOOL] })), true);
    assert.equal(toolsActive(request({ tools: [WEATHER_TOOL], tool_choice: "auto" })), true);
    assert.equal(toolsActive(request({ tools: [WEATHER_TOOL], tool_choice: "required" })), true);
  });

  it("is false when tool_choice is none, or no tools are declared", () => {
    assert.equal(toolsActive(request({ tools: [WEATHER_TOOL], tool_choice: "none" })), false);
    assert.equal(toolsActive(request()), false);
    assert.equal(toolsActive(request({ tools: [] })), false);
  });
});

describe("toolNamesOf", () => {
  it("returns the names of the declared tools", () => {
    assert.deepEqual([...toolNamesOf(request({ tools: [WEATHER_TOOL] }))], ["get_weather"]);
    assert.equal(toolNamesOf(request()).size, 0);
  });
});

/** Run fn with console.warn captured, returning what it was called with. */
function captureWarnings(fn: () => void): string[] {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

describe("parseToolCalls unparseable warning", () => {
  const BAD_REPLY =
    'Let me check.\n<tool_call>\n{"name": "get_weather", "arguments": }\n</tool_call>';

  it("includes the request id and a snippet starting at the failing block", () => {
    let result: unknown;
    const warnings = captureWarnings(() => {
      result = parseToolCalls(BAD_REPLY, TOOL_NAMES, "req123");
    });

    assert.equal(result, null);
    assert.equal(warnings.length, 1);
    const [warning] = warnings;
    assert.ok(
      warning.startsWith(
        "[req req123] [tools] Unparseable tool call, returning text: tool call is not valid JSON; snippet="
      ),
      warning
    );
    // Snippet is JSON-encoded from the opening tag, so newlines stay escaped
    assert.ok(warning.endsWith('snippet="<tool_call>\\n{\\"name\\": \\"get_weather\\", \\"arguments\\": }\\n</tool_call>"'), warning);
    assert.ok(!warning.includes("Let me check"));
    assert.ok(!warning.includes("\n"));
  });

  it("has no request prefix when no request id is given", () => {
    const warnings = captureWarnings(() => {
      parseToolCalls(BAD_REPLY, TOOL_NAMES);
    });

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].startsWith("[tools] Unparseable tool call, returning text: "), warnings[0]);
  });
});
