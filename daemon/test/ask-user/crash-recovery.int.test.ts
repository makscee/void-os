// VOS-88 T11: crash-recovery integration test.
//
// Scenario: daemon was killed while a task was in TASK_STATE_INPUT_REQUIRED
// (tool_use row persisted, pending registry lost). On "restart" the registry
// is empty — no awaiter for the tool_use_id. The answer route must still:
//   - flip the task back to TASK_STATE_WORKING,
//   - write a tool_result row,
//   - emit task.state_changed so a subscriber (future orchestrator) can
//     dispatch a fresh agent run.
//
// Reconciliations vs plan §T11:
//   - `chats` table doesn't exist (renamed to `contexts` in 0007). `:chat_id`
//     IS the context id; answer route resolves task_id via openTaskFor.
//   - `runMigrationsFromDir` not re-exported from sqlite/index — inline it.
//   - `parts_text` only concatenates TextParts; tool_result is a DataPart, so
//     answer lives in `parts` JSON, not parts_text.
//   - Bus event shape is { type, chatId, payload: { taskId, state } } — not
//     the flat { state, task_id } the plan assumed.
//   - Seed mirrors T6/T8: contexts.agent_name + archived NOT NULL,
//     tasks.tokens_in/_out NOT NULL.

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { createEventBus } from "../../src/events";
import { createPendingRegistry } from "../../src/adapters/mcp/pending-questions";
import { mountAnswerRoute } from "../../src/api/answer";
import {
  setTaskInputRequired,
  appendToolUseMessage,
} from "../../src/chat/ask-user-repo";

const MIGRATIONS = join(import.meta.dir, "../../src/adapters/sqlite/migrations");

function runMigrations(db: Database) {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    db.exec(sql);
  }
}

describe("ask_user crash recovery", () => {
  it("orphaned INPUT_REQUIRED task: answer POST flips state and emits dispatch event", async () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);

    db.run(
      "INSERT INTO contexts (id, agent_name, title, created_at, updated_at, archived) VALUES ('ctx', 'maya', NULL, 0, 0, 0)",
    );
    db.run(
      "INSERT INTO tasks (id, context_id, state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at) " +
        "VALUES ('t', 'ctx', 'TASK_STATE_WORKING', 0, 0, 0, '{}', 0, 0)",
    );
    db.run(
      "INSERT INTO runs (id, chat_id, task_id, agent, kind, status, started_at) " +
        "VALUES ('r', 'ctx', 't', 'maya', 'chat', 'running', 0)",
    );

    // Simulate the pre-crash state: tool_use row persisted, task flipped to
    // INPUT_REQUIRED with the pending_tool_use_id pointer.
    appendToolUseMessage(db, {
      taskId: "t",
      contextId: "ctx",
      runId: null,
      toolUseId: "tu-1",
      question: "ok?",
      options: ["yes", "no"],
    });
    expect(setTaskInputRequired(db, "t", "tu-1", "ok?", ["yes", "no"])).toBe(
      true,
    );

    // "Restart": fresh bus, fresh pending registry. No awaiter for tu-1.
    const bus = createEventBus();
    const pending = createPendingRegistry();
    const dispatchedTaskIds: string[] = [];
    bus.subscribe("task.state_changed", (e) => {
      const ev = e as {
        payload?: { taskId?: string; state?: string };
      };
      if (ev.payload?.state === "TASK_STATE_WORKING" && ev.payload?.taskId) {
        dispatchedTaskIds.push(ev.payload.taskId);
      }
    });
    const app = new Hono();
    mountAnswerRoute(app, { db, bus, pending });

    const res = await app.request("/chat/ctx/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-1", answer: "yes" }),
    });
    expect(res.status).toBe(200);

    // pending.resolve was a no-op (registry empty after "restart") — fine, no throw.
    expect(pending.size()).toBe(0);

    // Bus event landed — this is the signal an orchestrator subscriber would
    // use to dispatch a fresh agent run after restart.
    expect(dispatchedTaskIds).toEqual(["t"]);

    // Final DB state: WORKING, pending cleared, tool_result row written.
    const row = db
      .query("SELECT state, metadata FROM tasks WHERE id='t'")
      .get() as { state: string; metadata: string };
    expect(row.state).toBe("TASK_STATE_WORKING");
    expect(JSON.parse(row.metadata).pending_tool_use_id).toBeUndefined();

    const lastMsg = db
      .query(
        "SELECT role, parts FROM messages WHERE task_id='t' ORDER BY ord DESC LIMIT 1",
      )
      .get() as { role: string; parts: string };
    expect(lastMsg.role).toBe("ROLE_USER");
    const parts = JSON.parse(lastMsg.parts) as Array<{
      data?: { kind?: string; output?: string; tool_call_id?: string };
    }>;
    expect(parts[0]?.data?.kind).toBe("tool_result");
    expect(parts[0]?.data?.output).toBe("yes");
    expect(parts[0]?.data?.tool_call_id).toBe("tu-1");
  });
});
