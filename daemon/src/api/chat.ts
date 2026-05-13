// HTTP routes for a single chat (VOS-79 Task 3 scaffold).
//
// T3 ships:
//   - GET /chat/:id              → returns full chat row, or 404 {error:"not_found"}
//
// T4 adds:
//   - GET /chat/:id/messages     → sessionReplay walk over CC's JSONL DAG
// T9 will add:
//   - POST /chat/:id/message     → user-send entrypoint
//
// Kept as a separate router from chats.ts so T4/T9 can extend without
// touching the list/create surface.

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeChatRepo } from "../chat/repo.ts";
import {
  makeSessionReplay,
  type ReplayOpts,
} from "../chat/session-replay.ts";

export interface ChatApiOpts {
  // Optional override for session-replay (test seam: projectsRoot, cwd, encodeCwd).
  replay?: ReplayOpts;
}

export function chatApi(db: Database, opts: ChatApiOpts = {}): Hono {
  const repo = makeChatRepo(db);
  const replay = makeSessionReplay(db, opts.replay);
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

  return app;
}
