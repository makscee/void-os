import { test, expect } from "bun:test";
import { renderTable, truncate, formatJson } from "./output.ts";

test("truncate adds ellipsis past max", () => {
  expect(truncate("hello world", 5)).toBe("hell…");
});

test("truncate leaves short strings", () => {
  expect(truncate("ok", 10)).toBe("ok");
});

test("renderTable lines up two columns", () => {
  const out = renderTable(
    [{ name: "maya", description: "default" }, { name: "scribe", description: "writer" }],
    [{ key: "name", width: 8 }, { key: "description", width: 20 }],
  );
  const lines = out.split("\n");
  expect(lines[0].startsWith("maya")).toBe(true);
  expect(lines[1].startsWith("scribe")).toBe(true);
  expect(lines[0].includes("default")).toBe(true);
});

test("renderTable truncates long descriptions", () => {
  const out = renderTable(
    [{ name: "a", description: "x".repeat(100) }],
    [{ key: "name", width: 4 }, { key: "description", width: 10 }],
  );
  expect(out.includes("…")).toBe(true);
});

test("formatJson is stable + indented", () => {
  expect(formatJson({ b: 1, a: 2 })).toBe('{\n  "b": 1,\n  "a": 2\n}');
});
