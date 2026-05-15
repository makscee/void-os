// VOS-80 architecture (a): lazy JSONL import for legacy chats.
//
// Chats created pre-VOS-80 have history only in CC's filesystem JSONL.
// On the FIRST walk() for such a chat (DB has no rows, session_id is
// set), session-replay parses the JSONL once, seeds the messages table,
// and serves DB rows. Subsequent walks read from DB only.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { makeChatRepo, openTaskFor } from "../../src/chat/repo";
import { makeMessagesRepo } from "../../src/chat/messages-repo";
import { makeSessionReplay } from "../../src/chat/session-replay";

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
    "0005_costs_cache.sql",
    "0006_costs_chat_id.sql",
    "0007_a2a_tables.sql",
  ]) {
    db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }
  return db;
}

function writeLegacyJsonl(projDir: string, sid: string) {
  mkdirSync(projDir, { recursive: true });
  const lines = [
    JSON.stringify({
      uuid: "u1",
      type: "user",
      message: { content: [{ type: "text", text: "hi" }] },
      ts: 1,
    }),
    JSON.stringify({
      uuid: "u2",
      parent_uuid: "u1",
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
      ts: 2,
    }),
    JSON.stringify({
      uuid: "u3",
      parent_uuid: "u2",
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
        ],
      },
      ts: 3,
    }),
    JSON.stringify({
      uuid: "u4",
      parent_uuid: "u3",
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
        ],
      },
      ts: 4,
    }),
  ];
  writeFileSync(join(projDir, `${sid}.jsonl`), lines.join("\n") + "\n");
}

test("first walk imports JSONL into messages table", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos80-lazy-"));
  writeLegacyJsonl(join(tmp, "-tmp-legacy"), "sid-legacy");

  const db = freshDb();
  const chatRepo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const chat = chatRepo.create({ agent: "maya" });
  chatRepo.setSession(chat.id, "sid-legacy");

  // Pre-import: no rows.
  expect(messages.walk(chat.id)).toEqual([]);

  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/legacy",
    encodeCwd: () => "-tmp-legacy",
  });

  const out = replay.walk(chat.id);
  expect(out.map((m: any) => m.role)).toEqual([
    "user",
    "assistant",
    "tool_use",
    "tool_result",
  ]);

  // Post-import: messages table now has rows.
  const post = messages.walk(chat.id);
  expect(post.length).toBe(4);
});

test("second walk reads from DB, not JSONL (deduplication)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos80-lazy-"));
  const projDir = join(tmp, "-tmp-dedupe");
  writeLegacyJsonl(projDir, "sid-dedupe");

  const db = freshDb();
  const chatRepo = makeChatRepo(db);
  const chat = chatRepo.create({ agent: "maya" });
  chatRepo.setSession(chat.id, "sid-dedupe");

  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/dedupe",
    encodeCwd: () => "-tmp-dedupe",
  });

  const first = replay.walk(chat.id);
  const second = replay.walk(chat.id);
  expect(first).toEqual(second);
  expect(second.length).toBe(4);
});

test("five parallel walk() calls return identical data", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos80-lazy-"));
  writeLegacyJsonl(join(tmp, "-tmp-parallel"), "sid-par");

  const db = freshDb();
  const chatRepo = makeChatRepo(db);
  const chat = chatRepo.create({ agent: "maya" });
  chatRepo.setSession(chat.id, "sid-par");

  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/parallel",
    encodeCwd: () => "-tmp-parallel",
  });

  // bun:sqlite is synchronous, but mirror the 5-parallel-GET pattern by
  // calling walk() five times back-to-back through Promise.all.
  const results = await Promise.all(
    Array.from({ length: 5 }, () => Promise.resolve(replay.walk(chat.id))),
  );
  for (const r of results) {
    expect(r.length).toBe(4);
    expect(r.map((m: any) => m.role)).toEqual([
      "user",
      "assistant",
      "tool_use",
      "tool_result",
    ]);
  }
});

test("chat with no session_id returns [] without inserting rows", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos80-lazy-"));
  const db = freshDb();
  const chatRepo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const chat = chatRepo.create({ agent: "maya" });

  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/none",
    encodeCwd: () => "-tmp-none",
  });

  expect(replay.walk(chat.id)).toEqual([]);
  expect(messages.walk(chat.id)).toEqual([]);
});

test("chat with session_id but missing JSONL file returns [] (no rows seeded)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos80-lazy-"));
  const db = freshDb();
  const chatRepo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const chat = chatRepo.create({ agent: "maya" });
  chatRepo.setSession(chat.id, "sid-missing");

  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/missing",
    encodeCwd: () => "-tmp-missing",
  });

  expect(replay.walk(chat.id)).toEqual([]);
  expect(messages.walk(chat.id)).toEqual([]);
});

test("DB rows present: JSONL is ignored", () => {
  // Pre-seed DB with one user row. JSONL has different content. walk()
  // must return ONLY the DB row.
  const tmp = mkdtempSync(join(tmpdir(), "vos80-lazy-"));
  writeLegacyJsonl(join(tmp, "-tmp-priority"), "sid-priority");

  const db = freshDb();
  const chatRepo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const chat = chatRepo.create({ agent: "maya" });
  chatRepo.setSession(chat.id, "sid-priority");
  const taskId = openTaskFor(db, chat.id);
  messages.appendMessage(
    taskId,
    chat.id,
    "run-x",
    "ROLE_USER",
    [{ text: "FROM_DB" }],
    100,
  );

  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/priority",
    encodeCwd: () => "-tmp-priority",
  });

  const out = replay.walk(chat.id);
  expect(out.length).toBe(1);
  expect((out[0] as any).content).toBe("FROM_DB");
});
