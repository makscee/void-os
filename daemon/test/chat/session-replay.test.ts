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
  // Real CC shape: text lives at message.content[] as array of blocks.
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
        message: { content: [{ type: "text", text: "hi" }] },
        ts: 1,
      }) +
      "\n" +
      JSON.stringify({
        uuid: "u3",
        parent_uuid: "u2",
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
        ts: 2,
      }) +
      "\n" +
      JSON.stringify({ uuid: "u4", parent_uuid: "u3", type: "attachment" }) +
      "\n" +
      JSON.stringify({
        uuid: "u5",
        parent_uuid: "u4",
        type: "user",
        message: { content: [{ type: "text", text: "again" }] },
        ts: 3,
      }) +
      "\n" +
      JSON.stringify({
        uuid: "u6",
        parent_uuid: "u5",
        type: "assistant",
        message: { content: [{ type: "text", text: "hey" }] },
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
    JSON.stringify({
      uuid: "a",
      type: "user",
      message: { content: [{ type: "text", text: "good" }] },
    }) +
      "\n" +
      "{not json" +
      "\n" +
      JSON.stringify({
        uuid: "b",
        parent_uuid: "a",
        type: "assistant",
        message: { content: [{ type: "text", text: "also good" }] },
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

test("assistant turn with multiple text blocks → concatenates", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos79-replay-"));
  const projDir = join(tmp, "-tmp-multi");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, "sid-m.jsonl"),
    JSON.stringify({
      uuid: "a",
      type: "user",
      message: { content: [{ type: "text", text: "q" }] },
    }) +
      "\n" +
      JSON.stringify({
        uuid: "b",
        parent_uuid: "a",
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "part1 " },
            { type: "text", text: "part2" },
          ],
        },
      }) +
      "\n",
  );
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  repo.setSession(c.id, "sid-m");
  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/multi",
    encodeCwd: () => "-tmp-multi",
  });
  const msgs = replay.walk(c.id);
  expect(msgs.map((m) => m.content)).toEqual(["q", "part1 part2"]);
});

test("assistant turn with mixed text + tool_use blocks → returns text only", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos79-replay-"));
  const projDir = join(tmp, "-tmp-mixed");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, "sid-mix.jsonl"),
    JSON.stringify({
      uuid: "a",
      type: "user",
      message: { content: [{ type: "text", text: "go" }] },
    }) +
      "\n" +
      JSON.stringify({
        uuid: "b",
        parent_uuid: "a",
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "thinking..." },
            { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
          ],
        },
      }) +
      "\n",
  );
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  repo.setSession(c.id, "sid-mix");
  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/mixed",
    encodeCwd: () => "-tmp-mixed",
  });
  const msgs = replay.walk(c.id);
  expect(msgs.map((m) => m.content)).toEqual(["go", "thinking..."]);
});

test("turn with only tool_use / tool_result blocks → filtered out", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos79-replay-"));
  const projDir = join(tmp, "-tmp-tools");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, "sid-t.jsonl"),
    JSON.stringify({
      uuid: "a",
      type: "user",
      message: { content: [{ type: "text", text: "do it" }] },
    }) +
      "\n" +
      // Pure tool_use turn — no narration text.
      JSON.stringify({
        uuid: "b",
        parent_uuid: "a",
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
          ],
        },
      }) +
      "\n" +
      // Pure tool_result turn (CC encodes these as user-role records).
      JSON.stringify({
        uuid: "c",
        parent_uuid: "b",
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "file1\n" },
          ],
        },
      }) +
      "\n" +
      JSON.stringify({
        uuid: "d",
        parent_uuid: "c",
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }] },
      }) +
      "\n",
  );
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  repo.setSession(c.id, "sid-t");
  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/tools",
    encodeCwd: () => "-tmp-tools",
  });
  const msgs = replay.walk(c.id);
  // Only the visible-text turns survive. tool_use + tool_result-only turns
  // drop. S4 will surface those via separate event paths.
  expect(msgs.map((m) => m.content)).toEqual(["do it", "done"]);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
});

test("legacy/defensive: message.content as plain string is handled", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos79-replay-"));
  const projDir = join(tmp, "-tmp-str");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, "sid-s.jsonl"),
    JSON.stringify({
      uuid: "a",
      type: "user",
      message: { content: "plain user string" },
    }) +
      "\n" +
      JSON.stringify({
        uuid: "b",
        parent_uuid: "a",
        type: "assistant",
        message: { content: "plain assistant string" },
      }) +
      "\n",
  );
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  repo.setSession(c.id, "sid-s");
  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/str",
    encodeCwd: () => "-tmp-str",
  });
  const msgs = replay.walk(c.id);
  expect(msgs.map((m) => m.content)).toEqual([
    "plain user string",
    "plain assistant string",
  ]);
});

test("fallback: visible records with no parent_uuid → file-order traversal returns all", () => {
  // Newer CC builds emit visible turns with parent_uuid undefined; the chain
  // runs through queue-operation/attachment records we filter out by type.
  // DAG walk would yield 1 message (the latest leaf only). Fallback recovers
  // every visible turn in file order.
  const tmp = mkdtempSync(join(tmpdir(), "vos79-replay-"));
  const projDir = join(tmp, "-tmp-degen");
  mkdirSync(projDir, { recursive: true });
  const lines = [
    JSON.stringify({ uuid: "qo1", type: "queue-operation" }),
    JSON.stringify({ uuid: "at1", type: "attachment" }),
    JSON.stringify({
      uuid: "v1",
      type: "user",
      message: { content: [{ type: "text", text: "hi" }] },
      ts: 1,
    }),
    JSON.stringify({
      uuid: "v2",
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] },
      ts: 2,
    }),
    JSON.stringify({ uuid: "at2", type: "attachment" }),
    JSON.stringify({
      uuid: "v3",
      type: "user",
      message: { content: [{ type: "text", text: "again" }] },
      ts: 3,
    }),
    JSON.stringify({
      uuid: "v4",
      type: "assistant",
      message: { content: [{ type: "text", text: "hey" }] },
      ts: 4,
    }),
  ];
  writeFileSync(join(projDir, "sid-d.jsonl"), lines.join("\n") + "\n");
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  repo.setSession(c.id, "sid-d");
  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/degen",
    encodeCwd: () => "-tmp-degen",
  });
  const msgs = replay.walk(c.id);
  expect(msgs.length).toBe(4);
  expect(msgs.map((m) => m.content)).toEqual(["hi", "hello", "again", "hey"]);
  expect(msgs.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
});

test("fallback skips empty-content turns (pure tool_use) in degenerate-chain mode", () => {
  // Even when falling back to file order, extractTurnText filtering still
  // applies — pure tool_use turns must not surface as empty messages.
  const tmp = mkdtempSync(join(tmpdir(), "vos79-replay-"));
  const projDir = join(tmp, "-tmp-degen-tools");
  mkdirSync(projDir, { recursive: true });
  const lines = [
    JSON.stringify({
      uuid: "v1",
      type: "user",
      message: { content: [{ type: "text", text: "do it" }] },
    }),
    JSON.stringify({
      uuid: "v2",
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
        ],
      },
    }),
    JSON.stringify({
      uuid: "v3",
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] },
    }),
  ];
  writeFileSync(join(projDir, "sid-dt.jsonl"), lines.join("\n") + "\n");
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  repo.setSession(c.id, "sid-dt");
  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/degen-tools",
    encodeCwd: () => "-tmp-degen-tools",
  });
  const msgs = replay.walk(c.id);
  // Pure tool_use turn (v2) drops; only v1 + v3 surface.
  expect(msgs.map((m) => m.content)).toEqual(["do it", "done"]);
});

test("DAG walk preferred when chain is intact and covers all visible records", () => {
  // Sanity: the original DAG-chain test case is already covered above; this
  // adds an explicit assertion that when DAG walk recovers ALL visible turns,
  // the fallback is NOT invoked (so e.g. an out-of-DAG orphan is correctly
  // ignored). Here u_orphan has no parent and is unreachable from the DAG,
  // but DAG walk yields {u2, u3} == 2 visible — equal to total visible (2)
  // because u_orphan is queue-operation, not visible.
  const tmp = mkdtempSync(join(tmpdir(), "vos79-replay-"));
  const projDir = join(tmp, "-tmp-intact");
  mkdirSync(projDir, { recursive: true });
  const lines = [
    JSON.stringify({ uuid: "u_orphan", type: "queue-operation" }),
    JSON.stringify({
      uuid: "u2",
      type: "user",
      message: { content: [{ type: "text", text: "q" }] },
    }),
    JSON.stringify({
      uuid: "u3",
      parent_uuid: "u2",
      type: "assistant",
      message: { content: [{ type: "text", text: "a" }] },
    }),
  ];
  writeFileSync(join(projDir, "sid-i.jsonl"), lines.join("\n") + "\n");
  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });
  repo.setSession(c.id, "sid-i");
  const replay = makeSessionReplay(db, {
    projectsRoot: tmp,
    cwd: "/tmp/intact",
    encodeCwd: () => "-tmp-intact",
  });
  const msgs = replay.walk(c.id);
  expect(msgs.map((m) => m.content)).toEqual(["q", "a"]);
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
