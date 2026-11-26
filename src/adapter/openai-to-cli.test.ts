// Unit tests for model ID parsing and prompt rendering. Needs no CLI.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  OpenAIChatMessage,
  OpenAIChatRequest,
} from "../types/openai.js";
import {
  extractModel,
  messagesToPrompt,
  openaiToCli,
  openaiToCliDelta,
  SUPPORTED_MODELS,
} from "./openai-to-cli.js";
import { buildSystemPrompt } from "./tools.js";

const WEATHER_CALL_ID = "call_weather_1";

const TOOL_EXCHANGE: OpenAIChatMessage[] = [
  { role: "system", content: "SECRET-SYSTEM-TEXT" },
  { role: "user", content: "What's the weather in Paris?" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: WEATHER_CALL_ID,
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      },
    ],
  },
  { role: "tool", tool_call_id: WEATHER_CALL_ID, content: "18C and sunny" },
];

function chatRequest(messages: OpenAIChatMessage[]): OpenAIChatRequest {
  return { model: "claude-haiku-4-5", messages };
}

/** Parse the JSON body of every <tool_call> block in a prompt. */
function toolCallPayloads(prompt: string): unknown[] {
  return [...prompt.matchAll(/<tool_call>\n([\s\S]*?)\n<\/tool_call>/g)].map((m) =>
    JSON.parse(m[1])
  );
}

describe("extractModel", () => {
  it("returns every supported ID unchanged", () => {
    for (const id of SUPPORTED_MODELS) {
      assert.equal(extractModel(id), id);
    }
  });

  it("strips the claude-code-cli/ and claude-max/ prefixes", () => {
    assert.equal(extractModel("claude-code-cli/claude-opus-5-5"), "claude-opus-5-5");
    assert.equal(extractModel("claude-max/claude-haiku-4-5"), "claude-haiku-4-5");
  });

  it("returns null for unsupported or invalid models", () => {
    for (const bad of [
      "claude-opus-4",
      "haiku",
      "opus-max",
      "constructor",
      "",
      undefined,
      null,
      42,
    ]) {
      assert.equal(extractModel(bad), null, `expected null for ${String(bad)}`);
    }
  });
});

describe("messagesToPrompt with tool calls", () => {
  it("keeps system text out of the prompt and renders the tool exchange", () => {
    const prompt = messagesToPrompt(TOOL_EXCHANGE);

    assert.ok(!prompt.includes("SECRET-SYSTEM-TEXT"), "system text belongs in the system prompt");
    assert.ok(prompt.includes("What's the weather in Paris?"));
    assert.ok(prompt.includes("<previous_response>"));
    assert.ok(prompt.includes("</previous_response>"));
    assert.deepEqual(toolCallPayloads(prompt), [
      { name: "get_weather", arguments: { city: "Paris" } },
    ]);
    assert.ok(
      prompt.includes(
        `<tool_result tool_call_id="${WEATHER_CALL_ID}" name="get_weather">\n18C and sunny\n</tool_result>`
      ),
      "tool result should carry its call id and the resolved name"
    );
  });
});

describe("openaiToCliDelta", () => {
  it("renders a new tool-only slice with the name resolved from the earlier assistant", () => {
    const request = chatRequest(TOOL_EXCHANGE);

    const cli = openaiToCliDelta(request, 3);

    assert.equal(
      cli.prompt,
      `<tool_result tool_call_id="${WEATHER_CALL_ID}" name="get_weather">\n18C and sunny\n</tool_result>`
    );
  });

  it("falls back to the full history when the new slice renders nothing", () => {
    const request = chatRequest([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "system", content: "A new instruction." },
    ]);

    const cli = openaiToCliDelta(request, 2);

    assert.equal(cli.prompt, messagesToPrompt(request.messages));
    assert.ok(cli.prompt.includes("hi"));
    assert.ok(cli.prompt.includes("hello"));
  });
});

describe("openaiToCli system prompt", () => {
  it("sets systemPrompt from the system text and declared tools, not the user prompt", () => {
    const request: OpenAIChatRequest = {
      model: "claude-haiku-4-5",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "What's the weather in Paris?" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", description: "Weather lookup" },
        },
      ],
    };

    const cli = openaiToCli(request);

    assert.equal(cli.systemPrompt, buildSystemPrompt(request));
    assert.ok(cli.systemPrompt.includes("Be terse."));
    assert.ok(cli.systemPrompt.includes("- name: get_weather"));
    assert.ok(!cli.prompt.includes("Be terse."));
    assert.equal(cli.prompt, "What's the weather in Paris?");
  });
});
