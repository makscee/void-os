// daemon/test/ask-user/input-validation.test.ts
import { describe, it, expect } from "bun:test";
import { AskUserInput, ASK_USER_TOOL_DEF } from "../../src/adapters/mcp/tools/ask-user";

describe("AskUserInput", () => {
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

describe("ASK_USER_TOOL_DEF", () => {
  it("has name 'ask_user' and a JSON-Schema inputSchema", () => {
    expect(ASK_USER_TOOL_DEF.name).toBe("ask_user");
    expect(ASK_USER_TOOL_DEF.inputSchema.type).toBe("object");
    expect(ASK_USER_TOOL_DEF.inputSchema.properties.question).toBeDefined();
  });
});
