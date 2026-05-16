// VOS-87 T4: unit tests for `parseUsageFromAssistantEvent`. The cc-spawner
// calls this on every parsed stream event; we assert null for non-assistant
// events / empty usage, and a fully-populated UsageTurn for the real shape.

import { describe, expect, test } from "bun:test";
import { parseUsageFromAssistantEvent } from "../usage-extract.ts";

describe("parseUsageFromAssistantEvent", () => {
  test("returns null for non-assistant events", () => {
    expect(parseUsageFromAssistantEvent({ type: "system", message: { usage: { input_tokens: 10 } } })).toBeNull();
    expect(parseUsageFromAssistantEvent({ type: "user" })).toBeNull();
  });

  test("returns null when assistant event lacks message", () => {
    expect(parseUsageFromAssistantEvent({ type: "assistant" })).toBeNull();
  });

  test("returns null when assistant event has no usage block", () => {
    expect(
      parseUsageFromAssistantEvent({
        type: "assistant",
        message: { model: "claude-sonnet-4-6" },
      }),
    ).toBeNull();
  });

  test("returns null when usage has zero input and output tokens (tool_use-only partial)", () => {
    expect(
      parseUsageFromAssistantEvent({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ).toBeNull();
  });

  test("returns full UsageTurn for assistant event with usage", () => {
    const result = parseUsageFromAssistantEvent({
      type: "assistant",
      message: {
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
      },
    });
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreateTokens: 10,
      cacheReadTokens: 5,
      model: "claude-sonnet-4-6",
      provider: "claude-code",
    });
  });

  test("defaults cache fields to 0 and model to claude-unknown when absent", () => {
    const result = parseUsageFromAssistantEvent({
      type: "assistant",
      message: {
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    });
    expect(result).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheCreateTokens: 0,
      cacheReadTokens: 0,
      model: "claude-unknown",
      provider: "claude-code",
    });
  });
});
