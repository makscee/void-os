// HTTP route for the global activity list (VOS-172).
//
//   GET /tasks                   → TaskActivityItem[], sorted by last activity
//     query params:
//       include_terminal=1       → keep terminal Tasks regardless of recency
//       recency_hours=<n>        → recency window for terminal Tasks
//       limit=<n>                → cap rows returned
//
// Backed by `makeNavRepo(db).listTasks` (VOS-169) — the SAME query the
// `list_tasks` MCP tool exposes to agents, so the plugin's activity list and
// an agent's navigation view never drift. The route layers one extra field
// the UI needs: `last_msg`, a short preview of the Task's most recent
// message, derived here via a correlated subquery on `messages.task_id`.
// nav-repo's TaskListItem is intentionally left untouched (it is a shipped
// VOS-169 contract); the preview is a UI-only concern.
//
// Mounted in `daemon/src/app.ts` via `app.route("/", tasksApi(db))`.

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { makeNavRepo, type TaskListItem } from "../chat/nav-repo.ts";

/** Max characters of message preview returned per row. Matches the chat
 *  list's 200-char `last_msg` shape so the UI truncation logic is uniform. */
const PREVIEW_MAX = 200;

/** One row of the global activity list = a nav-repo TaskListItem plus a short
 *  preview of the Task's most recent message. */
export interface TaskActivityItem extends TaskListItem {
  /** Preview of the most recent message for this Task (any role); null when
   *  the Task has no messages yet. */
  last_msg: string | null;
}

function parseBool(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

function parsePosNumber(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Correlated single-row preview lookup. `parts_text` is the denormalised
// plain-text projection messages-repo maintains for previews.
const PREVIEW_SQL = `SELECT parts_text
   FROM messages
  WHERE task_id = ?
  ORDER BY ts DESC, ord DESC
  LIMIT 1`;

export function tasksApi(db: Database): Hono {
  const nav = makeNavRepo(db);
  const app = new Hono();

  app.get("/tasks", (c) => {
    // Prepared lazily inside the handler — buildApp may wire this route over
    // a DB whose `messages` table is not yet created (minimal-schema tests);
    // eager prepare at construction time would throw on import.
    const previewQuery = db.query<{ parts_text: string }, [string]>(
      PREVIEW_SQL,
    );
    const includeTerminal = parseBool(c.req.query("include_terminal"));
    const recencyHours = parsePosNumber(c.req.query("recency_hours"));
    const limit = parsePosNumber(c.req.query("limit"));

    const tasks = nav.listTasks({
      includeTerminal,
      recencyMs:
        typeof recencyHours === "number"
          ? recencyHours * 60 * 60 * 1000
          : undefined,
      limit: typeof limit === "number" ? Math.trunc(limit) : undefined,
    });

    const rows: TaskActivityItem[] = tasks.map((t) => {
      const row = previewQuery.get(t.id);
      let last_msg: string | null = null;
      if (row && typeof row.parts_text === "string") {
        const cleaned = row.parts_text.replace(/\s+/g, " ").trim();
        last_msg = cleaned ? cleaned.slice(0, PREVIEW_MAX) : null;
      }
      return { ...t, last_msg };
    });

    return c.json(rows);
  });

  return app;
}
