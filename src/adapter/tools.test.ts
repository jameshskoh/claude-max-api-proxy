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
