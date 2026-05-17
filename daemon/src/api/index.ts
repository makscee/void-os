// HTTP + WS API server surface. Routes plugin requests to chat/worker/skills/etc.
// T5: mounts /health onto the shared Hono app. Other endpoints land downstream.

import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { mountCost } from "./cost";
import { makeRequireAuth } from "../auth/middleware.ts";

export interface ApiContext {
  version: string;
  db: Database;
  tz: string; // VOS-87: IANA name resolved at boot
  vaultRoot: string;
  token: string;
  bootTime: number;
}

/**
 * Mount API routes onto the shared Hono app.
 *
 * For now this is just `GET /health`. As more modules (chat, worker, skills,
 * triggers) come online they'll register their routes here.
 */
export const mountApi = (app: Hono, ctx: ApiContext): void => {
  const requireAuth = makeRequireAuth(ctx.token);
  app.use("/health", requireAuth);
  app.get("/health", (c) =>
    c.json({
      ok: true,
      version: ctx.version,
      vault_root: ctx.vaultRoot,
      uptime_s: Math.floor((Date.now() - ctx.bootTime) / 1000),
      sessions: 0,
    }),
  );
  mountCost(app, ctx);
};
