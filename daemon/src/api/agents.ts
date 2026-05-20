// VOS-92 T2.2: GET /agents → { agents: AgentListEntry[] }.
// VOS-152: ordering is plain alphabetical. The previous "maya first"
// rule leaked a hardcoded persona name into the picker UI even when
// the operator's vault shipped no maya agent — confusing, and the
// inverse of the reported friction ("why do I have maya agent? it's
// not in files").
// VOS-166: when `vaultRoot` is supplied, GET /agents triggers a debounced
// rescan of vault/agents/ before listing, so an agent.md authored after
// daemon boot becomes visible without a restart (regression: VOS-163 S4).
// Mounted in app.ts via `app.route("/", agentsApi(db, vaultRoot))`.

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeAgentRepo } from "../agents/repo";
import { makeDebouncedRescan } from "../agents/rescan";
import type { AgentListEntry } from "../agents/types";

export function agentsApi(db: Database, vaultRoot?: string): Hono {
  const repo = makeAgentRepo(db);
  const app = new Hono();
  // VOS-166: lazy rescan-on-read. Omitted in unit tests that drive the
  // `agents` table directly; production (app.ts) always passes vaultRoot.
  const rescan = vaultRoot ? makeDebouncedRescan(db, vaultRoot) : null;

  app.get("/agents", (c) => {
    if (rescan) rescan();
    const rows = repo.list();
    rows.sort((a, b) => a.name.localeCompare(b.name));
    // VOS-153: project optional presentation fields. `undefined` values
    // are stripped by JSON.stringify, so consumers on older protocol
    // versions (without color/avatar/tagline) keep seeing the original
    // {name, description} shape and never observe a null field.
    const agents: AgentListEntry[] = rows.map((r) => {
      const entry: AgentListEntry = {
        name: r.name,
        description: r.description,
      };
      if (r.color !== undefined) entry.color = r.color;
      if (r.avatar !== undefined) entry.avatar = r.avatar;
      if (r.tagline !== undefined) entry.tagline = r.tagline;
      return entry;
    });
    return c.json({ agents });
  });

  return app;
}
