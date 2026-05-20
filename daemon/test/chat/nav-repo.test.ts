// VOS-169: nav-repo unit tests — listTasks / listChildren / getTask.
//
// Bootstraps the DB via runMigrationsFromDir (honours the 0016 fk-rebuild
// marker — the naive readFileSync-per-file shim would mis-apply it).

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { makeNavRepo, DEFAULT_TERMINAL_RECENCY_MS } from "../../src/chat/nav-repo";
import { makeMessagesRepo } from "../../src/chat/messages-repo";
import type { Part } from "../../src/types/a2a";

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
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  return db;
}

function seedContext(db: Database, title: string | null = null): string {
  const id = `ctx-${Math.random().toString(36).slice(2, 10)}`;
  db.run("INSERT INTO contexts (id, title, created_at) VALUES (?, ?, ?)", [
    id,
    title,
    Date.now(),
  ]);
  return id;
}

interface SeedTask {
  contextId: string;
  parentTaskId?: string | null;
  state?: string;
  agent?: string;
  lastEvent?: number;
  createdAt?: number;
}

function seedTask(db: Database, t: SeedTask): string {
  const id = `task-${Math.random().toString(36).slice(2, 10)}`;
  const now = t.createdAt ?? Date.now();
  db.run(
    `INSERT INTO tasks
       (id, context_id, parent_task_id, state, agent, last_event,
        cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, '{}', ?, ?)`,
    [
      id,
      t.contextId,
      t.parentTaskId ?? null,
      t.state ?? "TASK_STATE_WORKING",
      t.agent ?? "maya",
      t.lastEvent ?? now,
      now,
      now,
    ],
  );
  return id;
}

// --- listTasks --------------------------------------------------------------

test("listTasks returns every Task across all Contexts", () => {
  const db = freshDb();
  const c1 = seedContext(db);
  const c2 = seedContext(db);
  seedTask(db, { contextId: c1 });
  seedTask(db, { contextId: c1 });
  seedTask(db, { contextId: c2 });
  const nav = makeNavRepo(db);
  expect(nav.listTasks().length).toBe(3);
});

test("listTasks sorts by last_event descending (recency)", () => {
  const db = freshDb();
  const c = seedContext(db);
  const old = seedTask(db, { contextId: c, lastEvent: 1000 });
  const newest = seedTask(db, { contextId: c, lastEvent: 9000 });
  const mid = seedTask(db, { contextId: c, lastEvent: 5000 });
  const nav = makeNavRepo(db);
  const ids = nav.listTasks().map((r) => r.id);
  expect(ids).toEqual([newest, mid, old]);
});

test("listTasks ages out terminal Tasks older than the recency window", () => {
  const db = freshDb();
  const c = seedContext(db);
  const now = 10_000_000;
  // Terminal + stale → aged out.
  seedTask(db, {
    contextId: c,
    state: "TASK_STATE_COMPLETED",
    lastEvent: now - DEFAULT_TERMINAL_RECENCY_MS - 1,
  });
  // Terminal + recent → kept.
  const recentDone = seedTask(db, {
    contextId: c,
    state: "TASK_STATE_FAILED",
    lastEvent: now - 1000,
  });
  // Non-terminal stale → always kept.
  const working = seedTask(db, {
    contextId: c,
    state: "TASK_STATE_WORKING",
    lastEvent: now - DEFAULT_TERMINAL_RECENCY_MS - 99999,
  });
  const nav = makeNavRepo(db);
  const ids = nav.listTasks({ now: () => now }).map((r) => r.id).sort();
  expect(ids).toEqual([recentDone, working].sort());
});

test("listTasks include_terminal keeps even stale terminal Tasks", () => {
  const db = freshDb();
  const c = seedContext(db);
  const now = 10_000_000;
  seedTask(db, {
    contextId: c,
    state: "TASK_STATE_CANCELED",
    lastEvent: now - DEFAULT_TERMINAL_RECENCY_MS - 1,
  });
  const nav = makeNavRepo(db);
  expect(nav.listTasks({ now: () => now, includeTerminal: true }).length).toBe(1);
  expect(nav.listTasks({ now: () => now }).length).toBe(0);
});

test("listTasks respects the limit cap", () => {
  const db = freshDb();
  const c = seedContext(db);
  for (let i = 0; i < 5; i++) seedTask(db, { contextId: c, lastEvent: i });
  const nav = makeNavRepo(db);
  expect(nav.listTasks({ limit: 2 }).length).toBe(2);
});

test("listTasks carries agent, state, last_event, context title", () => {
  const db = freshDb();
  const c = seedContext(db, "My Context");
  seedTask(db, { contextId: c, agent: "scout", lastEvent: 4242 });
  const nav = makeNavRepo(db);
  const row = nav.listTasks()[0]!;
  expect(row.agent).toBe("scout");
  expect(row.state).toBe("TASK_STATE_WORKING");
  expect(row.last_event).toBe(4242);
  expect(row.context_title).toBe("My Context");
});

// --- listChildren -----------------------------------------------------------

test("listChildren returns direct children only (one tree level)", () => {
  const db = freshDb();
  const c = seedContext(db);
  const root = seedTask(db, { contextId: c });
  const childA = seedTask(db, { contextId: c, parentTaskId: root, createdAt: 100 });
  const childB = seedTask(db, { contextId: c, parentTaskId: root, createdAt: 200 });
  // Grandchild — must NOT appear in root's children.
  seedTask(db, { contextId: c, parentTaskId: childA });
  const nav = makeNavRepo(db);
  const ids = nav.listChildren(root).map((r) => r.id);
  expect(ids).toEqual([childA, childB]);
});

test("listChildren returns empty array for a leaf or unknown Task", () => {
  const db = freshDb();
  const c = seedContext(db);
  const leaf = seedTask(db, { contextId: c });
  const nav = makeNavRepo(db);
  expect(nav.listChildren(leaf)).toEqual([]);
  expect(nav.listChildren("does-not-exist")).toEqual([]);
});

test("listChildren orders children oldest-first", () => {
  const db = freshDb();
  const c = seedContext(db);
  const root = seedTask(db, { contextId: c });
  const late = seedTask(db, { contextId: c, parentTaskId: root, createdAt: 999 });
  const early = seedTask(db, { contextId: c, parentTaskId: root, createdAt: 1 });
  const nav = makeNavRepo(db);
  expect(nav.listChildren(root).map((r) => r.id)).toEqual([early, late]);
});

// --- getTask ----------------------------------------------------------------

test("getTask returns null for an unknown id", () => {
  const db = freshDb();
  const nav = makeNavRepo(db);
  expect(nav.getTask("nope")).toBeNull();
});

test("getTask returns the Task with its message history", () => {
  const db = freshDb();
  const c = seedContext(db, "Ctx");
  const taskId = seedTask(db, { contextId: c, agent: "maya" });
  const messages = makeMessagesRepo(db);
  const userPart: Part[] = [{ text: "hello" } as Part];
  const agentPart: Part[] = [{ text: "hi there" } as Part];
  messages.appendMessage(taskId, c, null, "ROLE_USER", userPart, 1000);
  messages.appendMessage(taskId, c, null, "ROLE_AGENT", agentPart, 2000);
  const nav = makeNavRepo(db);
  const detail = nav.getTask(taskId);
  expect(detail).not.toBeNull();
  expect(detail!.id).toBe(taskId);
  expect(detail!.agent).toBe("maya");
  expect(detail!.context_title).toBe("Ctx");
  expect(detail!.messages.length).toBe(2);
  expect(detail!.messages[0]!.role).toBe("user");
  expect(detail!.messages[1]!.role).toBe("assistant");
});

test("getTask scopes message history to the Task, not the whole Context", () => {
  const db = freshDb();
  const c = seedContext(db);
  const taskA = seedTask(db, { contextId: c });
  const taskB = seedTask(db, { contextId: c });
  const messages = makeMessagesRepo(db);
  messages.appendMessage(taskA, c, null, "ROLE_USER", [{ text: "A msg" } as Part], 1000);
  messages.appendMessage(taskB, c, null, "ROLE_USER", [{ text: "B msg" } as Part], 2000);
  const nav = makeNavRepo(db);
  const detailA = nav.getTask(taskA)!;
  expect(detailA.messages.length).toBe(1);
  expect(detailA.messages.every((m) => m.task_id === taskA)).toBe(true);
});
