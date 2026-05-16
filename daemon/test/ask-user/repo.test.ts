// VOS-88 T4: SQLite CAS helpers for ask_user.
//
// Helpers covered:
//   - setTaskInputRequired: CAS UPDATE on tasks (WORKING + null pending -> INPUT_REQUIRED + stash)
//   - clearTaskPending:     CAS UPDATE back to WORKING (used by timeout-rollback + answer-route)
//   - appendToolUseMessage: thin wrapper over makeMessagesRepo().appendMessage with a DataPart
//   - appendToolResultMessage: thin wrapper writing a DataPart tool_result
//
// Deviation from plan §T4: the project's `Part` union uses v1.0 member-name
// discrimination (TextPart/DataPart), not literal `{type:"tool_use"}`. Per the
// T2 spike (spec §12) we delegate to the existing `appendMessage` and encode
// tool blocks as DataPart{ data.kind: "tool_use"|"tool_result" } so they round-
// trip through the existing `walk()` decoder.

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import {
  setTaskInputRequired,
  clearTaskPending,
  appendToolUseMessage,
  appendToolResultMessage,
} from "../../src/chat/ask-user-repo";

const MIGRATIONS = join(import.meta.dir, "../../src/adapters/sqlite/migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS);
  // Seed reconciled against 0007 schema (NOT NULL: agent_name on contexts;
  // tokens_in/tokens_out/cost_usd/metadata on tasks; chat_id/agent/kind/
  // status/started_at on runs from earlier migrations).
  db.run(
    "INSERT INTO contexts (id, agent_name, title, created_at, updated_at, archived) VALUES ('ctx-1', 'maya', NULL, 0, 0, 0)",
  );
  db.run(
    "INSERT INTO tasks (id, context_id, state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at) " +
      "VALUES ('t-1', 'ctx-1', 'TASK_STATE_WORKING', 0, 0, 0, '{}', 0, 0)",
  );
  db.run(
    "INSERT INTO runs (id, chat_id, task_id, agent, kind, status, started_at) " +
      "VALUES ('r-1', 'ctx-1', 't-1', 'maya', 'chat', 'running', 0)",
  );
  return db;
}

describe("setTaskInputRequired", () => {
  it("flips WORKING + null pending to INPUT_REQUIRED + stashed metadata", () => {
    const db = freshDb();
    const ok = setTaskInputRequired(db, "t-1", "tu-1", "ok?", ["yes", "no"]);
    expect(ok).toBe(true);
    const row = db.query("SELECT state, metadata FROM tasks WHERE id='t-1'").get() as {
      state: string;
      metadata: string;
    };
    expect(row.state).toBe("TASK_STATE_INPUT_REQUIRED");
    const md = JSON.parse(row.metadata);
    expect(md.pending_tool_use_id).toBe("tu-1");
    expect(md.question).toBe("ok?");
    expect(md.options).toEqual(["yes", "no"]);
  });

  it("stores options as null when undefined", () => {
    const db = freshDb();
    expect(setTaskInputRequired(db, "t-1", "tu-1", "ok?", undefined)).toBe(true);
    const row = db.query("SELECT metadata FROM tasks WHERE id='t-1'").get() as {
      metadata: string;
    };
    const md = JSON.parse(row.metadata);
    expect(md.options).toBeNull();
  });

  it("returns false when state is already INPUT_REQUIRED", () => {
    const db = freshDb();
    expect(setTaskInputRequired(db, "t-1", "tu-1", "ok?", undefined)).toBe(true);
    expect(setTaskInputRequired(db, "t-1", "tu-2", "again?", undefined)).toBe(false);
  });

  it("returns false when task does not exist", () => {
    const db = freshDb();
    expect(setTaskInputRequired(db, "nope", "tu-1", "ok?", undefined)).toBe(false);
  });
});

describe("clearTaskPending", () => {
  it("flips INPUT_REQUIRED back to WORKING and removes pending metadata when ids match", () => {
    const db = freshDb();
    setTaskInputRequired(db, "t-1", "tu-1", "ok?", undefined);
    const ok = clearTaskPending(db, "t-1", "tu-1");
    expect(ok).toBe(true);
    const row = db.query("SELECT state, metadata FROM tasks WHERE id='t-1'").get() as {
      state: string;
      metadata: string;
    };
    expect(row.state).toBe("TASK_STATE_WORKING");
    const md = JSON.parse(row.metadata);
    expect(md.pending_tool_use_id).toBeUndefined();
    expect(md.question).toBeUndefined();
    expect(md.options).toBeUndefined();
  });

  it("returns false when pending_tool_use_id does not match", () => {
    const db = freshDb();
    setTaskInputRequired(db, "t-1", "tu-1", "ok?", undefined);
    expect(clearTaskPending(db, "t-1", "tu-OTHER")).toBe(false);
  });

  it("returns false when task is already WORKING (idempotency / late race)", () => {
    const db = freshDb();
    setTaskInputRequired(db, "t-1", "tu-1", "ok?", undefined);
    expect(clearTaskPending(db, "t-1", "tu-1")).toBe(true);
    expect(clearTaskPending(db, "t-1", "tu-1")).toBe(false);
  });
});

describe("appendToolUseMessage", () => {
  it("writes a ROLE_AGENT message with a DataPart tool_use block", () => {
    const db = freshDb();
    const id = appendToolUseMessage(db, {
      taskId: "t-1",
      contextId: "ctx-1",
      runId: "r-1",
      toolUseId: "tu-1",
      question: "ok?",
      options: ["yes", "no"],
    });
    const row = db.query("SELECT role, parts, parts_text FROM messages WHERE id=?").get(id) as {
      role: string;
      parts: string;
      parts_text: string;
    };
    expect(row.role).toBe("ROLE_AGENT");
    // parts_text is the flattened TextPart concatenation. Our part has no
    // TextPart, so parts_text is empty (appendMessage's flattenText filters
    // by typeof p.text === 'string').
    expect(row.parts_text).toBe("");
    const parts = JSON.parse(row.parts);
    expect(parts).toEqual([
      {
        data: {
          kind: "tool_use",
          tool_call_id: "tu-1",
          tool_name: "ask_user",
          input: { question: "ok?", options: ["yes", "no"] },
        },
      },
    ]);
  });

  it("omits options key when undefined", () => {
    const db = freshDb();
    const id = appendToolUseMessage(db, {
      taskId: "t-1",
      contextId: "ctx-1",
      runId: "r-1",
      toolUseId: "tu-2",
      question: "ok?",
      options: undefined,
    });
    const row = db.query("SELECT parts FROM messages WHERE id=?").get(id) as { parts: string };
    const parts = JSON.parse(row.parts);
    expect(parts[0].data.input).toEqual({ question: "ok?" });
  });
});

describe("appendToolResultMessage", () => {
  it("writes a ROLE_USER message with a DataPart tool_result block", () => {
    const db = freshDb();
    const id = appendToolResultMessage(db, {
      taskId: "t-1",
      contextId: "ctx-1",
      runId: "r-1",
      toolUseId: "tu-1",
      answer: "yes",
    });
    const row = db.query("SELECT role, parts, parts_text FROM messages WHERE id=?").get(id) as {
      role: string;
      parts: string;
      parts_text: string;
    };
    expect(row.role).toBe("ROLE_USER");
    expect(row.parts_text).toBe("");
    const parts = JSON.parse(row.parts);
    expect(parts).toEqual([
      {
        data: {
          kind: "tool_result",
          tool_call_id: "tu-1",
          output: "yes",
          is_error: false,
        },
      },
    ]);
  });
});
