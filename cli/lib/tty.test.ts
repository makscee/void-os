import { test, expect } from "bun:test";
import { ansi, stripAnsi, useColor } from "./tty";

test("ansi.dim wraps with dim+reset escapes when enabled", () => {
  expect(ansi(true).dim("x")).toBe("\x1b[2mx\x1b[0m");
});

test("ansi.dim is a no-op when disabled", () => {
  expect(ansi(false).dim("x")).toBe("x");
});

test("ansi.red wraps with red+reset when enabled", () => {
  expect(ansi(true).red("err")).toBe("\x1b[31merr\x1b[0m");
});

test("ansi.red is a no-op when disabled", () => {
  expect(ansi(false).red("err")).toBe("err");
});

test("stripAnsi removes all SGR sequences", () => {
  expect(stripAnsi("\x1b[2mhello\x1b[0m \x1b[31mworld\x1b[0m")).toBe("hello world");
});

test("useColor reads isTTY from a stream-like object", () => {
  expect(useColor({ isTTY: true })).toBe(true);
  expect(useColor({ isTTY: false })).toBe(false);
  expect(useColor({} as { isTTY?: boolean })).toBe(false);
});
