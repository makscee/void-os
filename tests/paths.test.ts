import { expect, test } from "bun:test";
import { sessionsRoot, sessionDir, bodyPath, errorPath, runLogPath } from "../src/paths.ts";

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
