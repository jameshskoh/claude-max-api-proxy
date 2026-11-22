// Unit tests for model ID parsing. Needs no CLI.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractModel, SUPPORTED_MODELS } from "./openai-to-cli.js";

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
