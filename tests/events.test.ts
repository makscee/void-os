// events.test.ts — file-level hook event log + rebuildExecutions (files-first source of truth).
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openRegistry, createExecution, getExecution, listExecutions } from "../src/registry.ts";
import { appendEvent, rebuildExecutions } from "../src/events.ts";

function tmpVault() { return mkdtempSync(join(tmpdir(), "vos-events-")); }

test("appendEvent writes one JSONL line per call to the per-exec log", async () => {
  const vault = tmpVault();
  appendEvent(vault, "exec-1", { type: "start", agent: null, skill: "smoke", input_ref: null, tmux_session: "vos-run-exec-1", at: 1000, trigger_id: null, step_ceiling: null });
  appendEvent(vault, "exec-1", { type: "end", at: 2000 });
  const { readFileSync } = await import("node:fs");
  const lines = readFileSync(join(vault, ".void-os", "events", "exec-1.jsonl"), "utf8").trim().split("\n");
  expect(lines.length).toBe(2);
  expect(JSON.parse(lines[0]).type).toBe("start");
});

test("rebuildExecutions reconstructs the table from event files alone", () => {
  const vault = tmpVault();
  appendEvent(vault, "exec-1", { type: "start", agent: "a1", skill: "smoke", input_ref: "inbox/x.jsonl:3", tmux_session: "vos-run-exec-1", at: 1000, trigger_id: "tg", step_ceiling: 50 });
  appendEvent(vault, "exec-1", { type: "step", at: 1100 });
  appendEvent(vault, "exec-1", { type: "step", at: 1200 });
  appendEvent(vault, "exec-1", { type: "end", at: 2000 });
  const db = openRegistry(":memory:");
  rebuildExecutions(db, vault);
  const e = getExecution(db, "exec-1")!;
  expect(e.skill).toBe("smoke");
  expect(e.started_at).toBe(1000);
  expect(e.ended_at).toBe(2000);
  expect(e.step_count).toBe(2);
  expect(e.trigger_id).toBe("tg");
  expect(e.input_ref).toBe("inbox/x.jsonl:3");
});

test("rebuild matches a live-written table (no DB-only info)", () => {
  const vault = tmpVault();
  // live path: create row + append matching events
  const live = openRegistry(join(vault, "live.db"));
  createExecution(live, { id: "exec-2", agent: null, skill: "s", inputRef: null, tmuxSession: "t", now: 500, triggerId: null, stepCeiling: null });
  appendEvent(vault, "exec-2", { type: "start", agent: null, skill: "s", input_ref: null, tmux_session: "t", at: 500, trigger_id: null, step_ceiling: null });
  appendEvent(vault, "exec-2", { type: "fail", reason: "runaway-ceiling", at: 900 });
  // rebuild into a fresh db
  const rebuilt = openRegistry(":memory:");
  rebuildExecutions(rebuilt, vault);
  const r = getExecution(rebuilt, "exec-2")!;
  expect(r.id).toBe("exec-2");
  expect(r.reason).toBe("runaway-ceiling");
  expect(r.ended_at).toBe(900);
});

test("rebuildExecutions is idempotent on an empty events dir", () => {
  const vault = tmpVault();
  const db = openRegistry(":memory:");
  rebuildExecutions(db, vault); // events dir doesn't exist yet
  expect(listExecutions(db)).toHaveLength(0);
});
