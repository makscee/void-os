import { describe, test, expect } from "bun:test";
import { normalizeOutput } from "../src/chat/tools/normalize";
import { normalizeToolOutput } from "../src/chat/reducer";

describe("normalizeOutput / normalizeToolOutput", () => {
  test("returns string as-is", () => {
    expect(normalizeOutput("hi")).toBe("hi");
    expect(normalizeToolOutput("hi")).toBe("hi");
  });

  test("joins block array text fields", () => {
    expect(normalizeOutput([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab");
    expect(normalizeToolOutput([{ type: "text", text: "a\n" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  test("treats null/undefined as empty", () => {
    expect(normalizeOutput(null)).toBe("");
    expect(normalizeOutput(undefined)).toBe("");
  });

  test("falls back to JSON for unexpected shapes", () => {
    expect(normalizeOutput({ a: 1 })).toBe('{"a":1}');
  });

  test("skips block items without text", () => {
    expect(normalizeOutput([{ type: "image" } as any, { type: "text", text: "ok" }])).toBe("ok");
  });
});
