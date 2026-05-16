// daemon/test/ask-user/input-validation.test.ts
//
// VOS-97 T3: AskUserInput (z.object) + ASK_USER_TOOL_DEF (JSON Schema literal)
// removed in favour of `askUserInput` (Zod raw shape) + `askUserDef`. The
// validation behaviour is now exercised by wrapping the raw shape with
// `z.object(...)` — `McpServer.registerTool` does the equivalent at wire time.
import { describe, it, expect } from "bun:test";
// VOS-97 T5: tool input shapes are zod@3 (the MCP SDK's bundled version).
// The project's top-level `zod` is v4 with different prototypes; wrapping a
// v3 raw shape with v4 `z.object(...)` throws `_parse is not a function`.
import { z } from "zod/v3";
import { askUserInput, askUserDef } from "../../src/adapters/mcp/tools/ask-user";

const AskUserInput = z.object(askUserInput);

describe("askUserInput (Zod raw shape, wrapped for validation)", () => {
  it("accepts a minimal question", () => {
    expect(() => AskUserInput.parse({ question: "ok?" })).not.toThrow();
  });
  it("accepts question + options up to 6 items", () => {
    expect(() => AskUserInput.parse({ question: "ok?", options: ["a","b","c","d","e","f"] })).not.toThrow();
  });
  it("rejects empty question", () => {
    expect(() => AskUserInput.parse({ question: "" })).toThrow();
  });
  it("rejects question longer than 500 chars", () => {
    expect(() => AskUserInput.parse({ question: "x".repeat(501) })).toThrow();
  });
  it("rejects more than 6 options", () => {
    expect(() => AskUserInput.parse({ question: "ok?", options: Array(7).fill("a") })).toThrow();
  });
  it("rejects option longer than 80 chars", () => {
    expect(() => AskUserInput.parse({ question: "ok?", options: ["x".repeat(81)] })).toThrow();
  });
  it("rejects empty option string", () => {
    expect(() => AskUserInput.parse({ question: "ok?", options: [""] })).toThrow();
  });
});

describe("askUserDef", () => {
  it("exposes a Zod raw-shape inputSchema with question + options", () => {
    const shape = askUserDef.inputSchema as Record<string, unknown>;
    expect(shape.question).toBeDefined();
    expect(shape.options).toBeDefined();
  });
});
