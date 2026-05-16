import { describe, test, expect } from "bun:test";
import { classifyToolEvents } from "../parser";

describe("classifyToolEvents", () => {
  test("returns tool.call for tool_use blocks", () => {
    const ev = { message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { cmd: "ls" } }] } };
    expect(classifyToolEvents(ev)).toEqual([
      { kind: "tool.call", toolUseId: "tu_1", name: "Bash", input: { cmd: "ls" } },
    ]);
  });

  test("returns tool.result for tool_result blocks", () => {
    const ev = { message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }] } };
    expect(classifyToolEvents(ev)).toEqual([
      { kind: "tool.result", toolUseId: "tu_1", content: "ok", isError: false },
    ]);
  });

  test("returns empty for plain text events", () => {
    expect(classifyToolEvents({ message: { content: [{ type: "text", text: "hi" }] } })).toEqual([]);
  });

  test("returns empty for malformed events", () => {
    expect(classifyToolEvents(null)).toEqual([]);
    expect(classifyToolEvents({})).toEqual([]);
    expect(classifyToolEvents({ message: { content: "nope" } })).toEqual([]);
  });
});
