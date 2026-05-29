import { expect, test } from "bun:test";
import { sessionsRoot, sessionDir, bodyPath, errorPath, runLogPath, readConfig, resolveRunner, DEFAULT_RUNNER_LABEL } from "../src/paths.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("sessionsRoot appends /sessions to vault", () => {
  expect(sessionsRoot("/tmp/vault")).toBe("/tmp/vault/sessions");
});

test("session paths are derived from vault + uuid", () => {
  const v = "/tmp/vault";
  const u = "abc-123";
  expect(sessionDir(v, u)).toBe("/tmp/vault/sessions/abc-123");
  expect(bodyPath(v, u)).toBe("/tmp/vault/sessions/abc-123/body.html");
  expect(errorPath(v, u)).toBe("/tmp/vault/sessions/abc-123/error.txt");
  expect(runLogPath(v, u, 1)).toBe("/tmp/vault/sessions/abc-123/run-1.log");
  expect(runLogPath(v, u, 5)).toBe("/tmp/vault/sessions/abc-123/run-5.log");
});

test("readConfig defaults runners to vc when absent", () => {
  const v = mkdtempSync(join(tmpdir(), "vos-cfg-"));
  const cfg = readConfig(v); // no void-os.json yet
  expect(cfg.runners).toEqual([{ label: "vc (relay)", command: "vc --" }]);
  expect(cfg.defaultRunner).toBe(DEFAULT_RUNNER_LABEL);
});

test("readConfig back-compat: existing config without runners gets vc default", () => {
  const v = mkdtempSync(join(tmpdir(), "vos-cfg-"));
  writeFileSync(join(v, "void-os.json"), JSON.stringify({ vault: v, onboarded: true, skills: [], answers: {}, port: 4317 }));
  const cfg = readConfig(v);
  expect(cfg.runners[0].command).toBe("vc --");
  expect(cfg.defaultRunner).toBe("vc (relay)");
});

test("resolveRunner returns matching command, falls back to default on unknown/missing", () => {
  const cfg = { vault: "/x", onboarded: true, skills: [], answers: {}, port: 4317,
    runners: [{ label: "vc (relay)", command: "vc --" }, { label: "artem", command: "claude_artem" }],
    defaultRunner: "vc (relay)" };
  expect(resolveRunner(cfg, "artem")).toBe("claude_artem");
  expect(resolveRunner(cfg, "nope")).toBe("vc --");
  expect(resolveRunner(cfg)).toBe("vc --");
});
