// VOS-92 T2.2: GET /agents → { agents: AgentListEntry[] }.
// VOS-152: ordering is plain alphabetical. The previous "maya first"
// rule leaked a hardcoded persona name into the picker UI even when
// the operator's vault shipped no maya agent — confusing, and the
// inverse of the reported friction ("why do I have maya agent? it's
// not in files").
// Mounted in app.ts via `app.route("/", agentsApi(db))`.

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeAgentRepo } from "../agents/repo";
import type { AgentListEntry } from "../agents/types";

export function agentsApi(db: Database): Hono {
  const repo = makeAgentRepo(db);
  const app = new Hono();

  app.get("/agents", (c) => {
    const rows = repo.list();
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const agents: AgentListEntry[] = rows.map((r) => ({
      name: r.name,
      description: r.description,
    }));
    return c.json({ agents });
  });

  return app;
}
