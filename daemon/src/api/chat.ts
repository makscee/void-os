// HTTP routes for a single chat (VOS-79 Tasks 3, 4, 8; VOS-80 S5 cancel).
//
// Routes:
//   - GET  /chat/:id            → full chat row, or 404 {error:"not_found"}
//   - GET  /chat/:id/messages   → sessionReplay walk over the messages table
//   - POST /chat/:id/message    → user-send entrypoint; dispatches via orchestrator
//   - POST /chat/:id/cancel     → interrupt the in-flight run for this chat
//
// The orchestrator is injected (optional) so tests can supply a mock and
// production wires the real one in `buildApp`. When absent, POST routes
// short-circuit to 500 — production wiring is responsible for providing it.
//
// VOS-91 T8: mountChatTaskStateFanout subscribes to the in-process bus and
// fans out `chat.task.state_changed` WS frames whenever a task changes state.

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeChatRepo } from "../chat/repo.ts";
import { makeSessionReplay } from "../chat/session-replay.ts";
import type { Orchestrator } from "../chat/orchestrator.ts";
import type { EventBus } from "../events/index.ts";

// ---------------------------------------------------------------------------
// VOS-91 T8: chat.task.state_changed fan-out
// ---------------------------------------------------------------------------

export type TaskStateChangedPayload = {
  chat_id: string;
  task_id: string;
  parent_task_id: string | null;
  state:
    | "SUBMITTED"
    | "WORKING"
    | "WAITING_ON_AGENT"
    | "INPUT_REQUIRED"
    | "COMPLETED"
    | "FAILED"
    | "CANCELED";
  error?: string;
};

export interface ChatTaskStateFanoutDeps {
  db: Database;
  bus: EventBus;
  broadcast: (
    chatId: string,
    frame: { type: "chat.task.state_changed"; payload: TaskStateChangedPayload },
  ) => void;
}

/**
 * Subscribe to `task.state_changed` events on the bus and fan-out a
 * `chat.task.state_changed` WS frame to the relevant chat's subscribers.
 *
 * Returns an unsubscribe function (pass to cleanup / server teardown).
 */
export function mountChatTaskStateFanout(
  deps: ChatTaskStateFanoutDeps,
): () => void {
  return deps.bus.subscribe("task.state_changed", (event) => {
    const p = (event.payload ?? {}) as { taskId?: string; state?: string };
    if (!p.taskId || !p.state) return;

    const row = deps.db
      .query(
        "SELECT context_id, parent_task_id, metadata FROM tasks WHERE id = ?",
      )
      .get(p.taskId) as
      | {
          context_id: string;
          parent_task_id: string | null;
          metadata: string | null;
        }
      | undefined;
    if (!row) return;

    const stripped = p.state.replace(/^TASK_STATE_/, "") as TaskStateChangedPayload["state"];
    const payload: TaskStateChangedPayload = {
      chat_id: row.context_id,
      task_id: p.taskId,
      parent_task_id: row.parent_task_id,
      state: stripped,
    };

    if (stripped === "FAILED" && row.metadata) {
      try {
        const meta = JSON.parse(row.metadata) as { errorMessage?: unknown };
        if (typeof meta.errorMessage === "string") payload.error = meta.errorMessage;
      } catch {
        /* ignore malformed metadata */
      }
    }

    deps.broadcast(row.context_id, {
      type: "chat.task.state_changed",
      payload,
    });
  });
}

// ---------------------------------------------------------------------------

export interface ChatApiOpts {
  // Optional orchestrator. When omitted, POST /chat/:id/message returns 500.
  orchestrator?: Orchestrator;
}

export function chatApi(db: Database, opts: ChatApiOpts = {}): Hono {
  const repo = makeChatRepo(db);
  const replay = makeSessionReplay(db);
  const orchestrator = opts.orchestrator;
  const app = new Hono();

  app.get("/chat/:id", (c) => {
    const row = repo.get(c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(row);
  });

  // T4: replay the visible turn order from the messages table.
  app.get("/chat/:id/messages", (c) => {
    const id = c.req.param("id");
    if (!repo.get(id)) return c.json({ error: "not_found" }, 404);
    return c.json(replay.walk(id));
  });

  // T8: user-send entrypoint. Body shape: {text: string}.
  // Status mapping:
  //   400 — missing/empty text or malformed JSON body
  //   404 — chat does not exist
  //   409 — another dispatch holds the per-chat lock; body echoes current_run_id
  //   500 — orchestrator unavailable, or unexpected internal error
  app.post("/chat/:id/message", async (c) => {
    if (!orchestrator) {
      return c.json({ error: "orchestrator_unavailable" }, 500);
    }
    const id = c.req.param("id");
    if (!repo.get(id)) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "text_required" }, 400);
    }
    try {
      const result = await orchestrator.dispatch(id, body.text);
      return c.json(result);
    } catch (err: unknown) {
      const e = err as {
        status?: number;
        current_run_id?: string;
        message?: string;
      };
      if (e?.status === 409) {
        return c.json(
          { error: "run_in_progress", current_run_id: e.current_run_id },
          409,
        );
      }
      if (e?.status === 404) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json({ error: String(e?.message ?? err) }, 500);
    }
  });

  // VOS-80 S5: interrupt the in-flight run for this chat.
  // Status mapping:
  //   200 — {run_id, status:"cancelled"} when an active run was cancelled
  //   404 — {error:"not_found"}            chat does not exist
  //   409 — {error:"no_active_run"}        no run in flight (idempotent: a
  //                                        second cancel after run end lands here)
  //   500 — orchestrator unavailable
  app.post("/chat/:id/cancel", async (c) => {
    if (!orchestrator) {
      return c.json({ error: "orchestrator_unavailable" }, 500);
    }
    const id = c.req.param("id");
    if (!repo.get(id)) return c.json({ error: "not_found" }, 404);
    const result = await orchestrator.cancel(id);
    if (!result.cancelled) {
      return c.json({ error: "no_active_run" }, 409);
    }
    return c.json({ run_id: result.run_id, status: "cancelled" });
  });

  return app;
}
