// VOS-88 T6: integration test for runAskUser handler (happy path).
//
// Reconciliations vs plan §T6:
//   - `runMigrationsFromDir` is exported from src/adapters/sqlite/migrations.ts
//     but NOT re-exported from .../sqlite/index.ts. We inline the migration
//     runner the same way T4's repo.test.ts does.
//   - Fixture seed mirrors T4's freshDb(): contexts.agent_name NOT NULL,
//     tasks.tokens_in/tokens_out NOT NULL, runs.chat_id/agent/kind/started_at
//     NOT NULL (per migrations 0001–0007).
//   - EventBus has NO typed event registry (see src/events/index.ts). The
//     plan's strings "task.state_changed" / "message.appended" are kept
//     verbatim — they're internal bus events; WS frame names live in
//     orchestrator.ts on a separate layer.

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPendingRegistry } from "../../src/adapters/mcp/pending-questions";
import { runAskUser } from "../../src/adapters/mcp/tools/ask-user";
import { createEventBus } from "../../src/events";
import { appendToolResultMessage, clearTaskPending } from "../../src/chat/ask-user-repo";

const MIGRATIONS = join(import.meta.dir, "../../src/adapters/sqlite/migrations");

function runMigrations(db: Database) {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    db.exec(sql);
  }
}

function fixture() {
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
  const bus = createEventBus();
  const pending = createPendingRegistry();
  return { db, bus, pending };
}

describe("runAskUser (integration, happy path)", () => {
  it("flips state, writes tool_use, awaits, returns answer on resolve", async () => {
    const { db, bus, pending } = fixture();

    const events: { type: string }[] = [];
    bus.subscribe("task.state_changed", (e) => events.push(e));
    bus.subscribe("message.appended", (e) => events.push(e));

    const promise = runAskUser(
      { db, bus, pending, taskId: "t", contextId: "ctx", runId: "r", deadlineMs: 5_000, now: () => 1000 },
      { question: "ok?", options: ["yes", "no"] },
    );

    // Allow microtasks to flush + state to flip.
    await new Promise((r) => setTimeout(r, 5));
    const row = db.query("SELECT state, metadata FROM tasks WHERE id='t'").get() as {
      state: string;
      metadata: string;
    };
    expect(row.state).toBe("TASK_STATE_INPUT_REQUIRED");
    const md = JSON.parse(row.metadata);
    expect(md.pending_tool_use_id).toBeDefined();
    const tuid = md.pending_tool_use_id as string;
    expect(events.some((e) => e.type === "task.state_changed")).toBe(true);
    expect(events.some((e) => e.type === "message.appended")).toBe(true);

    // Simulate the answer route: write tool_result, clear pending, resolve.
    appendToolResultMessage(db, { taskId: "t", contextId: "ctx", runId: "r", toolUseId: tuid, answer: "yes" });
    expect(clearTaskPending(db, "t", tuid)).toBe(true);
    expect(pending.resolve(tuid, "yes")).toBe(true);

    const result = await promise;
    expect(result).toEqual({ content: [{ type: "text", text: "yes" }] });
  });
});
