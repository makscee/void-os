// VOS-88 T8: POST /chat/:chat_id/answer Hono route.
//
// User-facing endpoint that completes an open ask_user question. The URL
// parameter `:chat_id` is the daemon's context id (post-0007 the user-facing
// "chat" concept maps to a contexts row). The route:
//   1. Validates the body (tool_use_id + answer, both required).
//   2. Resolves the open task for the context via `openTaskFor`.
//   3. In a single SQLite transaction: CAS-clears the pending question
//      (clearTaskPending) and appends a ROLE_USER tool_result message.
//   4. On success: emits task.state_changed (WORKING) + message.appended on
//      the internal EventBus, broadcasts `chat.tool_result` on the WS bus
//      so the plugin reducer can clear `pendingAskUser` inline (VOS-90 T8),
//      then resolves the PendingRegistry slot so the awaiting MCP tool
//      handler returns the answer to the agent.
//
// Status codes:
//   200 — answer accepted, task flipped back to WORKING.
//   400 — invalid body (missing/empty fields).
//   404 — chat (context) does not exist.
//   409 — no matching pending question (mismatched tool_use_id OR task in
//         WORKING state without an open question).
//
// Reconciliations vs plan §T8 Step 3:
//   - The plan reads `task_id` + `context_id` from `chats`. Post-0007 there
//     is no `chats` table; instead the route checks `contexts` existence,
//     then resolves the open task via `openTaskFor`. This keeps the route
//     idempotent w.r.t. the renamed schema.
//   - Bus emit envelope uses `DaemonEvent` shape (`type` + `payload`) —
//     mirrors the existing `runAskUser` handler emit pattern. No `as any`.
//   - VOS-90 T8: the WS broadcast is an OPTIONAL dep so existing test fixtures
//     that only pass `bus` keep compiling. When wired in production (app.ts),
//     the `emit` callable is the same `broadcast()` shim used by orchestrator.

import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { EventBus } from "../events";
import type { PendingRegistry } from "../adapters/mcp/pending-questions";
import { openTaskFor } from "../chat/repo";
import {
  appendToolResultMessage,
  clearTaskPending,
} from "../chat/ask-user-repo";

const AnswerBody = z.object({
  tool_use_id: z.string().min(1),
  answer: z.string().min(1).max(4000),
});

export interface AnswerDeps {
  db: Database;
  bus: EventBus;
  pending: PendingRegistry;
  // Optional WS broadcast shim. Production wiring (app.ts) passes the
  // module-level `broadcast` function; tests may omit it (the route then
  // skips the WS frame — only the in-process bus events are surfaced).
  emit?: (type: string, payload: Record<string, unknown>) => void;
}

export function mountAnswerRoute(app: Hono, deps: AnswerDeps): void {
  app.post("/chat/:chat_id/answer", async (c) => {
    let body: z.infer<typeof AnswerBody>;
    try {
      body = AnswerBody.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }

    const chatId = c.req.param("chat_id");
    const ctxRow = deps.db
      .query("SELECT id FROM contexts WHERE id = ?")
      .get(chatId) as { id: string } | null;
    if (!ctxRow) return c.json({ error: "chat_not_found" }, 404);

    // Resolve the open (parent_task_id IS NULL) task for this context.
    let taskId: string;
    try {
      taskId = openTaskFor(deps.db, chatId);
    } catch {
      // No open task means there is nothing for the user to answer to.
      return c.json({ error: "no_matching_pending_question" }, 409);
    }

    // Active run (if any) — links the tool_result message to the run that
    // emitted the tool_use. Nullable per messages.run_id schema.
    const run = deps.db
      .query(
        "SELECT id FROM runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      )
      .get(taskId) as { id: string } | null;
    const runId = run?.id ?? null;

    let messageId: number | null = null;
    try {
      const tx = deps.db.transaction(() => {
        const cleared = clearTaskPending(deps.db, taskId, body.tool_use_id);
        if (!cleared) throw new Error("PENDING_MISMATCH");
        messageId = appendToolResultMessage(deps.db, {
          taskId,
          contextId: chatId,
          runId,
          toolUseId: body.tool_use_id,
          answer: body.answer,
        });
      });
      tx();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "PENDING_MISMATCH") {
        return c.json({ error: "no_matching_pending_question" }, 409);
      }
      throw err;
    }

    deps.bus.emit({
      type: "task.state_changed",
      chatId,
      payload: { taskId, state: "TASK_STATE_WORKING" },
    });
    deps.bus.emit({
      type: "message.appended",
      chatId,
      payload: { taskId, messageId },
    });

    // VOS-90 T8: broadcast `chat.tool_result` on the WS bus so the plugin
    // reducer's `chat.tool_result` case clears `pendingAskUser` + the live
    // tool entry's pending flag inline. Without this frame the plugin must
    // refetch /chat/:id/messages, opening race windows that flake the e2e
    // ("button still visible after answer", "banner not cleared", etc.).
    // Frame shape mirrors orchestrator.ts:335 emit so plugin/src/chat/reducer.ts
    // case "chat.tool_result" (line 654) reads `tool_call_id`, `output`,
    // `is_error` off the top-level envelope.
    deps.emit?.("chat.tool_result", {
      chat_id: chatId,
      run_id: runId,
      tool_call_id: body.tool_use_id,
      output: body.answer,
      is_error: false,
    });

    deps.pending.resolve(body.tool_use_id, body.answer);

    return c.json({ ok: true });
  });
}
