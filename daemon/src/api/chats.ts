// HTTP routes for the chat registry (VOS-79 Task 3).
//
// - POST /chats { agent }          → create a chat, return {id, title, created_at}
// - GET  /chats                    → list chats, recent-first, with last_msg preview
//
// The router accepts a `Database` and constructs a `makeChatRepo(db)` once.
// Mounted in `daemon/src/app.ts` via `app.route("/", chatsApi(db))`.
//
// VOS-124 T3: strict agent validation — no silent maya fallback.
// Wiring: Option A (direct import of makeAgentRepo), matching agentsApi pattern.

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeChatRepo } from "../chat/repo.ts";
import { makeAgentRepo } from "../agents/repo.ts";

export function chatsApi(db: Database): Hono {
  const repo = makeChatRepo(db);
  const agentRepo = makeAgentRepo(db);
  const app = new Hono();

  app.post("/chats", async (c) => {
    // VOS-124: strict validation — agent must be a non-empty string present in registry.
    const raw = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (typeof raw.agent !== "string" || raw.agent === "") {
      return c.json(
        { error: "E_INVALID_BODY", message: "agent is required" },
        400,
      );
    }

    const agentName = raw.agent;
    const known = agentRepo.list().map((r) => r.name);
    if (!known.includes(agentName)) {
      return c.json(
        {
          error: "E_AGENT_NOT_FOUND",
          message: `agent '${agentName}' not found`,
        },
        404,
      );
    }

    const chat = repo.create({ agent: agentName });
    return c.json({
      id: chat.id,
      title: chat.title,
      created_at: chat.created_at,
    });
  });

  app.get("/chats", (c) => c.json(repo.list()));

  return app;
}
