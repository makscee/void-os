// VOS-92 T2.2: GET /agents → { agents: AgentListEntry[] }.
// Ordering: name='maya' first if present, then alphabetical.
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
    rows.sort((a, b) => {
      if (a.name === "maya" && b.name !== "maya") return -1;
      if (b.name === "maya" && a.name !== "maya") return 1;
      return a.name.localeCompare(b.name);
    });
    const agents: AgentListEntry[] = rows.map((r) => ({
      name: r.name,
      description: r.description,
    }));
    return c.json({ agents });
  });

  return app;
}
