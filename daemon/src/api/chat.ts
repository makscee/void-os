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
  // VOS-118: optional bus. When provided, POST /chat/:id/message returns
  // early (with run_id) as soon as run.start fires, instead of awaiting
  // the full dispatch lifecycle. Without a bus, falls back to the legacy
  // synchronous wait — preserves behaviour for tests that wire chatApi
  // without an event bus.
  bus?: EventBus;
}

export function chatApi(db: Database, opts: ChatApiOpts = {}): Hono {
  const repo = makeChatRepo(db);
  const replay = makeSessionReplay(db);
  const orchestrator = opts.orchestrator;
  const bus = opts.bus;
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
    // VOS-118: /message returns AFTER dispatch completes (status: done/error/cancelled).
    // For runs that pause on ask_user (bridge.open blocks waiting for /answer),
    // dispatch blocks indefinitely — which blocks the client. The CLI's pattern
    // of "open SSE stream, then POST /message, then iterate SSE" cannot make
    // progress past send() in that case, so the ask_user SSE frame is never
    // consumed. Resolve by racing dispatch against a short "first event"
    // sentinel: as soon as the orchestrator emits any frame (run.start) the
    // POST returns with {run_id, status: "running"} — the SSE stream is the
    // authoritative source of further events. Dispatch continues in the
    // background; its terminal status reaches clients via the SSE run_end
    // frame and the persistent runs row.
    //
    // Compatibility: legacy callers that consumed the dispatch result
    // (orchestrator-style {run_id, status: "done"|"error"|"cancelled"})
    // get {run_id, status: "running"} early instead. The run_id is the same
    // value (orchestrator mints it in the acquire-lock txn before any awaits,
    // so it is observable on the bus by the time we race). Callers that
    // need terminal status now read it from SSE or GET /chat/:id.
    if (!bus) {
      // Legacy path (no bus injected) — preserve original synchronous wait.
      // Used by unit tests that construct chatApi without an event bus.
      try {
        const result = await orchestrator.dispatch(id, body.text);
        return c.json(result);
      } catch (err: unknown) {
        const e = err as { status?: number; current_run_id?: string; message?: string };
        if (e?.status === 409)
          return c.json({ error: "run_in_progress", current_run_id: e.current_run_id }, 409);
        if (e?.status === 404) return c.json({ error: "not_found" }, 404);
        return c.json({ error: String(e?.message ?? err) }, 500);
      }
    }
    try {
      // Race the dispatch promise against a short timeout: if it finishes
      // immediately (sync error like 409), keep the existing JSON shape;
      // otherwise return early. Subscribe to run.start to learn the run_id
      // before returning — bus.emit is synchronous so the subscriber will
      // fire inside the same microtask the orchestrator runs.
      let runId: string | null = null;
      const unsubscribe = bus.subscribe("run.start", (ev) => {
        if (ev.chatId !== id && (ev.payload as { chat_id?: string })?.chat_id !== id) return;
        const rid = (ev.payload as { run_id?: string })?.run_id;
        if (typeof rid === "string") runId = rid;
      });
      const dispatchPromise = orchestrator.dispatch(id, body.text)
        .catch((err) => ({ __error: err as unknown }));
      // Wait either for dispatch to finish OR for run.start to land.
      const settled = await Promise.race([
        dispatchPromise,
        new Promise<null>((resolve) => {
          // Poll runId — set synchronously by the subscriber as soon as
          // run.start fires. 5ms granularity is plenty given run.start
          // happens within the same tick as the lock-acquire txn.
          const t = setInterval(() => {
            if (runId !== null) { clearInterval(t); resolve(null); }
          }, 5);
          // Safety net: don't block forever if neither fires (would only
          // happen on a stuck event loop or a bus that lost the event).
          setTimeout(() => { clearInterval(t); resolve(null); }, 2000);
        }),
      ]);
      unsubscribe();
      if (settled && typeof settled === "object" && "__error" in (settled as object)) {
        // Dispatch threw synchronously (or before run.start landed).
        const err = (settled as { __error: unknown }).__error;
        throw err;
      }
      if (settled && typeof settled === "object" && "run_id" in (settled as object)) {
        // Dispatch completed before/at the same time as run.start fired —
        // surface the terminal status as before.
        return c.json(settled);
      }
      // Early-return path: dispatch is still running. Background-handle any
      // error so the unhandled-rejection guard doesn't trip.
      dispatchPromise.then((r) => {
        if (r && typeof r === "object" && "__error" in (r as object)) {
          console.error("[chat:dispatch:background]", (r as { __error: unknown }).__error);
        }
      });
      return c.json({ run_id: runId, status: "running" });
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
