import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDecision, listPendingDecisions, drainDecision, parseDecision } from "../src/decision.ts";
import { decisionsFilePath } from "../src/paths.ts";

function tmpVault(): string { return mkdtempSync(join(tmpdir(), "vos-dec-")); }

test("appendDecision writes one JSONL line and listPendingDecisions reads it back", () => {
  const v = tmpVault();
  const d = appendDecision(v, {
    question: "Push to prod?", options: ["yes", "no"],
    originExecId: "ex-1", context: "deploy void-admin", now: 1000,
  });
  expect(d.id).toMatch(/^dl-/);
  expect(d.state).toBe("pending");
  expect(existsSync(decisionsFilePath(v))).toBe(true);
  const pending = listPendingDecisions(v);
  expect(pending.length).toBe(1);
  expect(pending[0].question).toBe("Push to prod?");
  expect(pending[0].options).toEqual(["yes", "no"]);
  expect(pending[0].originExecId).toBe("ex-1");
});

test("drainDecision marks an entry resolved; it leaves the pending list", () => {
  const v = tmpVault();
  const d = appendDecision(v, { question: "q", options: ["a"], originExecId: "ex-2", context: "c", now: 1 });
  drainDecision(v, d.id, { reply: "a", now: 2 });
  expect(listPendingDecisions(v).length).toBe(0);
  // The resolved line is still present in the file (append-only audit; drain = mark, not delete).
  const lines = readFileSync(decisionsFilePath(v), "utf8").trim().split("\n");
  // Last line for this id wins (append-only; drain appends an updated line after the original).
  const resolved = lines.map((l) => parseDecision(l)).filter((x) => x.id === d.id).at(-1)!;
  expect(resolved.state).toBe("resolved");
  expect(resolved.reply).toBe("a");
});

test("parseDecision throws on invalid JSON / missing question", () => {
  expect(() => parseDecision("not json")).toThrow();
  expect(() => parseDecision(JSON.stringify({ id: "dl-x", options: [] }))).toThrow();
});

test("drainDecision is idempotent on an unknown id (no throw, no pending change)", () => {
  const v = tmpVault();
  appendDecision(v, { question: "q", options: ["a"], originExecId: "ex-3", context: "c", now: 1 });
  drainDecision(v, "dl-nonexistent", { reply: "x", now: 2 });
  expect(listPendingDecisions(v).length).toBe(1);
});
