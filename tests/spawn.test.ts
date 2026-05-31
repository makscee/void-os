import { expect, test } from "bun:test";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { buildLaunchArgv, buildAnswerArgv, tokenizeCommand, spawnTurn } from "../src/spawn.ts";
import { pidPath, sessionDir } from "../src/paths.ts";

test("buildLaunchArgv has no leading -- (separator now lives in runner command)", () => {
  const a = buildLaunchArgv("uuid-1", "deep-research", "hello");
  expect(a[0]).toBe("--session-id");
  expect(a).not.toContain("--");
  expect(a).toEqual(["--session-id", "uuid-1", "-p", "/deep-research hello", "--permission-mode", "bypassPermissions"]);
});

test("launch argv with no text omits trailing space", () => {
  const argv = buildLaunchArgv("u1", "onboarding", "");
  expect(argv[0]).toBe("--session-id");
  expect(argv[3]).toBe("/onboarding");
  // no trailing space
  expect(argv[3]).not.toContain(" ");
});

test("buildAnswerArgv has no leading --", () => {
  const a = buildAnswerArgv("uuid-1", "echo: hi");
  expect(a[0]).toBe("--resume");
  expect(a).not.toContain("--");
});

test("answer argv: resume + render-contract preamble before text", () => {
  const a = buildAnswerArgv("u1", "use option B");
  expect(a.slice(0, 2)).toEqual(["--resume", "u1"]);
  expect(a[3]).toBe("[render contract: rewrite body.html, no terminal reply]\nuse option B");
});

test("answer argv has correct shape: --resume uuid -p <preamble+text> --permission-mode bypassPermissions", () => {
  const a = buildAnswerArgv("my-uuid", "hello");
  expect(a).toHaveLength(6);
  expect(a[0]).toBe("--resume");
  expect(a[1]).toBe("my-uuid");
  expect(a[2]).toBe("-p");
  expect(a[4]).toBe("--permission-mode");
  expect(a[5]).toBe("bypassPermissions");
});

test("answer argv from form fields: key: value lines", () => {
  const fields = { name: "Alice", goal: "learn TypeScript" };
  const prompt = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
  const a = buildAnswerArgv("sess-1", prompt);
  expect(a[3]).toContain("name: Alice");
  expect(a[3]).toContain("goal: learn TypeScript");
});

test("tokenizeCommand splits prefix into argv head", () => {
  expect(tokenizeCommand("vc --")).toEqual(["vc", "--"]);
  expect(tokenizeCommand("claude_artem")).toEqual(["claude_artem"]);
  expect(tokenizeCommand("  vc   -- ")).toEqual(["vc", "--"]);
});

test("spawnTurn persists the child pid to vc.pid", async () => {
  const vault = "/tmp/void-os-spawn-pid-test";
  const uuid = "pid-uuid-1";
  mkdirSync(sessionDir(vault, uuid), { recursive: true });
  // Use 'sleep 2' so the child stays alive long enough to observe the pid file
  spawnTurn(vault, uuid, ["2"], "sleep");
  const p = pidPath(vault, uuid);
  expect(existsSync(p)).toBe(true);
  expect(parseInt(readFileSync(p, "utf8"), 10)).toBeGreaterThan(0);
});
