// HTTP routes for a single chat (VOS-79 Tasks 3, 4, 8).
//
// Routes:
//   - GET  /chat/:id            → full chat row, or 404 {error:"not_found"}
//   - GET  /chat/:id/messages   → sessionReplay walk over CC's JSONL DAG
//   - POST /chat/:id/message    → user-send entrypoint; dispatches via orchestrator
//
// The orchestrator is injected (optional) so tests can supply a mock and
// production wires the real one in `buildApp`. When absent, the POST route
// short-circuits to 500 — production wiring is responsible for providing it.

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeChatRepo } from "../chat/repo.ts";
import {
  makeSessionReplay,
  type ReplayOpts,
} from "../chat/session-replay.ts";
import type { Orchestrator } from "../chat/orchestrator.ts";

export interface ChatApiOpts {
  // Optional override for session-replay (test seam: projectsRoot, cwd, encodeCwd).
  replay?: ReplayOpts;
  // Optional orchestrator. When omitted, POST /chat/:id/message returns 500.
  orchestrator?: Orchestrator;
}

export function chatApi(db: Database, opts: ChatApiOpts = {}): Hono {
  const repo = makeChatRepo(db);
  const replay = makeSessionReplay(db, opts.replay);
  const orchestrator = opts.orchestrator;
  const app = new Hono();

  app.get("/chat/:id", (c) => {
    const row = repo.get(c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(row);
  });

  // T4: replay the visible turn order from CC's single JSONL per session.
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

  return app;
}
