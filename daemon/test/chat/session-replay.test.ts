// session-replay tests — per VOS-99 plan (decouple from CC shape).
// Retained: partial-trailing diagnostic smoke test (DB-authoritative path).
// Added: empty-walk + tool-call round-trip via messages-repo Part[] shape.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/adapters/sqlite/migrations.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { makeChatRepo } from "../../src/chat/repo";
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
  applyMigrations(
    db,
    loadMigrations(MIGRATIONS_DIR).filter(
      (mg) => mg.version.slice(0, 4) <= "0016",
    ),
  );
  return db;
}

// VOS-84 T20: surfaceTraceDiagnostics path — replay must NOT throw when the
// daemon-side VOS-84 trace file resolved via runs.trace_path has a partial
// trailing line. The diagnostic is advisory (console.warn); the messages
// table remains authoritative. Adapted from the plan-as-written, which
// assumed session-replay parses VOS-84 envelopes as its primary path.
test("session-replay surfaces partial-trailing diagnostic without throwing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vos84-replay-partial-"));
  const tracePath = join(tmp, "trace.jsonl");
  const fullLines =
    JSON.stringify({
      seq: 0,
      ts: "2026-05-16T00:00:00.000Z",
      kind: "turn.start",
      payload: { runId: "r1", agent: "a", kind: "chat" },
    }) + "\n" +
    JSON.stringify({
      seq: 1,
      ts: "2026-05-16T00:00:00.001Z",
      kind: "cc.event",
      payload: { message: { content: [{ type: "text", text: "hello" }] } },
    }) + "\n";
  const partial = '{"seq":2,"ts":"2026-05-16T00:00:00.002Z","kind"';
  writeFileSync(tracePath, fullLines + partial);

  const db = freshDb();
  const repo = makeChatRepo(db);
  const c = repo.create({ agent: "maya" });

  // Seed a messages row so walk() takes the "DB has rows" path that calls
  // surfaceTraceDiagnostics (per VOS-84 T18 implementation).
  db.run(
    "INSERT INTO messages (task_id, context_id, run_id, role, parts, parts_text, ts, ord) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [c.id, c.id, "r1", "ROLE_USER", JSON.stringify([{ text: "hi" }]), "hi", 1, 1],
  );
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at, trace_path) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["r1", c.id, "maya", "chat", "done", 1, tracePath],
  );

  const replay = makeSessionReplay(db);

  // Spy on console.warn — the partial-trailing diagnostic emits a warning
  // mentioning "partial trailing line".
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    expect(() => replay.walk(c.id)).not.toThrow();
    const msgs = replay.walk(c.id);
    // DB row is still authoritative.
    expect(msgs.map((m) => (m as { content: string }).content)).toEqual(["hi"]);
    // Diagnostic surfaced for partial trailing line.
    expect(warnings.some((w) => w.includes("partial trailing line"))).toBe(true);
  } finally {
    console.warn = origWarn;
  }
});

test("walk returns [] for a chat with session_id but no messages rows", () => {
  const db = freshDb();
  const chatRepo = makeChatRepo(db);
  const { id } = chatRepo.create({ agent: "claude-code" });
  chatRepo.setSession(id, "session-no-rows");
  const replay = makeSessionReplay(db);
  expect(replay.walk(id)).toEqual([]);
});

test("tool-call round-trip: tool_use + tool_result Part entries surface correctly", () => {
  const db = freshDb();
  const chatRepo = makeChatRepo(db);
  const messagesRepo = makeMessagesRepo(db);
  const { id, task_id } = chatRepo.create({ agent: "claude-code" });

  // Seed one assistant turn with a tool_use DataPart.
  messagesRepo.appendMessage(
    task_id,
    id,
    null,
    "ROLE_AGENT",
    [
      {
        data: {
          kind: "tool_use",
          tool_call_id: "tc-1",
          tool_name: "bash",
          input: { cmd: "ls" },
        },
      },
    ],
    1000,
  );

  // Seed one user turn with a tool_result DataPart.
  messagesRepo.appendMessage(
    task_id,
    id,
    null,
    "ROLE_USER",
    [
      {
        data: {
          kind: "tool_result",
          tool_call_id: "tc-1",
          output: "file1\nfile2\n",
          is_error: false,
        },
      },
    ],
    2000,
  );

  const replay = makeSessionReplay(db);
  const entries = replay.walk(id);

  const toolUse = entries.find((e) => e.role === "tool_use");
  const toolResult = entries.find((e) => e.role === "tool_result");

  expect(toolUse).toMatchObject({
    role: "tool_use",
    tool_call_id: "tc-1",
    name: "bash",
    input: { cmd: "ls" },
  });
  expect(toolResult).toMatchObject({
    role: "tool_result",
    tool_call_id: "tc-1",
    output: "file1\nfile2\n",
    is_error: false,
  });
});
