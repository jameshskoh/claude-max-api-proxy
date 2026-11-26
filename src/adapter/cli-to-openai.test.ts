// Unit tests for building OpenAI responses from CLI results. Needs no CLI.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIToolCall } from "../types/openai.js";
import { cliResultToOpenai, cliUsageToOpenai, createDoneChunk } from "./cli-to-openai.js";

const MODEL = "claude-haiku-4-5";

const RESULT: ClaudeCliResult = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 10,
  duration_api_ms: 8,
  num_turns: 1,
  result: "Let me check.",
  session_id: "session-1",
  total_cost_usd: 0,
  usage: { input_tokens: 12, output_tokens: 7 },
  modelUsage: {},
};

const WEATHER_CALL: OpenAIToolCall = {
  id: "call_0123456789abcdef0123456789abcdef",
  type: "function",
  function: { name: "get_weather", arguments: '{"city":"Paris"}' },
};

describe("cliResultToOpenai", () => {
  it("returns tool_calls with null content and finish_reason tool_calls", () => {
    const response = cliResultToOpenai(RESULT, "abc", MODEL, [WEATHER_CALL], null);

    const choice = response.choices[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.content, null);
    assert.deepEqual(choice.message.tool_calls, [WEATHER_CALL]);
    assert.equal(choice.message.role, "assistant");
  });

  it("returns the text with finish_reason stop when there are no tool calls", () => {
    const response = cliResultToOpenai(RESULT, "abc", MODEL);

    const choice = response.choices[0];
    assert.equal(choice.finish_reason, "stop");
    assert.equal(choice.message.content, "Let me check.");
    assert.equal(choice.message.tool_calls, undefined);
    assert.equal(response.id, "chatcmpl-abc");
    assert.equal(response.model, MODEL);
  });

  it("treats an empty tool_calls array as a plain reply", () => {
    const response = cliResultToOpenai(RESULT, "abc", MODEL, [], null);

    const choice = response.choices[0];
    assert.equal(choice.finish_reason, "stop");
    assert.equal(choice.message.tool_calls, undefined);
  });
});

describe("cliUsageToOpenai", () => {
  it("adds cache reads and cache writes into prompt_tokens when all fields are present", () => {
    const usage = cliUsageToOpenai({
      input_tokens: 2,
      output_tokens: 7,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 30,
    });

    assert.deepEqual(usage, {
      prompt_tokens: 132,
      completion_tokens: 7,
      total_tokens: 139,
      prompt_tokens_details: { cached_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it("reports CLI thinking tokens as reasoning tokens inside completion_tokens", () => {
    const usage = cliUsageToOpenai({
      input_tokens: 2,
      output_tokens: 50,
      output_tokens_details: { thinking_tokens: 40 },
    });

    assert.equal(usage.completion_tokens, 50);
    assert.equal(usage.total_tokens, 52);
    assert.deepEqual(usage.completion_tokens_details, { reasoning_tokens: 40 });
  });

  it("counts missing cache fields as zero", () => {
    const usage = cliUsageToOpenai({ input_tokens: 12, output_tokens: 7 });

    assert.deepEqual(usage, {
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it("returns zeros when usage is missing entirely", () => {
    const usage = cliUsageToOpenai(undefined);

    assert.deepEqual(usage, {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
  });
});

describe("cliResultToOpenai usage", () => {
  it("reports prompt_tokens including cached input", () => {
    const response = cliResultToOpenai(
      {
        ...RESULT,
        usage: {
          input_tokens: 2,
          output_tokens: 7,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 0,
        },
      },
      "abc",
      MODEL
    );

    assert.deepEqual(response.usage, {
      prompt_tokens: 5002,
      completion_tokens: 7,
      total_tokens: 5009,
      prompt_tokens_details: { cached_tokens: 5000 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
  });
});

describe("createDoneChunk", () => {
  it("sets finish_reason tool_calls when asked", () => {
    const chunk = createDoneChunk("abc", MODEL, "tool_calls");

    assert.equal(chunk.id, "chatcmpl-abc");
    assert.equal(chunk.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(chunk.choices[0].delta, {});
  });

  it("defaults finish_reason to stop", () => {
    assert.equal(createDoneChunk("abc", MODEL).choices[0].finish_reason, "stop");
  });
});
