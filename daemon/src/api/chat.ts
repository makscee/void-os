// HTTP routes for a single chat (VOS-79 Task 3 scaffold).
//
// T3 ships:
//   - GET /chat/:id              → returns full chat row, or 404 {error:"not_found"}
//
// T4 will add:
//   - GET /chat/:id/messages     → sessionReplay walk
// T9 will add:
//   - POST /chat/:id/message     → user-send entrypoint
//
// Kept as a separate router from chats.ts so T4/T9 can extend without
// touching the list/create surface.

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeChatRepo } from "../chat/repo.ts";

export function chatApi(db: Database): Hono {
  const repo = makeChatRepo(db);
  const app = new Hono();

  app.get("/chat/:id", (c) => {
    const row = repo.get(c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(row);
  });

  return app;
}
