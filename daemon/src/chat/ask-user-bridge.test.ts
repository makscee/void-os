import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createEventBus } from "../events/index.ts";
import { createAskUserBridge, type AskUserBridge } from "./ask-user-bridge.ts";

const MIGRATIONS = join(import.meta.dir, "../adapters/sqlite/migrations");

function migrate(db: Database) {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
}

function seedContextAndTask(db: Database) {
  const contextId = "ctx-1";
  const taskId = "task-1";
  // Schema (post-mig-0007 contexts, post-mig-0010 tasks): see existing seed
  // pattern in providers/fake/__tests__/ask-user.test.ts. The plan's literal
  // seed referenced stale columns (agent_id, separate agents row).
  db.exec(
    `INSERT INTO contexts (id, title, created_at) VALUES ('${contextId}', NULL, 1)`,
  );
  db.exec(
    `INSERT INTO tasks (id, context_id, state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at) VALUES ('${taskId}', '${contextId}', 'TASK_STATE_WORKING', 0, 0, 0, '{}', 1, 1)`,
  );
  return { contextId, taskId };
}

describe("AskUserBridge", () => {
  let db: Database;
  let bus: ReturnType<typeof createEventBus>;
  let bridge: AskUserBridge;
  let emitted: Array<{ type: string; payload: unknown }>;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    bus = createEventBus({ db });
    emitted = [];
    bus.subscribe("task.state_changed", (e) => emitted.push({ type: e.type, payload: e.payload }));
    bus.subscribe("message.appended", (e) => emitted.push({ type: e.type, payload: e.payload }));
    bridge = createAskUserBridge({ db, bus });
  });

  it("open → resolve: returns answer, task back to WORKING, bus events emitted", async () => {
    const { contextId, taskId } = seedContextAndTask(db);
    const toolUseId = "tu-1";

    const opened = bridge.open({
      taskId, contextId, runId: null, toolUseId,
      question: "yes or no?", options: ["yes", "no"],
    });

    // Task flipped on open
    const afterOpen = db.query("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string };
    expect(afterOpen.state).toBe("TASK_STATE_INPUT_REQUIRED");

    // Resolve from HTTP side
    const res = await bridge.resolve({ taskId, toolUseId, answer: "yes" });
    expect(res).toEqual({ ok: true });

    const settled = await opened;
    expect(settled).toEqual({ answer: "yes" });

    const afterResolve = db.query("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string };
    expect(afterResolve.state).toBe("TASK_STATE_WORKING");

    // Bus: state INPUT_REQUIRED, message.appended (tool_use), state WORKING, message.appended (tool_result)
    const types = emitted.map((e) => `${e.type}`);
    expect(types).toContain("task.state_changed");
    expect(types).toContain("message.appended");
    expect(types.filter((t) => t === "task.state_changed").length).toBe(2);
    expect(types.filter((t) => t === "message.appended").length).toBe(2);
  });

  it("open → cancel('terminal'): open() resolves { canceled: true }, task back to WORKING", async () => {
    const { contextId, taskId } = seedContextAndTask(db);
    const toolUseId = "tu-c1";
    const opened = bridge.open({ taskId, contextId, runId: null, toolUseId, question: "?", options: undefined });

    await bridge.cancel({ taskId, toolUseId, reason: "terminal" });

    const settled = await opened;
    expect(settled).toEqual({ canceled: true });

    const row = db.query("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string };
    expect(row.state).toBe("TASK_STATE_WORKING");
  });

  it("open → cancel('canceled'): same shape, user-canceled path", async () => {
    const { contextId, taskId } = seedContextAndTask(db);
    const toolUseId = "tu-c2";
    const opened = bridge.open({ taskId, contextId, runId: null, toolUseId, question: "?", options: undefined });

    await bridge.cancel({ taskId, toolUseId, reason: "canceled" });

    const settled = await opened;
    expect(settled).toEqual({ canceled: true });
  });

  it("open → timeout: deadline fires, open() resolves { timeout: true }, task back to WORKING", async () => {
    const fastBridge = createAskUserBridge({ db, bus, deadlineMs: 10 });
    const { contextId, taskId } = seedContextAndTask(db);
    const toolUseId = "tu-t1";
    const opened = fastBridge.open({ taskId, contextId, runId: null, toolUseId, question: "?", options: undefined });

    const settled = await opened;
    expect(settled).toEqual({ timeout: true });

    const row = db.query("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string };
    expect(row.state).toBe("TASK_STATE_WORKING");
  });

  it("resolve(unknown toolUseId) → { ok: false, reason: 'unknown' }", async () => {
    const { taskId } = seedContextAndTask(db);
    const res = await bridge.resolve({ taskId, toolUseId: "never-opened", answer: "x" });
    expect(res).toEqual({ ok: false, reason: "unknown" });
  });

  it("resolve after cancel → { ok: false, reason: 'unknown' } (pending entry already gone)", async () => {
    const { contextId, taskId } = seedContextAndTask(db);
    const toolUseId = "tu-rac";
    const opened = bridge.open({ taskId, contextId, runId: null, toolUseId, question: "?", options: undefined });
    await bridge.cancel({ taskId, toolUseId, reason: "canceled" });
    await opened;
    const res = await bridge.resolve({ taskId, toolUseId, answer: "x" });
    expect(res).toEqual({ ok: false, reason: "unknown" });
  });

  it("double resolve: second call → { ok: false, reason: 'unknown' }, no double bus emission", async () => {
    const { contextId, taskId } = seedContextAndTask(db);
    const toolUseId = "tu-dr";
    const opened = bridge.open({ taskId, contextId, runId: null, toolUseId, question: "?", options: undefined });
    const r1 = await bridge.resolve({ taskId, toolUseId, answer: "first" });
    expect(r1).toEqual({ ok: true });
    await opened;
    const before = emitted.length;
    const r2 = await bridge.resolve({ taskId, toolUseId, answer: "second" });
    expect(r2).toEqual({ ok: false, reason: "unknown" });
    expect(emitted.length).toBe(before);
  });
});
