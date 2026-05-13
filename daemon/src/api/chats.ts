// HTTP routes for the chat registry (VOS-79 Task 3).
//
// - POST /chats { agent }          → create a chat, return {id, title, created_at}
// - GET  /chats                    → list chats, recent-first, with last_msg preview
//
// The router accepts a `Database` and constructs a `makeChatRepo(db)` once.
// Mounted in `daemon/src/app.ts` via `app.route("/", chatsApi(db))`.

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeChatRepo } from "../chat/repo.ts";

export function chatsApi(db: Database): Hono {
  const repo = makeChatRepo(db);
  const app = new Hono();

  app.post("/chats", async (c) => {
    // Tolerate empty / malformed bodies — default agent to "maya".
    const raw = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const agent = typeof raw.agent === "string" ? raw.agent : "maya";
    const chat = repo.create({ agent });
    return c.json({
      id: chat.id,
      title: chat.title,
      created_at: chat.created_at,
    });
  });

  app.get("/chats", (c) => c.json(repo.list()));

  return app;
}
