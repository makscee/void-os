// VOS-83 mig-0007: messages-repo tests (single-method API).
//
// Drives the rewritten repo: `appendMessage(taskId, contextId, runId, role,
// parts[], ts?)` writing to the A2A-shaped `messages` table (task_id FK,
// role ∈ {ROLE_USER, ROLE_AGENT}, parts JSON, parts_text flatten).
//
// Seeds rows directly via raw SQL: chat repo is still wired to the legacy
// `chats` table name (renamed to `contexts` by 0007) — fixing chat repo is
// a downstream task. Inline helpers below stand contexts + tasks + runs up
// against the live schema.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  // Apply ALL migrations in lex order — matches the production runner.
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    db.run(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  return db;
}

function seedContext(db: Database): string {
  const id = `ctx-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  db.run(
    "INSERT INTO contexts (id, agent_name, title, created_at, updated_at, archived) VALUES (?, 'maya', NULL, ?, ?, 0)",
    [id, now, now],
  );
  return id;
}

function seedTask(db: Database, contextId: string): string {
  const id = `task-${Math.random().toString(36).slice(2, 10)}`;
  const now = Date.now();
  db.run(
    "INSERT INTO tasks (id, context_id, state, tokens_in, tokens_out, metadata, created_at, updated_at) VALUES (?, ?, 'TASK_STATE_SUBMITTED', 0, 0, '{}', ?, ?)",
    [id, contextId, now, now],
  );
  return id;
}

function seedRun(
  db: Database,
  contextId: string,
  runId = "run-1",
  status = "running",
): string {
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES (?, ?, 'maya', 'chat', ?, ?)",
    [runId, contextId, status, Date.now()],
  );
  return runId;
}

// ---------------------------------------------------------------------------

test("appendMessage(ROLE_USER) round-trips one user text entry via walk", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const tid = seedTask(db, cid);
  seedRun(db, cid, "run-1");
  const repo = makeMessagesRepo(db);

  const parts: Part[] = [{ text: "hi" }];
  repo.appendMessage(tid, cid, "run-1", "ROLE_USER", parts, 1000);

  expect(repo.walk(cid)).toEqual([
    { role: "user", content: "hi", ts: 1000 },
  ]);
});

test("appendMessage(ROLE_AGENT) with mixed parts round-trips via walk", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const tid = seedTask(db, cid);
  seedRun(db, cid, "run-1");
  const repo = makeMessagesRepo(db);

  const parts: Part[] = [
    { text: "looking" },
    {
      data: {
        kind: "tool_use",
        tool_call_id: "c1",
        tool_name: "read",
        input: { path: "/x" },
      },
    },
    { text: "done" },
  ];
  repo.appendMessage(tid, cid, "run-1", "ROLE_AGENT", parts, 2000);

  expect(repo.walk(cid)).toEqual([
    { role: "assistant", content: "looking\ndone", ts: 2000 },
    {
      role: "tool_use",
      tool_call_id: "c1",
      name: "read",
      input: { path: "/x" },
      ts: 2000,
    },
  ]);
});

test("ROLE_AGENT UPSERTs on (context_id, run_id) — second call overwrites parts/parts_text/ts", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const tid = seedTask(db, cid);
  seedRun(db, cid, "run-1");
  const repo = makeMessagesRepo(db);

  const id1 = repo.appendMessage(
    tid,
    cid,
    "run-1",
    "ROLE_AGENT",
    [{ text: "partial" }],
    1000,
  );
  const id2 = repo.appendMessage(
    tid,
    cid,
    "run-1",
    "ROLE_AGENT",
    [{ text: "partial done" }],
    1010,
  );

  expect(id2).toBe(id1);
  expect(repo.walk(cid)).toEqual([
    { role: "assistant", content: "partial done", ts: 1010 },
  ]);
  // Ensure UPSERT, not INSERT — single row in the table.
  const count = db
    .query("SELECT COUNT(*) AS n FROM messages WHERE context_id = ?")
    .get(cid) as { n: number };
  expect(count.n).toBe(1);
});

test("parts_text stored as concatenation of TextPart.text joined by '\\n'", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const tid = seedTask(db, cid);
  seedRun(db, cid, "run-1");
  const repo = makeMessagesRepo(db);

  repo.appendMessage(
    tid,
    cid,
    "run-1",
    "ROLE_AGENT",
    [
      { text: "first" },
      { data: { kind: "tool_use", tool_call_id: "x", tool_name: "y", input: {} } },
      { text: "second" },
    ],
    1000,
  );

  const row = db
    .query("SELECT parts_text FROM messages WHERE context_id = ?")
    .get(cid) as { parts_text: string };
  expect(row.parts_text).toBe("first\nsecond");
});

test("lastAssistantText returns parts_text of most recent ROLE_AGENT row", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const tid = seedTask(db, cid);
  seedRun(db, cid, "run-1");
  seedRun(db, cid, "run-2");
  const repo = makeMessagesRepo(db);

  expect(repo.lastAssistantText(cid)).toBe("");

  repo.appendMessage(tid, cid, "run-1", "ROLE_USER", [{ text: "q" }], 1000);
  repo.appendMessage(tid, cid, "run-1", "ROLE_AGENT", [{ text: "first answer" }], 1010);
  expect(repo.lastAssistantText(cid)).toBe("first answer");

  repo.appendMessage(tid, cid, "run-2", "ROLE_AGENT", [{ text: "second answer" }], 1020);
  expect(repo.lastAssistantText(cid)).toBe("second answer");
});

test("walk orders by (ts ASC, ord ASC) with ord monotone per context", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const tid = seedTask(db, cid);
  seedRun(db, cid, "run-1");
  seedRun(db, cid, "run-2");
  const repo = makeMessagesRepo(db);

  repo.appendMessage(tid, cid, "run-1", "ROLE_USER", [{ text: "q1" }], 1000);
  repo.appendMessage(tid, cid, "run-1", "ROLE_AGENT", [{ text: "a1" }], 1010);
  repo.appendMessage(tid, cid, "run-2", "ROLE_USER", [{ text: "q2" }], 1020);
  repo.appendMessage(tid, cid, "run-2", "ROLE_AGENT", [{ text: "a2" }], 1030);

  const out = repo.walk(cid);
  expect(out.map((e) => (e as { content?: string }).content)).toEqual([
    "q1",
    "a1",
    "q2",
    "a2",
  ]);
});

test("walk ord-tiebreaks rows that share the same ts", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const tid = seedTask(db, cid);
  seedRun(db, cid, "run-1");
  const repo = makeMessagesRepo(db);

  // Three appends at the same ts; ord must keep them in insertion order.
  repo.appendMessage(tid, cid, "run-1", "ROLE_USER", [{ text: "first" }], 5000);
  // Use a separate runId so UPSERT doesn't merge these into one agent row.
  seedRun(db, cid, "run-1b");
  repo.appendMessage(tid, cid, "run-1b", "ROLE_AGENT", [{ text: "second" }], 5000);
  seedRun(db, cid, "run-1c");
  repo.appendMessage(tid, cid, "run-1c", "ROLE_AGENT", [{ text: "third" }], 5000);

  const out = repo.walk(cid);
  expect(out.map((e) => (e as { content?: string }).content)).toEqual([
    "first",
    "second",
    "third",
  ]);
});

test("walk surfaces cancelled=true on ROLE_AGENT rows whose run.status='cancelled'", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const tid = seedTask(db, cid);
  seedRun(db, cid, "run-1");
  const repo = makeMessagesRepo(db);

  repo.appendMessage(tid, cid, "run-1", "ROLE_USER", [{ text: "go" }], 1000);
  repo.appendMessage(
    tid,
    cid,
    "run-1",
    "ROLE_AGENT",
    [{ text: "partial answer" }],
    1010,
  );
  db.run("UPDATE runs SET status='cancelled', ended_at=? WHERE id=?", [
    1020,
    "run-1",
  ]);

  expect(repo.walk(cid)).toEqual([
    { role: "user", content: "go", ts: 1000 },
    {
      role: "assistant",
      content: "partial answer",
      ts: 1010,
      cancelled: true,
    },
  ]);
});

test("walk omits cancelled flag on ROLE_AGENT rows from done runs", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const tid = seedTask(db, cid);
  seedRun(db, cid, "run-1");
  const repo = makeMessagesRepo(db);

  repo.appendMessage(tid, cid, "run-1", "ROLE_AGENT", [{ text: "ok" }], 1010);
  db.run("UPDATE runs SET status='done', ended_at=? WHERE id=?", [1020, "run-1"]);

  const out = repo.walk(cid);
  expect(out).toEqual([{ role: "assistant", content: "ok", ts: 1010 }]);
  expect((out[0] as { cancelled?: boolean }).cancelled).toBeUndefined();
});

test("walk does not stamp cancelled on ROLE_USER rows from cancelled runs", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const tid = seedTask(db, cid);
  seedRun(db, cid, "run-1");
  const repo = makeMessagesRepo(db);

  repo.appendMessage(tid, cid, "run-1", "ROLE_USER", [{ text: "go" }], 1000);
  db.run("UPDATE runs SET status='cancelled', ended_at=? WHERE id=?", [
    1020,
    "run-1",
  ]);

  const out = repo.walk(cid);
  expect(out).toEqual([{ role: "user", content: "go", ts: 1000 }]);
  expect((out[0] as { cancelled?: boolean }).cancelled).toBeUndefined();
});

test("walk decodes tool_result DataParts back into ReplayEntry shape", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const tid = seedTask(db, cid);
  seedRun(db, cid, "run-1");
  const repo = makeMessagesRepo(db);

  // Tool results travel back from the model as ROLE_USER parts in A2A.
  repo.appendMessage(
    tid,
    cid,
    "run-1",
    "ROLE_USER",
    [
      {
        data: {
          kind: "tool_result",
          tool_call_id: "c1",
          output: "ok",
          is_error: false,
        },
      },
      {
        data: {
          kind: "tool_result",
          tool_call_id: "c2",
          output: "boom",
          is_error: true,
        },
      },
    ],
    2000,
  );

  expect(repo.walk(cid)).toEqual([
    {
      role: "tool_result",
      tool_call_id: "c1",
      output: "ok",
      is_error: false,
      ts: 2000,
    },
    {
      role: "tool_result",
      tool_call_id: "c2",
      output: "boom",
      is_error: true,
      ts: 2000,
    },
  ]);
});

test("walk returns [] for a context with no rows", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const repo = makeMessagesRepo(db);
  expect(repo.walk(cid)).toEqual([]);
});

test("appendMessage with null runId on ROLE_AGENT always inserts (no UPSERT)", () => {
  const db = freshDb();
  const cid = seedContext(db);
  const tid = seedTask(db, cid);
  const repo = makeMessagesRepo(db);

  const id1 = repo.appendMessage(tid, cid, null, "ROLE_AGENT", [{ text: "a" }], 1000);
  const id2 = repo.appendMessage(tid, cid, null, "ROLE_AGENT", [{ text: "b" }], 1010);

  expect(id2).not.toBe(id1);
  const count = db
    .query("SELECT COUNT(*) AS n FROM messages WHERE context_id = ?")
    .get(cid) as { n: number };
  expect(count.n).toBe(2);
});
