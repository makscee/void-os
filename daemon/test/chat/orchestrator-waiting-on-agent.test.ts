// VOS-89 T11: orchestrator resumes parent on child terminal.
//
// Exercises `resumeParentOnChildTerminal(db, childTaskId)` directly at the DB
// layer — no bus, no Provider, no spawn. The helper takes the child task id,
// reads the parent_task_id, and flips parent's state from WAITING_ON_AGENT to
// WORKING. No-ops when the parent is in any other state (CANCELED, etc.).
//
// Schema-fix vs plan §T11 seed:
//   - `tasks` has no `agent_name` column. We bind the real NOT NULL columns
//     (state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at)
//     and optionally `target_agent` to model the child's dispatch target.
//   - `contexts` seed binds (id, agent_name, title, created_at, updated_at).
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { resumeParentOnChildTerminal } from "../../src/chat/orchestrator";

const MIGRATIONS_DIR = join(
  import.meta.dir,
  "../../src/adapters/sqlite/migrations",
);

const freshDb = (): Database => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  return db;
};

const seedContext = (db: Database, id = "c"): void => {
  db.run(
    `INSERT INTO contexts (id, agent_name, archived, created_at, updated_at)
     VALUES (?, 'maya', 0, strftime('%s','now'), strftime('%s','now'))`,
    [id],
  );
};

const seedTask = (
  db: Database,
  id: string,
  state: string,
  opts: { target_agent?: string; parent_task_id?: string } = {},
): void => {
  db.run(
    `INSERT INTO tasks (id, context_id, state, target_agent, parent_task_id,
                        cost_usd, tokens_in, tokens_out, metadata,
                        created_at, updated_at)
     VALUES (?, 'c', ?, ?, ?, 0, 0, 0, '{}',
             strftime('%s','now'), strftime('%s','now'))`,
    [id, state, opts.target_agent ?? null, opts.parent_task_id ?? null],
  );
};

describe("resumeParentOnChildTerminal", () => {
  test("parent WAITING_ON_AGENT -> WORKING on child COMPLETED", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT");
    seedTask(db, "ch", "TASK_STATE_COMPLETED", {
      target_agent: "journaler",
      parent_task_id: "p",
    });
    resumeParentOnChildTerminal(db, "ch");
    const p = db
      .query("SELECT state FROM tasks WHERE id='p'")
      .get() as { state: string };
    expect(p.state).toBe("TASK_STATE_WORKING");
  });

  test("no-op if parent not WAITING_ON_AGENT", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_CANCELED");
    seedTask(db, "ch", "TASK_STATE_COMPLETED", {
      target_agent: "journaler",
      parent_task_id: "p",
    });
    resumeParentOnChildTerminal(db, "ch");
    const p = db
      .query("SELECT state FROM tasks WHERE id='p'")
      .get() as { state: string };
    expect(p.state).toBe("TASK_STATE_CANCELED");
  });
});
