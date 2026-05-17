// VOS-109 T6 — messages-repo round-trips DataPart denial through parts JSON.
//
// The run-driver (T3) appends a synthesised denial DataPart inline with the
// offending tool_result before the orchestrator calls appendMessage. The
// JSON-serialised parts column therefore carries:
//   [TextPart, DataPart{data.kind="tool_use"}, DataPart{data.kind="tool_result"},
//    DataPart{data.kind="denial", toolCallId, reason, attemptedPath, agent, message}]
//
// On refetch (GET /chat/:id/messages) the plugin reducer (T4) expects the
// walk() output to emit a row of shape:
//   { role:"denial", tool_call_id, reason, attempted_path, agent, message }
// which `replayToMessages` attaches to the nearest preceding assistant turn
// as a DenialPart. This test pins that contract end-to-end.
//
// See plugin/src/chat/__tests__/reducer-denial.test.ts for the consumer side.

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { applyMigrations, loadMigrations } from "../../adapters/sqlite/migrations";
import { makeMessagesRepo } from "../messages-repo";
import type { Part } from "../../types/a2a";

const MIGRATIONS_DIR = join(import.meta.dir, "../../adapters/sqlite/migrations");

function seed(db: Database): { contextId: string; taskId: string; runId: string } {
  const contextId = "c-denial-1";
  const taskId = "t-denial-1";
  const runId = "r-denial-1";
  const now = Date.now();
  db.exec("PRAGMA foreign_keys = ON");
  db.run(
    "INSERT INTO contexts (id, agent_name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [contextId, "maya", now, now],
  );
  db.run(
    "INSERT INTO tasks (id, context_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [taskId, contextId, "TASK_STATE_WORKING", now, now],
  );
  db.run(
    "INSERT INTO runs (id, chat_id, task_id, started_at, status, agent, kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [runId, contextId, taskId, now, "running", "maya", "chat"],
  );
  return { contextId, taskId, runId };
}

describe("messages-repo: DataPart denial round-trip (VOS-109 T6)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const migrations = loadMigrations(MIGRATIONS_DIR);
    applyMigrations(db, migrations);
  });

  test("walk() emits a 'denial' replay row matching the reducer's expected shape", () => {
    const { contextId, taskId, runId } = seed(db);
    const repo = makeMessagesRepo(db);

    const parts: Part[] = [
      { text: "trying to create the file" } as Part,
      // tool_use DataPart — should walk back as ToolUseEntry.
      {
        data: {
          kind: "tool_use",
          tool_call_id: "tu-1",
          tool_name: "vault.create",
          input: { path: "journal/forbidden.md", content: "x" },
        },
      },
      // tool_result DataPart (the offending deny) — ToolResultEntry.
      {
        data: {
          kind: "tool_result",
          tool_call_id: "tu-1",
          output:
            "SCOPE_DENIED: journal/forbidden.md outside write_scope for agent maya",
          is_error: true,
        },
      },
      // denial DataPart — synthesised by run-driver. The persisted payload
      // uses camelCase field names (matches T3 onPart frame + outcome.parts).
      {
        data: {
          kind: "denial",
          toolCallId: "tu-1",
          reason: "scope_violation",
          attemptedPath: "journal/forbidden.md",
          agent: "maya",
          message:
            "Write denied: maya is not allowed to write journal/forbidden.md.",
        },
      },
    ];

    repo.appendMessage(taskId, contextId, runId, "ROLE_AGENT", parts);

    const entries = repo.walk(contextId);

    // Expected ordering: assistant text turn, tool_use, tool_result, denial.
    expect(entries.length).toBe(4);

    expect(entries[0]).toMatchObject({
      role: "assistant",
      content: "trying to create the file",
      task_id: taskId,
    });

    expect(entries[1]).toMatchObject({
      role: "tool_use",
      tool_call_id: "tu-1",
      name: "vault.create",
      task_id: taskId,
    });

    expect(entries[2]).toMatchObject({
      role: "tool_result",
      tool_call_id: "tu-1",
      is_error: true,
      task_id: taskId,
    });

    // Denial row — exact shape the plugin reducer's replayToMessages
    // consumes (snake_case wire fields). Mirror reducer-denial.test.ts.
    const denial = entries[3];
    expect(denial).toMatchObject({
      role: "denial",
      tool_call_id: "tu-1",
      reason: "scope_violation",
      attempted_path: "journal/forbidden.md",
      agent: "maya",
      message: "Write denied: maya is not allowed to write journal/forbidden.md.",
      task_id: taskId,
    });
  });

  test("walk() preserves denial row across UPSERT (orchestrator may re-append during a turn)", () => {
    const { contextId, taskId, runId } = seed(db);
    const repo = makeMessagesRepo(db);

    // First append: just text + tool_use (mid-turn snapshot).
    repo.appendMessage(taskId, contextId, runId, "ROLE_AGENT", [
      { text: "starting" } as Part,
      {
        data: {
          kind: "tool_use",
          tool_call_id: "tu-2",
          tool_name: "vault.create",
          input: { path: "secret.md" },
        },
      },
    ]);

    // Final append (UPSERT): full parts list including denial.
    repo.appendMessage(taskId, contextId, runId, "ROLE_AGENT", [
      { text: "tried it" } as Part,
      {
        data: {
          kind: "tool_use",
          tool_call_id: "tu-2",
          tool_name: "vault.create",
          input: { path: "secret.md" },
        },
      },
      {
        data: {
          kind: "tool_result",
          tool_call_id: "tu-2",
          output: "SCOPE_DENIED: secret.md not in write_scope for agent maya",
          is_error: true,
        },
      },
      {
        data: {
          kind: "denial",
          toolCallId: "tu-2",
          reason: "scope_violation",
          attemptedPath: "secret.md",
          agent: "maya",
          message: "Write denied: maya is not allowed to write secret.md.",
        },
      },
    ]);

    const entries = repo.walk(contextId);
    // Single ROLE_AGENT message row (UPSERT on context_id+run_id) → 4 entries.
    expect(entries.length).toBe(4);
    expect(entries[0]).toMatchObject({ role: "assistant", content: "tried it" });
    const denial = entries.find((e) => (e as { role: string }).role === "denial");
    expect(denial).toMatchObject({
      role: "denial",
      tool_call_id: "tu-2",
      attempted_path: "secret.md",
      agent: "maya",
    });
  });

  test("walk() omits denial row when DataPart denial is absent (no false positives)", () => {
    const { contextId, taskId, runId } = seed(db);
    const repo = makeMessagesRepo(db);

    repo.appendMessage(taskId, contextId, runId, "ROLE_AGENT", [
      { text: "ok" } as Part,
      {
        data: {
          kind: "tool_use",
          tool_call_id: "tu-3",
          tool_name: "vault.read",
          input: { path: "ok.md" },
        },
      },
      {
        data: {
          kind: "tool_result",
          tool_call_id: "tu-3",
          output: "contents",
          is_error: false,
        },
      },
    ]);

    const entries = repo.walk(contextId);
    expect(entries.some((e) => (e as { role: string }).role === "denial")).toBe(false);
  });
});
