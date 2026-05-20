// VOS-88 T8 (revised VOS-100 T6): integration test for POST /chat/:chat_id/answer Hono route.
//
// VOS-100 T6: rewritten to drive the route via AskUserBridge instead of the
// deleted PendingRegistry. Each test calls `bridge.open(...)` to park an
// awaiter (mirroring what the production ask_user MCP handler does), then
// POSTs to /answer and asserts both the HTTP-observable response shape AND
// that the parked awaiter resolved with the right OpenResult shape.
//
// Reconciliations preserved from the original (still relevant):
//   - `runMigrationsFromDir` not re-exported from .../sqlite/index.ts —
//     inlined the same way other ask-user tests do.
//   - Post-0007 there is no `chats` table — renamed to `contexts` and the
//     URL `:chat_id` IS the context id. The answer route resolves task_id
//     via `openTaskFor(db, contextId)`. Seed mirrors e2e.int.test.ts.
//   - parts_text only concatenates TextParts; tool_result is a DataPart, so
//     the answer lives in `parts` JSON, not parts_text.

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Hono } from "hono";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { createEventBus } from "../../src/events";
import { createAskUserBridge } from "../../src/chat/ask-user-bridge";
import { mountAnswerRoute } from "../../src/api/answer";

const MIGRATIONS = join(import.meta.dir, "../../src/adapters/sqlite/migrations");

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS);
  db.run(
    "INSERT INTO contexts (id, title, created_at) VALUES ('ctx', NULL, 0)",
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
  const bridge = createAskUserBridge({ db, bus });
  // VOS-90 T8: capture broadcasts so tests can assert chat.tool_result.
  const wsFrames: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const emit = (type: string, payload: Record<string, unknown>) => {
    wsFrames.push({ type, payload });
  };
  const app = new Hono();
  mountAnswerRoute(app, { db, bridge, emit });
  return { db, bus, bridge, app, wsFrames };
}

describe("POST /chat/:chat_id/answer", () => {
  it("happy path: writes tool_result, flips state, resolves bridge awaiter", async () => {
    const { db, bridge, app } = fixture();
    const opened = bridge.open({
      taskId: "t",
      contextId: "ctx",
      runId: "r",
      toolUseId: "tu-1",
      question: "ok?",
      options: ["yes", "no"],
    });

    const res = await app.request("/chat/ctx/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-1", answer: "yes" }),
    });
    expect(res.status).toBe(200);

    const settled = await opened;
    expect(settled).toEqual({ answer: "yes" });

    const row = db.query("SELECT state FROM tasks WHERE id='t'").get() as {
      state: string;
    };
    expect(row.state).toBe("TASK_STATE_WORKING");
    // Reconcile: plan asserted parts_text="yes", but messages-repo only
    // populates parts_text from TextParts. Tool_result is encoded as a
    // DataPart, so the answer lives in `parts` JSON (not parts_text).
    const msg = db
      .query(
        "SELECT role, parts FROM messages WHERE task_id='t' ORDER BY ord DESC LIMIT 1",
      )
      .get() as { role: string; parts: string };
    expect(msg.role).toBe("ROLE_USER");
    const parts = JSON.parse(msg.parts) as Array<{
      data?: { kind?: string; output?: string; tool_call_id?: string };
    }>;
    expect(parts[0]?.data?.kind).toBe("tool_result");
    expect(parts[0]?.data?.output).toBe("yes");
    expect(parts[0]?.data?.tool_call_id).toBe("tu-1");
  });

  it("409 on mismatched tool_use_id", async () => {
    const { db, bridge, app } = fixture();
    // Open with tu-1; POST with tu-OTHER must not satisfy it.
    const opened = bridge.open({
      taskId: "t",
      contextId: "ctx",
      runId: "r",
      toolUseId: "tu-1",
      question: "ok?",
    });
    // Suppress unhandled (the awaiter parks until the fixture is torn down).
    void opened.catch(() => {});
    const res = await app.request("/chat/ctx/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-OTHER", answer: "yes" }),
    });
    expect(res.status).toBe(409);
    const row = db.query("SELECT state FROM tasks WHERE id='t'").get() as {
      state: string;
    };
    // Task still parked on the original open.
    expect(row.state).toBe("TASK_STATE_INPUT_REQUIRED");
  });

  it("409 when task is WORKING (no open question)", async () => {
    const { app } = fixture();
    const res = await app.request("/chat/ctx/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-1", answer: "yes" }),
    });
    expect(res.status).toBe(409);
  });

  it("404 when chat does not exist", async () => {
    const { app } = fixture();
    const res = await app.request("/chat/nope/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-1", answer: "yes" }),
    });
    expect(res.status).toBe(404);
  });

  it("400 on missing fields", async () => {
    const { app } = fixture();
    const res = await app.request("/chat/ctx/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-1" }),
    });
    expect(res.status).toBe(400);
  });

  // VOS-90 T8: WS `chat.tool_result` is what lets the plugin reducer clear
  // pendingAskUser + the tool's pending flag inline (no refetch). Without
  // this frame the e2e flakes on "banner not cleared" / "button still
  // visible". Frame shape mirrors orchestrator.ts:335 so the existing
  // plugin reducer case "chat.tool_result" applies unchanged.
  it("publishes chat.tool_result WS frame on success", async () => {
    const { bridge, app, wsFrames } = fixture();
    const opened = bridge.open({
      taskId: "t",
      contextId: "ctx",
      runId: "r",
      toolUseId: "tu-99",
      question: "ok?",
    });
    const res = await app.request("/chat/ctx/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-99", answer: "yes" }),
    });
    expect(res.status).toBe(200);
    await opened;
    const frame = wsFrames.find((f) => f.type === "chat.tool_result");
    expect(frame).toBeDefined();
    expect(frame!.payload).toEqual({
      chat_id: "ctx",
      run_id: "r",
      tool_call_id: "tu-99",
      output: "yes",
      is_error: false,
    });
  });

  it("does NOT publish chat.tool_result on 409", async () => {
    const { app, wsFrames } = fixture();
    const res = await app.request("/chat/ctx/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: "tu-1", answer: "yes" }),
    });
    expect(res.status).toBe(409);
    expect(wsFrames.find((f) => f.type === "chat.tool_result")).toBeUndefined();
  });
});
