// VOS-171: terminal-state + last_event rollup helpers.
//
// Covers declareTaskTerminal (CAS), touchTask (last_event + last_event_text),
// getTaskState, and the messages-repo last_event rollup on appendMessage.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  makeChatRepo,
  openTaskFor,
  setTaskState,
  getTaskState,
  touchTask,
  declareTaskTerminal,
  isTaskFrozen,
  TERMINAL_TASK_STATES,
} from "../../src/chat/repo";
import { makeMessagesRepo } from "../../src/chat/messages-repo";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);

function freshDb(): Database {
  const db = new Database(":memory:");
  const migs = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const m of migs) db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  return db;
}

function lastEvent(db: Database, taskId: string): number | null {
  const row = db
    .query("SELECT last_event FROM tasks WHERE id = ?")
    .get(taskId) as { last_event: number | null } | null;
  return row?.last_event ?? null;
}

function lastEventText(db: Database, taskId: string): string | null {
  const row = db
    .query("SELECT json_extract(metadata, '$.last_event_text') AS t FROM tasks WHERE id = ?")
    .get(taskId) as { t: string | null } | null;
  return row?.t ?? null;
}

test("TERMINAL_TASK_STATES holds the three A2A terminal states", () => {
  expect(TERMINAL_TASK_STATES.has("TASK_STATE_COMPLETED")).toBe(true);
  expect(TERMINAL_TASK_STATES.has("TASK_STATE_FAILED")).toBe(true);
  expect(TERMINAL_TASK_STATES.has("TASK_STATE_CANCELED")).toBe(true);
  expect(TERMINAL_TASK_STATES.has("TASK_STATE_WORKING")).toBe(false);
});

test("getTaskState reads state; null for absent rows", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  expect(getTaskState(db, c.task_id)).toBe("TASK_STATE_WORKING");
  expect(getTaskState(db, "no-such-id")).toBeNull();
});

test("declareTaskTerminal flips WORKING -> COMPLETED with a summary", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  const r = declareTaskTerminal(
    db,
    c.task_id,
    "TASK_STATE_COMPLETED",
    "shipped the report",
  );
  expect(r.flipped).toBe(true);
  expect(r.state).toBe("TASK_STATE_COMPLETED");
  expect(getTaskState(db, c.task_id)).toBe("TASK_STATE_COMPLETED");
  expect(lastEventText(db, c.task_id)).toBe("shipped the report");
  expect(lastEvent(db, c.task_id)).toBeGreaterThan(0);
});

test("declareTaskTerminal flips INPUT_REQUIRED -> FAILED", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  setTaskState(db, c.task_id, "TASK_STATE_INPUT_REQUIRED");
  const r = declareTaskTerminal(db, c.task_id, "TASK_STATE_FAILED", "gave up");
  expect(r.flipped).toBe(true);
  expect(getTaskState(db, c.task_id)).toBe("TASK_STATE_FAILED");
});

test("declareTaskTerminal is an idempotent no-op on an already-terminal Task", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  declareTaskTerminal(db, c.task_id, "TASK_STATE_COMPLETED", "first");
  // a second declare must NOT change the frozen Task.
  const r = declareTaskTerminal(db, c.task_id, "TASK_STATE_FAILED", "second");
  expect(r.flipped).toBe(false);
  expect(r.state).toBe("TASK_STATE_COMPLETED");
  expect(getTaskState(db, c.task_id)).toBe("TASK_STATE_COMPLETED");
  // summary from the first (winning) declare is preserved.
  expect(lastEventText(db, c.task_id)).toBe("first");
});

test("declareTaskTerminal on an absent Task reports flipped=false, state=null", () => {
  const db = freshDb();
  const r = declareTaskTerminal(
    db,
    "ghost",
    "TASK_STATE_COMPLETED",
    "nobody home",
  );
  expect(r.flipped).toBe(false);
  expect(r.state).toBeNull();
});

test("touchTask bumps last_event; with a summary writes last_event_text", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  // wipe last_event so we can observe a fresh bump.
  db.run("UPDATE tasks SET last_event = NULL WHERE id = ?", [c.task_id]);
  touchTask(db, c.task_id);
  expect(lastEvent(db, c.task_id)).toBeGreaterThan(0);
  expect(lastEventText(db, c.task_id)).toBeNull();
  touchTask(db, c.task_id, "did a thing");
  expect(lastEventText(db, c.task_id)).toBe("did a thing");
});

test("touchTask truncates the summary to 200 chars", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  touchTask(db, c.task_id, "x".repeat(500));
  expect(lastEventText(db, c.task_id)!.length).toBe(200);
});

test("appendMessage rolls last_event forward on every message", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const c = repo.create({ agent: "maya" });
  const taskId = openTaskFor(db, c.id);

  db.run("UPDATE tasks SET last_event = 1 WHERE id = ?", [taskId]);
  messages.appendMessage(taskId, c.id, null, "ROLE_USER", [
    { text: "hello there" } as never,
  ]);
  expect(lastEvent(db, taskId)).toBeGreaterThan(1);
  expect(lastEventText(db, taskId)).toBe("user: hello there");

  messages.appendMessage(taskId, c.id, "run-1", "ROLE_AGENT", [
    { text: "hi back" } as never,
  ]);
  expect(lastEventText(db, taskId)).toBe("agent: hi back");
});

test("setTaskState bumps last_event on a state change", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  db.run("UPDATE tasks SET last_event = 1 WHERE id = ?", [c.task_id]);
  setTaskState(db, c.task_id, "TASK_STATE_INPUT_REQUIRED");
  expect(lastEvent(db, c.task_id)).toBeGreaterThan(1);
});

test("isTaskFrozen: WORKING is not frozen", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  expect(isTaskFrozen(db, c.task_id)).toBe(false);
});

test("isTaskFrozen: agent-declared COMPLETED is frozen", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  declareTaskTerminal(db, c.task_id, "TASK_STATE_COMPLETED", "done");
  expect(isTaskFrozen(db, c.task_id)).toBe(true);
});

test("isTaskFrozen: run-end-inferred COMPLETED (no declared flag) is NOT frozen", () => {
  // The orchestrator's run-end auto-flip leaves a bare COMPLETED — that is
  // "idle between turns", a multi-turn chat re-engages it.
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  db.run("UPDATE tasks SET state = 'TASK_STATE_COMPLETED' WHERE id = ?", [
    c.task_id,
  ]);
  expect(isTaskFrozen(db, c.task_id)).toBe(false);
});

test("isTaskFrozen: FAILED and CANCELED are always frozen", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  for (const s of ["TASK_STATE_FAILED", "TASK_STATE_CANCELED"]) {
    const c = repo.create({ agent: "maya" });
    db.run("UPDATE tasks SET state = ? WHERE id = ?", [s, c.task_id]);
    expect(isTaskFrozen(db, c.task_id)).toBe(true);
  }
});

test("declareTaskTerminal stamps metadata.terminal_declared = true", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  declareTaskTerminal(db, c.task_id, "TASK_STATE_COMPLETED", "shipped");
  const row = db
    .query(
      "SELECT json_extract(metadata, '$.terminal_declared') AS d FROM tasks WHERE id = ?",
    )
    .get(c.task_id) as { d: unknown };
  expect(row.d === 1 || row.d === true).toBe(true);
});
