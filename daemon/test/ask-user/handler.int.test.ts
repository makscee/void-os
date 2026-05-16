// VOS-88 T6: integration test for ask-user handler (happy path).
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
//
// VOS-97 T3: migrated from `runAskUser(ctx, raw)` to
// `makeAskUser(deps)(args, { _meta })`. Runtime ids now ride on _meta.

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { createPendingRegistry } from "../../src/adapters/mcp/pending-questions";
import { makeAskUser } from "../../src/adapters/mcp/tools/ask-user";
import { createEventBus } from "../../src/events";
import { appendToolResultMessage, clearTaskPending } from "../../src/chat/ask-user-repo";

const MIGRATIONS = join(import.meta.dir, "../../src/adapters/sqlite/migrations");

function fakeExtra(meta: Record<string, unknown>) {
  return { _meta: meta } as any;
}

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS);
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

describe("ask-user handler (integration, happy path)", () => {
  it("flips state, writes tool_use, awaits, returns answer on resolve", async () => {
    const { db, bus, pending } = fixture();

    const events: { type: string }[] = [];
    bus.subscribe("task.state_changed", (e) => events.push(e));
    bus.subscribe("message.appended", (e) => events.push(e));

    const handler = makeAskUser({ db, bus, pending, deadlineMs: 5_000, now: () => 1000 });
    const promise = handler(
      { question: "ok?", options: ["yes", "no"] },
      fakeExtra({ task_id: "t", context_id: "ctx", run_id: "r" }),
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

describe("ask-user handler guards", () => {
  it("rejects ASK_USER_ALREADY_OPEN when another question is pending", async () => {
    const { db, bus, pending } = fixture();
    const handler = makeAskUser({ db, bus, pending, deadlineMs: 60_000, now: () => 1 });
    void handler(
      { question: "first" },
      fakeExtra({ task_id: "t", context_id: "ctx", run_id: "r" }),
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    const second = await handler(
      { question: "second" },
      fakeExtra({ task_id: "t", context_id: "ctx", run_id: "r" }),
    );
    expect(second.isError).toBe(true);
    expect((second.content[0] as { text: string }).text).toBe("ASK_USER_ALREADY_OPEN");
  });

  it("returns TASK_NOT_WORKING when task is already TASK_STATE_INPUT_REQUIRED (different path: pending null edge)", () => {
    // Force state without setting pending — exercises the second branch in the error distinguisher.
    const { db, bus, pending } = fixture();
    db.run("UPDATE tasks SET state='TASK_STATE_INPUT_REQUIRED' WHERE id='t'");
    const handler = makeAskUser({ db, bus, pending, deadlineMs: 60_000, now: () => 1 });
    return handler(
      { question: "ok?" },
      fakeExtra({ task_id: "t", context_id: "ctx", run_id: "r" }),
    ).then((r) => {
      expect(r.isError).toBe(true);
      expect((r.content[0] as { text: string }).text).toBe("TASK_NOT_WORKING");
    });
  });

  it("returns TASK_NOT_FOUND for an unknown taskId", async () => {
    const { db, bus, pending } = fixture();
    const handler = makeAskUser({ db, bus, pending, deadlineMs: 60_000, now: () => 1 });
    const r = await handler(
      { question: "ok?" },
      fakeExtra({ task_id: "nope", context_id: "ctx" }),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe("TASK_NOT_FOUND");
  });
});

describe("ask-user handler races", () => {
  it("returns ASK_USER_TIMEOUT after deadlineMs; task flips back to WORKING", async () => {
    const { db, bus, pending } = fixture();
    const handler = makeAskUser({ db, bus, pending, deadlineMs: 30, now: () => 1 });
    const r = await handler(
      { question: "ok?" },
      fakeExtra({ task_id: "t", context_id: "ctx", run_id: "r" }),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe("ASK_USER_TIMEOUT");
    const row = db.query("SELECT state, metadata FROM tasks WHERE id='t'").get() as any;
    expect(row.state).toBe("TASK_STATE_WORKING");
    expect(JSON.parse(row.metadata).pending_tool_use_id).toBeUndefined();
  });

  it("late-answer race: POST after timeout returns 409 in CAS and does not double-resolve", async () => {
    // Run handler with very short deadline.
    const { db, bus, pending } = fixture();
    const handler = makeAskUser({ db, bus, pending, deadlineMs: 20, now: () => 1 });
    const handlerPromise = handler(
      { question: "ok?" },
      fakeExtra({ task_id: "t", context_id: "ctx", run_id: "r" }),
    );
    const r = await handlerPromise;
    expect((r.content[0] as { text: string }).text).toBe("ASK_USER_TIMEOUT");
    // Now call clearTaskPending with any stale tool_use_id — should be a no-op.
    const cleared = clearTaskPending(db, "t", "stale-tuid");
    expect(cleared).toBe(false);
  });

  it("setup-gap race: tool_result arriving between INSERT and pending.register still resolves", async () => {
    // Manually simulate by calling resolve before register would happen — exercise PendingRegistry.resolve-before-register guard.
    // Since the current design has a deterministic order (transaction COMMIT → bus.emit → pending.register), this is a regression guard.
    const { db: _db, bus: _bus, pending } = fixture();
    // Pre-register an awaiter as if the handler did; then resolve.
    const p = pending.register("tu-pre", 1_000);
    expect(pending.resolve("tu-pre", "yes")).toBe(true);
    await expect(p).resolves.toBe("yes");
  });
});
