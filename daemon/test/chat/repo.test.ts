// VOS-83 mig-0007: chat-repo tests updated for the contexts + tasks pivot.
//
// `chats` is renamed to `contexts` in 0007, `agent` -> `agent_name`, and
// `last_msg` is dropped. `repo.create` now mints a companion `tasks` row
// (state='TASK_STATE_WORKING') in the same transaction and returns the
// task_id alongside the row.
//
// `setLastMsg` was kept as an updated_at-bump shim — the preview text now
// flows through `messages.parts_text` via the list() correlated subquery.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeChatRepo, openTaskFor, setTaskState } from "../../src/chat/repo";

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
  const migs = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const m of migs) {
    db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }
  return db;
}

test("create returns context with null title + session_id + minted task_id", () => {
  const repo = makeChatRepo(freshDb());
  const c = repo.create({ agent: "maya" });
  expect(c.id).toBeTruthy();
  expect(c.agent).toBe("maya");
  expect(c.title).toBeNull();
  expect(c.session_id).toBeNull();
  expect(c.current_run_id).toBeNull();
  expect(typeof c.created_at).toBe("number");
  expect(typeof c.updated_at).toBe("number");
  // mig-0007: companion task row minted.
  expect(typeof c.task_id).toBe("string");
  expect(c.task_id.length).toBeGreaterThan(0);
});

test("create mints a tasks row with state='TASK_STATE_WORKING'", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  const row = db
    .query("SELECT state, context_id FROM tasks WHERE id = ?")
    .get(c.task_id) as { state: string; context_id: string };
  expect(row.state).toBe("TASK_STATE_WORKING");
  expect(row.context_id).toBe(c.id);
});

test("openTaskFor returns the minted task id for a context", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  expect(openTaskFor(db, c.id)).toBe(c.task_id);
});

test("setTaskState flips WORKING <-> INPUT_REQUIRED", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  setTaskState(db, c.task_id, "TASK_STATE_INPUT_REQUIRED");
  let s = db
    .query("SELECT state FROM tasks WHERE id = ?")
    .get(c.task_id) as { state: string };
  expect(s.state).toBe("TASK_STATE_INPUT_REQUIRED");
  setTaskState(db, c.task_id, "TASK_STATE_WORKING");
  s = db
    .query("SELECT state FROM tasks WHERE id = ?")
    .get(c.task_id) as { state: string };
  expect(s.state).toBe("TASK_STATE_WORKING");
});

test("list returns contexts sorted updated_at desc with last_run_status", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const a = repo.create({ agent: "maya" });
  const b = repo.create({ agent: "maya" });
  // Touch a so its updated_at is strictly greater than b's.
  const future = Date.now() + 60_000;
  db.run("UPDATE contexts SET updated_at = ? WHERE id = ?", [future, a.id]);
  // Insert a 'done' run tied to chat a.
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES (?,?,?,?,?,?)",
    ["r1", a.id, "maya", "chat", "done", Date.now()],
  );
  const list = repo.list();
  expect(list.length).toBe(2);
  expect(list[0]!.id).toBe(a.id);
  expect(list[0]!.last_run_status).toBe("done");
  expect(list[1]!.id).toBe(b.id);
  expect(list[1]!.last_run_status).toBeNull();
});

test("list picks the most recent run for last_run_status", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  const now = Date.now();
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES (?,?,?,?,?,?)",
    ["r-old", c.id, "maya", "chat", "done", now - 10_000],
  );
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES (?,?,?,?,?,?)",
    ["r-new", c.id, "maya", "chat", "running", now],
  );
  const list = repo.list();
  expect(list[0]!.last_run_status).toBe("running");
});

test("setTitle is conditional on title IS NULL (idempotent)", () => {
  const repo = makeChatRepo(freshDb());
  const c = repo.create({ agent: "maya" });
  expect(repo.setTitle(c.id, "First")).toBe(true);
  expect(repo.setTitle(c.id, "Second")).toBe(false);
  expect(repo.get(c.id)!.title).toBe("First");
});

test("setSession persists sessionId on contexts row (idempotent on repeat)", () => {
  const repo = makeChatRepo(freshDb());
  const c = repo.create({ agent: "maya" });
  repo.setSession(c.id, "sid-1");
  expect(repo.get(c.id)!.session_id).toBe("sid-1");
  // Re-setting the same sessionId is a no-op (claudev --resume reuses same sid).
  repo.setSession(c.id, "sid-1");
  expect(repo.get(c.id)!.session_id).toBe("sid-1");
});

test("setCurrentRun + clearCurrentRun toggle lock", () => {
  const repo = makeChatRepo(freshDb());
  const c = repo.create({ agent: "maya" });
  repo.setCurrentRun(c.id, "run-1");
  expect(repo.get(c.id)!.current_run_id).toBe("run-1");
  repo.setCurrentRun(c.id, null);
  expect(repo.get(c.id)!.current_run_id).toBeNull();
});

test("get returns null for unknown id", () => {
  const repo = makeChatRepo(freshDb());
  expect(repo.get("no-such-id")).toBeNull();
});

test("setLastMsg bumps updated_at (last_msg column dropped, preview now from messages)", () => {
  const repo = makeChatRepo(freshDb());
  const c = repo.create({ agent: "maya" });
  const before = repo.get(c.id)!.updated_at;
  // Ensure clock advances by at least 1ms.
  Bun.sleepSync(2);
  repo.setLastMsg(c.id, "hello");
  const after = repo.get(c.id)!;
  // last_msg column no longer exists — get() returns NULL.
  expect(after.last_msg).toBeNull();
  expect(after.updated_at).toBeGreaterThan(before);
});

test("list returns cost_usd=0 for chats with no cost rows", () => {
  const repo = makeChatRepo(freshDb());
  repo.create({ agent: "maya" });
  const rows = repo.list();
  expect(rows.length).toBe(1);
  expect(rows[0]!.cost_usd).toBe(0);
  expect(typeof rows[0]!.cost_usd).toBe("number");
});

test("list returns cost_usd as lifetime SUM(costs.cost_usd) per chat", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const a = repo.create({ agent: "maya" });
  const b = repo.create({ agent: "maya" });
  const now = Date.now();
  // Named columns only for what we need; other costs columns have NOT NULL
  // DEFAULT 0 or are nullable (task_id), so we don't need to bind them.
  const insert = db.prepare(
    `INSERT INTO costs (run_id, chat_id, agent, provider, ts, cost_usd, model)
     VALUES (?, ?, 'maya', 'claude-code', ?, ?, 'sonnet')`,
  );
  insert.run("r1", a.id, now, 0.10);
  insert.run("r2", a.id, now, 0.32);
  insert.run("r3", b.id, now, 1.50);
  const rows = repo.list();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  expect(byId[a.id]!.cost_usd).toBeCloseTo(0.42, 5);
  expect(byId[b.id]!.cost_usd).toBeCloseTo(1.50, 5);
});

test("list returns input_required=false when no tasks in INPUT_REQUIRED state", () => {
  const repo = makeChatRepo(freshDb());
  repo.create({ agent: "maya" });
  const rows = repo.list();
  expect(rows[0]!.input_required).toBe(false);
});

test("list returns input_required=true when any task in chat is INPUT_REQUIRED", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  // `create` mints a task in TASK_STATE_WORKING — flip it.
  setTaskState(db, c.task_id, "TASK_STATE_INPUT_REQUIRED");
  const rows = repo.list();
  const row = rows.find((r) => r.id === c.id)!;
  expect(row.input_required).toBe(true);

  // Flip back → flag clears.
  setTaskState(db, c.task_id, "TASK_STATE_WORKING");
  const rows2 = repo.list();
  expect(rows2.find((r) => r.id === c.id)!.input_required).toBe(false);
});

test("list returns context_tokens + splits from latest costs row per chat (tiebreak by id desc)", () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const a = repo.create({ agent: "maya" });
  const b = repo.create({ agent: "maya" });
  // Match the schema/style used by the cost_usd test above: include provider+model,
  // and add the token-split columns relevant to this test.
  const insert = db.prepare(
    `INSERT INTO costs
       (run_id, chat_id, agent, provider, ts, cost_usd, model,
        input_tokens, output_tokens, cache_create_tokens, cache_read_tokens)
     VALUES (?, ?, 'maya', 'claude-code', ?, ?, 'sonnet', ?, ?, ?, ?)`,
  );
  // Earlier ts — should be ignored.
  insert.run("r1", a.id, 100, 0.01, 10, 1, 0, 0);
  // Latest ts, lower id of the tie pair — should be ignored by tiebreak.
  insert.run("r2", a.id, 200, 0.10, 500, 50, 100, 2000);
  // Latest ts, higher id — wins.
  insert.run("r3", a.id, 200, 0.20, 999, 9, 9, 9);
  const rows = repo.list();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  expect(byId[a.id]!.context_input_tokens).toBe(999);
  expect(byId[a.id]!.context_output_tokens).toBe(9);
  expect(byId[a.id]!.context_cache_create_tokens).toBe(9);
  expect(byId[a.id]!.context_cache_read_tokens).toBe(9);
  expect(byId[a.id]!.context_tokens).toBe(999 + 9 + 9 + 9);
  // chat b has no costs rows — all 5 fields null.
  expect(byId[b.id]!.context_tokens).toBeNull();
  expect(byId[b.id]!.context_input_tokens).toBeNull();
  expect(byId[b.id]!.context_output_tokens).toBeNull();
  expect(byId[b.id]!.context_cache_create_tokens).toBeNull();
  expect(byId[b.id]!.context_cache_read_tokens).toBeNull();
});
