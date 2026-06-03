// audit.test.ts — VOS-226 / contract §4: audit-line JSONL writer.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, auditPath, isSystemDeny, readAudit, type AuditLine } from "../src/audit.ts";

function tmpVault() { return mkdtempSync(join(tmpdir(), "vos-audit-")); }

function readLines(vault: string): AuditLine[] {
  const raw = readFileSync(auditPath(vault), "utf8");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("auditPath resolves to <vault>/.void-os/audit.jsonl", () => {
  expect(auditPath("/v")).toBe("/v/.void-os/audit.jsonl");
});

test("appendAudit writes exactly one well-formed JSON line per call", () => {
  const vault = tmpVault();
  appendAudit(vault, { ts: 111, exec: "exec-a", agent: "maya", tool: "Edit",
    path: "work/tasks/active/X.md", bytes: 412, source: "native" });
  const lines = readLines(vault);
  expect(lines.length).toBe(1);
  expect(lines[0]).toEqual({ ts: 111, exec: "exec-a", agent: "maya", tool: "Edit",
    path: "work/tasks/active/X.md", bytes: 412, source: "native" });
});

test("appendAudit creates the .void-os dir on first write", () => {
  const vault = tmpVault();
  expect(existsSync(auditPath(vault))).toBe(false);
  appendAudit(vault, { ts: 1, exec: null, agent: null, tool: "Write", path: "a.md", bytes: 0, source: "native" });
  expect(existsSync(auditPath(vault))).toBe(true);
});

test("appendAudit appends — N calls produce N lines in order", () => {
  const vault = tmpVault();
  appendAudit(vault, { ts: 1, exec: null, agent: null, tool: "Write", path: "a.md", bytes: 1, source: "mcp" });
  appendAudit(vault, { ts: 2, exec: null, agent: null, tool: "Edit", path: "b.md", bytes: 2, source: "native" });
  const lines = readLines(vault);
  expect(lines.map((l) => l.path)).toEqual(["a.md", "b.md"]);
  expect(lines.map((l) => l.source)).toEqual(["mcp", "native"]);
});

test("denied defaults to absent (false implicit), present-and-true only on a DENY hit", () => {
  const vault = tmpVault();
  appendAudit(vault, { ts: 1, exec: null, agent: null, tool: "Write", path: "ok.md", bytes: 0, source: "native" });
  appendAudit(vault, { ts: 2, exec: null, agent: null, tool: "Write", path: ".void-os/x", bytes: 0, source: "native", denied: false });
  appendAudit(vault, { ts: 3, exec: null, agent: null, tool: "Write", path: "agents/y.md", bytes: 0, source: "native", denied: true });
  const lines = readLines(vault);
  expect("denied" in lines[0]).toBe(false);
  expect("denied" in lines[1]).toBe(false);  // explicit false is dropped
  expect(lines[2].denied).toBe(true);
});

test("ts defaults to Date.now() when omitted/zero", () => {
  const vault = tmpVault();
  const before = Date.now();
  appendAudit(vault, { ts: 0, exec: null, agent: null, tool: "Write", path: "a.md", bytes: 0, source: "native" });
  const ts = readLines(vault)[0].ts;
  expect(ts).toBeGreaterThanOrEqual(before);
});

test("isSystemDeny matches agents/ and .void-os/ prefixes (and the dir itself)", () => {
  expect(isSystemDeny("agents/maya.md")).toBe(true);
  expect(isSystemDeny(".void-os/audit.jsonl")).toBe(true);
  expect(isSystemDeny(".void-os")).toBe(true);
  expect(isSystemDeny("agents")).toBe(true);
  expect(isSystemDeny("work/tasks/active/X.md")).toBe(false);
  expect(isSystemDeny("panels/kanban.html")).toBe(false);
  expect(isSystemDeny("./agents/x.md")).toBe(true);   // normalizes leading ./
});

// ---- readAudit filtering (contract §4.4) ----

function seed(vault: string) {
  appendAudit(vault, { ts: 100, exec: "e1", agent: "maya", tool: "Write", path: "a.md", bytes: 1, source: "native" });
  appendAudit(vault, { ts: 200, exec: "e2", agent: "ivy", tool: "Edit", path: "b.md", bytes: 2, source: "mcp" });
  appendAudit(vault, { ts: 300, exec: "e1", agent: "maya", tool: "Edit", path: "a.md", bytes: 3, source: "native" });
}

test("readAudit with no filters returns all lines in append order", () => {
  const vault = tmpVault(); seed(vault);
  expect(readAudit(vault).map((l) => l.ts)).toEqual([100, 200, 300]);
});

test("readAudit missing log returns empty array", () => {
  expect(readAudit(tmpVault())).toEqual([]);
});

test("readAudit filters AND path + agent + since", () => {
  const vault = tmpVault(); seed(vault);
  expect(readAudit(vault, { path: "a.md" }).map((l) => l.ts)).toEqual([100, 300]);
  expect(readAudit(vault, { agent: "ivy" }).map((l) => l.ts)).toEqual([200]);
  expect(readAudit(vault, { since: 200 }).map((l) => l.ts)).toEqual([200, 300]);
  expect(readAudit(vault, { path: "a.md", since: 200 }).map((l) => l.ts)).toEqual([300]);
});

test("readAudit skips malformed lines (never throws)", () => {
  const vault = tmpVault(); seed(vault);
  const { appendFileSync } = require("node:fs");
  appendFileSync(auditPath(vault), "not json\n");
  expect(() => readAudit(vault)).not.toThrow();
  expect(readAudit(vault).length).toBe(3);
});
