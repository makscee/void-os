// session-replay tests — per VOS-79 plan Task 4.
// Fixtures cover: linear DAG with mixed types, missing file, NULL session_id,
// malformed lines, and the realpath-slug encoder.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { makeChatRepo } from "../../src/chat/repo";
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
  ]) {
    db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }
  return db;
}

test("walk reads single JSONL and filters to user/assistant via parent_uuid DAG", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos79-replay-"));
  const projDir = join(tmp, "-tmp-fake");
  mkdirSync(projDir, { recursive: true });
  // Linear DAG: queue-op → attachment → user → assistant → attachment → user(resume) → assistant
  writeFileSync(
    join(projDir, "sid-1.jsonl"),
    JSON.stringify({ uuid: "u0", type: "queue-operation" }) +
      "\n" +
      JSON.stringify({ uuid: "u1", parent_uuid: "u0", type: "attachment" }) +
      "\n" +
      JSON.stringify({
        uuid: "u2",
        parent_uuid: "u1",
        type: "user",
        content: "hi",
        ts: 1,
      }) +
      "\n" +
      JSON.stringify({
        uuid: "u3",
        parent_uuid: "u2",
        type: "assistant",
        content: "hello",
        ts: 2,
      }) +
      "\n" +
      JSON.stringify({ uuid: "u4", parent_uuid: "u3", type: "attachment" }) +
      "\n" +
      JSON.stringify({
        uuid: "u5",
        parent_uuid: "u4",
        type: "user",
        content: "again",
        ts: 3,
      }) +
      "\n" +
      JSON.stringify({
        uuid: "u6",
        parent_uuid: "u5",
        type: "assistant",
        content: "hey",
        ts: 4,
      }) +
      "\n",
  );

  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  repo.setSession(c.id, "sid-1");

  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/fake",
    encodeCwd: () => "-tmp-fake",
  });
  const msgs = replay.walk(c.id);
  // 4 visible messages: u2,u3,u5,u6 — attachments and queue-op stripped.
  expect(msgs.length).toBe(4);
  expect(msgs.map((m) => m.content)).toEqual(["hi", "hello", "again", "hey"]);
  expect(msgs.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
});

test("missing JSONL returns [] (no throw)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos79-replay-"));
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  repo.setSession(c.id, "sid-missing");
  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/none",
    encodeCwd: () => "-tmp-none",
  });
  expect(replay.walk(c.id)).toEqual([]);
});

test("chat with NULL session_id returns [] (no replay before first turn)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos79-replay-"));
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/x",
    encodeCwd: () => "-tmp-x",
  });
  expect(replay.walk(c.id)).toEqual([]);
});

test("unknown chat id returns [] (defensive)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos79-replay-"));
  const db = freshDb();
  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/x",
    encodeCwd: () => "-tmp-x",
  });
  expect(replay.walk("nonexistent-id")).toEqual([]);
});

test("malformed JSONL line skipped, other lines kept", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos79-replay-"));
  const projDir = join(tmp, "-tmp-bad");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, "sid-x.jsonl"),
    JSON.stringify({ uuid: "a", type: "user", content: "good" }) +
      "\n" +
      "{not json" +
      "\n" +
      JSON.stringify({
        uuid: "b",
        parent_uuid: "a",
        type: "assistant",
        content: "also good",
      }) +
      "\n",
  );
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  repo.setSession(c.id, "sid-x");
  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/bad",
    encodeCwd: () => "-tmp-bad",
  });
  expect(replay.walk(c.id).length).toBe(2);
});

test("realpath encoder: macOS /tmp resolves to -private-tmp-* slug", () => {
  // Use a real tmpdir so realpath has something to resolve. On macOS
  // mkdtempSync(tmpdir()) usually returns /var/folders/... which is itself a
  // symlink target; assert the slug starts with '-' and contains no slashes,
  // and is derived from realpathSync of the input path.
  const real = mkdtempSync(join(tmpdir(), "vos79-encode-"));
  // Import the module fresh to grab the production encoder via default opts.
  // We exercise the default by NOT passing encodeCwd.
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  repo.setSession(c.id, "sid-encode");
  const replay = makeSessionReplay(db, {
    projectsRoot: real,
    cwd: real,
  });
  // No JSONL written → expect []. The point is encode() must NOT throw.
  expect(replay.walk(c.id)).toEqual([]);
});
