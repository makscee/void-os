// VOS-88 T8: POST /chat/:chat_id/answer Hono route.
//
// User-facing endpoint that completes an open ask_user question. The URL
// parameter `:chat_id` is the daemon's context id (post-0007 the user-facing
// "chat" concept maps to a contexts row).
//
// VOS-100 T5: the transactional CAS-clear + tool_result append + bus emissions
// + awaiter resolution all live in AskUserBridge.resolve(). This route only
// validates the request, resolves the open task for the context, delegates to
// the bridge, and (on success) broadcasts the WS `chat.tool_result` frame so
// the plugin reducer can clear pendingAskUser inline (VOS-90 T8).
//
// Status codes:
//   200 — answer accepted, task flipped back to WORKING.
//   400 — invalid body (missing/empty fields).
//   404 — chat (context) does not exist.
//   409 — no matching pending question (no open task, mismatched tool_use_id,
//         or task not actually pending on that id).

import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { AskUserBridge } from "../chat/ask-user-bridge.ts";
import { openTaskFor } from "../chat/repo";

const AnswerBody = z.object({
  tool_use_id: z.string().min(1),
  answer: z.string().min(1).max(4000),
});

export interface AnswerDeps {
  db: Database;
  bridge: AskUserBridge;
  // Optional WS broadcast shim. Production wiring (app.ts) passes the
  // module-level `broadcast` function; tests may omit it (the route then
  // skips the WS frame — only the in-process bus events emitted by the
  // bridge are surfaced).
  emit?: (event: string, payload: Record<string, unknown>) => void;
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

    let taskId: string;
    try {
      taskId = openTaskFor(deps.db, chatId);
    } catch {
      return c.json({ error: "no_matching_pending_question" }, 409);
    }

    // Resolve via bridge — handles CAS, message append, state event, message
    // event, and awaiter resolution atomically.
    const res = await deps.bridge.resolve({
      taskId,
      toolUseId: body.tool_use_id,
      answer: body.answer,
    });
    if (!res.ok) return c.json({ error: "no_matching_pending_question" }, 409);

    // WS broadcast (kept here — outside bridge scope). VOS-90 T8: the
    // plugin reducer's `chat.tool_result` case clears pendingAskUser + the
    // live tool entry's pending flag inline. Without this frame the plugin
    // must refetch /chat/:id/messages, opening race windows that flake the
    // e2e ("button still visible after answer", "banner not cleared").
    const runRow = deps.db
      .query(
        "SELECT id FROM runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      )
      .get(taskId) as { id: string } | null;
    deps.emit?.("chat.tool_result", {
      chat_id: chatId,
      run_id: runRow?.id ?? null,
      tool_call_id: body.tool_use_id,
      output: body.answer,
      is_error: false,
    });

    return c.json({ ok: true });
  });
}
