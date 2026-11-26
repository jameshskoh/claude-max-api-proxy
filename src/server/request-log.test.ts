// Unit tests for the one-line request summary. Needs no CLI.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { OpenAIUsage } from "../types/openai.js";
import { formatRequestLog, type RequestLogFields } from "./request-log.js";

const USAGE: OpenAIUsage = {
  prompt_tokens: 120,
  completion_tokens: 10,
  total_tokens: 130,
  prompt_tokens_details: { cached_tokens: 100 },
  completion_tokens_details: { reasoning_tokens: 4 },
};

function fields(overrides: Partial<RequestLogFields> = {}): RequestLogFields {
  return {
    requestId: "abc123",
    model: "claude-haiku-4-5",
    stream: false,
    messages: 3,
    tools: 0,
    finish: "stop",
    toolCalls: 0,
    usage: USAGE,
    durationMs: 1234,
    ...overrides,
  };
}

describe("formatRequestLog", () => {
  it("prints every field on one line for a successful request", () => {
    assert.equal(
      formatRequestLog(fields()),
      "[req abc123] model=claude-haiku-4-5 stream=false messages=3 tools=0 finish=stop tool_calls=0 prompt=120 cached=100 completion=10 reasoning=4 1234ms"
    );
  });

  it("reports tool_calls finish with the number of calls and declared tools", () => {
    assert.equal(
      formatRequestLog(
        fields({ stream: true, tools: 2, finish: "tool_calls", toolCalls: 2, durationMs: 77 })
      ),
      "[req abc123] model=claude-haiku-4-5 stream=true messages=3 tools=2 finish=tool_calls tool_calls=2 prompt=120 cached=100 completion=10 reasoning=4 77ms"
    );
  });

  it("appends the error quoted and truncated to 200 characters", () => {
    const line = formatRequestLog(
      fields({
        finish: "error",
        usage: undefined,
        error: "x".repeat(300),
        durationMs: 5,
      })
    );
    assert.equal(
      line,
      `[req abc123] model=claude-haiku-4-5 stream=false messages=3 tools=0 finish=error tool_calls=0 prompt=- cached=- completion=- reasoning=- 5ms error="${"x".repeat(200)}"`
    );
  });

  it("escapes newlines in the error so the line stays on one line", () => {
    const line = formatRequestLog(
      fields({ finish: "error", usage: undefined, error: 'bad\n"quoted"', durationMs: 1 })
    );
    assert.ok(!line.includes("\n"));
    assert.ok(line.endsWith(' error="bad\\n\\"quoted\\""'), line);
  });

  it("prints - for every token count when usage is missing", () => {
    assert.equal(
      formatRequestLog(fields({ finish: "aborted", usage: undefined, durationMs: 9 })),
      "[req abc123] model=claude-haiku-4-5 stream=false messages=3 tools=0 finish=aborted tool_calls=0 prompt=- cached=- completion=- reasoning=- 9ms"
    );
  });

  it("prints - for cached and reasoning counts that the usage leaves out", () => {
    const line = formatRequestLog(
      fields({
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })
    );
    assert.ok(line.includes(" prompt=5 cached=- completion=2 reasoning=- "), line);
  });
});
