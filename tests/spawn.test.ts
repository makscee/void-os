import { expect, test } from "bun:test";
import { buildLaunchArgv, buildAnswerArgv } from "../src/spawn.ts";

test("launch argv: slash command + optional text after vc passthrough", () => {
  expect(buildLaunchArgv("u1", "deep-research", "AI safety")).toEqual([
    "--", "--session-id", "u1",
    "-p", "/deep-research AI safety",
    "--permission-mode", "bypassPermissions",
  ]);
});

test("launch argv with no text omits trailing space", () => {
  const argv = buildLaunchArgv("u1", "onboarding", "");
  expect(argv[4]).toBe("/onboarding");
  // no trailing space
  expect(argv[4]).not.toContain(" ");
});

test("answer argv: resume + render-contract preamble before text", () => {
  const a = buildAnswerArgv("u1", "use option B");
  expect(a.slice(0, 3)).toEqual(["--", "--resume", "u1"]);
  expect(a[4]).toBe("[render contract: rewrite body.html, no terminal reply]\nuse option B");
});

test("answer argv has correct shape: -- --resume uuid -p <preamble+text> --permission-mode bypassPermissions", () => {
  const a = buildAnswerArgv("my-uuid", "hello");
  expect(a).toHaveLength(7);
  expect(a[0]).toBe("--");
  expect(a[1]).toBe("--resume");
  expect(a[2]).toBe("my-uuid");
  expect(a[3]).toBe("-p");
  expect(a[5]).toBe("--permission-mode");
  expect(a[6]).toBe("bypassPermissions");
});

test("answer argv from form fields: key: value lines", () => {
  const fields = { name: "Alice", goal: "learn TypeScript" };
  const prompt = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
  const a = buildAnswerArgv("sess-1", prompt);
  expect(a[4]).toContain("name: Alice");
  expect(a[4]).toContain("goal: learn TypeScript");
});
