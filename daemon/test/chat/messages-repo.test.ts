// VOS-80 architecture (a): messages-repo tests.
//
// Covers append + walk roundtrip for all four roles, ordering within and
// across runs, assistant-row idempotency (UPDATE on existing run_id), and
// the lastAssistantText derivation used to keep chats.last_msg in sync.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeChatRepo } from "../../src/chat/repo";
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
  for (const m of [
    "0001_init.sql",
    "0002_runs_columns.sql",
    "0003_chat_lifecycle.sql",
    "0004_messages.sql",
  ]) {
    db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }
  return db;
}

function seedChat(db: Database, runId: string | null = "run-1"): string {
  const chat = makeChatRepo(db).create({ agent: "maya" });
  if (runId) {
    db.run(
      "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES (?, ?, 'maya', 'chat', 'running', ?)",
      [runId, chat.id, Date.now()],
    );
  }
  return chat.id;
}

test("appendUser + walk yields a user TextMessage entry", () => {
  const db = freshDb();
  const chatId = seedChat(db);
  const repo = makeMessagesRepo(db);

  repo.appendUser(chatId, "run-1", "hello world", 1000);

  expect(repo.walk(chatId)).toEqual([
    { role: "user", content: "hello world", ts: 1000 },
  ]);
});

test("appendAssistant is idempotent on (chat_id, run_id) — UPDATEs on second call", () => {
  const db = freshDb();
  const chatId = seedChat(db);
  const repo = makeMessagesRepo(db);

  repo.appendAssistant(chatId, "run-1", "partial ", 1000);
  repo.appendAssistant(chatId, "run-1", "partial done", 1001);

  const out = repo.walk(chatId);
  expect(out).toEqual([
    { role: "assistant", content: "partial done", ts: 1001 },
  ]);
});

test("appendToolUse stores name + JSON-stringified input", () => {
  const db = freshDb();
  const chatId = seedChat(db);
  const repo = makeMessagesRepo(db);

  repo.appendToolUse(
    chatId,
    "run-1",
    "tool-call-abc",
    "Bash",
    JSON.stringify({ cmd: "ls" }),
    2000,
  );

  expect(repo.walk(chatId)).toEqual([
    {
      role: "tool_use",
      tool_call_id: "tool-call-abc",
      name: "Bash",
      input: { cmd: "ls" },
      ts: 2000,
    },
  ]);
});

test("appendToolResult stores output text + is_error", () => {
  const db = freshDb();
  const chatId = seedChat(db);
  const repo = makeMessagesRepo(db);

  repo.appendToolResult(chatId, "run-1", "tool-call-abc", "out", false, 2001);
  repo.appendToolResult(chatId, "run-1", "tool-call-def", "err", true, 2002);

  expect(repo.walk(chatId)).toEqual([
    {
      role: "tool_result",
      tool_call_id: "tool-call-abc",
      output: "out",
      is_error: false,
      ts: 2001,
    },
    {
      role: "tool_result",
      tool_call_id: "tool-call-def",
      output: "err",
      is_error: true,
      ts: 2002,
    },
  ]);
});

test("walk preserves insertion order across runs via (ts, ord)", () => {
  const db = freshDb();
  const chatId = seedChat(db, "run-1");
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES (?, ?, 'maya', 'chat', 'running', ?)",
    ["run-2", chatId, Date.now()],
  );
  const repo = makeMessagesRepo(db);

  repo.appendUser(chatId, "run-1", "q1", 1000);
  repo.appendAssistant(chatId, "run-1", "a1", 1010);
  repo.appendUser(chatId, "run-2", "q2", 1020);
  repo.appendAssistant(chatId, "run-2", "a2", 1030);

  const out = repo.walk(chatId);
  expect(out.map((m: any) => m.content)).toEqual(["q1", "a1", "q2", "a2"]);
});

test("walk preserves ord when ts ties (multiple tool_use within one ts)", () => {
  const db = freshDb();
  const chatId = seedChat(db);
  const repo = makeMessagesRepo(db);

  repo.appendAssistant(chatId, "run-1", "thinking", 5000);
  repo.appendToolUse(chatId, "run-1", "t1", "Bash", "{}", 5000);
  repo.appendToolUse(chatId, "run-1", "t2", "Read", "{}", 5000);

  const out = repo.walk(chatId);
  expect(out.map((m: any) => m.role)).toEqual([
    "assistant",
    "tool_use",
    "tool_use",
  ]);
  expect((out[1] as any).tool_call_id).toBe("t1");
  expect((out[2] as any).tool_call_id).toBe("t2");
});

test("lastAssistantText returns latest assistant content or empty", () => {
  const db = freshDb();
  const chatId = seedChat(db);
  const repo = makeMessagesRepo(db);

  expect(repo.lastAssistantText(chatId)).toBe("");

  repo.appendUser(chatId, "run-1", "q", 1000);
  repo.appendAssistant(chatId, "run-1", "first answer", 1010);
  expect(repo.lastAssistantText(chatId)).toBe("first answer");

  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES ('run-2', ?, 'maya', 'chat', 'running', ?)",
    [chatId, Date.now()],
  );
  repo.appendAssistant(chatId, "run-2", "second answer", 1020);
  expect(repo.lastAssistantText(chatId)).toBe("second answer");
});

test("walk returns [] for chat with no rows", () => {
  const db = freshDb();
  const chatId = seedChat(db, null);
  const repo = makeMessagesRepo(db);
  expect(repo.walk(chatId)).toEqual([]);
});

test("appendToolUse with malformed JSON input falls back to raw string", () => {
  const db = freshDb();
  const chatId = seedChat(db);
  const repo = makeMessagesRepo(db);

  // Caller should pass valid JSON, but we should not crash on malformed.
  repo.appendToolUse(chatId, "run-1", "t1", "Bash", "not-json", 2000);
  const out = repo.walk(chatId);
  expect((out[0] as any).input).toBe("not-json");
});

test("walk surfaces cancelled=true on assistant entries from cancelled runs", () => {
  const db = freshDb();
  const chatId = seedChat(db, "run-1");
  const repo = makeMessagesRepo(db);

  repo.appendUser(chatId, "run-1", "go", 1000);
  repo.appendAssistant(chatId, "run-1", "partial answer", 1010);
  // Simulate the orchestrator's terminal stamp for ESC cancel.
  db.run("UPDATE runs SET status = 'cancelled', ended_at = ? WHERE id = ?", [
    1020,
    "run-1",
  ]);

  const out = repo.walk(chatId);
  expect(out).toEqual([
    { role: "user", content: "go", ts: 1000 },
    {
      role: "assistant",
      content: "partial answer",
      ts: 1010,
      cancelled: true,
    },
  ]);
});

test("walk omits cancelled flag on assistant entries from done runs", () => {
  const db = freshDb();
  const chatId = seedChat(db, "run-1");
  const repo = makeMessagesRepo(db);

  repo.appendAssistant(chatId, "run-1", "all good", 1010);
  db.run("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?", [
    1020,
    "run-1",
  ]);

  const out = repo.walk(chatId);
  expect(out).toEqual([
    { role: "assistant", content: "all good", ts: 1010 },
  ]);
  expect((out[0] as { cancelled?: boolean }).cancelled).toBeUndefined();
});

test("walk does not stamp cancelled on user rows from cancelled runs", () => {
  const db = freshDb();
  const chatId = seedChat(db, "run-1");
  const repo = makeMessagesRepo(db);

  repo.appendUser(chatId, "run-1", "go", 1000);
  db.run("UPDATE runs SET status = 'cancelled', ended_at = ? WHERE id = ?", [
    1020,
    "run-1",
  ]);

  const out = repo.walk(chatId);
  expect(out).toEqual([
    { role: "user", content: "go", ts: 1000 },
  ]);
  expect((out[0] as { cancelled?: boolean }).cancelled).toBeUndefined();
});
