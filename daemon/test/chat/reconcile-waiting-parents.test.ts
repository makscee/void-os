// VOS-170: durable parent-resume sweep (ADR-0008).
//
// Exercises `reconcileWaitingParents(db, redrive)` at the DB layer with a
// stub re-driver. The function is the restart-hole closer: a parent parked in
// WAITING_ON_AGENT whose children ALL reached terminal is flipped to WORKING
// and re-driven from DB state. The in-memory event bus does not survive a
// daemon restart, so the sweep — not the bus — is the correctness path.
//
// The stub `redrive` captures its calls instead of spawning a real provider,
// so these tests are deterministic and fast.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { reconcileWaitingParents } from "../../src/chat/orchestrator";

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
    `INSERT INTO contexts (id, title, created_at)
     VALUES (?, NULL, strftime('%s','now'))`,
    [id],
  );
};

interface SeedTaskOpts {
  parent?: string | null;
  agent?: string | null;
  sessionId?: string | null;
  currentRunId?: string | null;
  targetAgent?: string | null;
  metadata?: string;
}

const seedTask = (
  db: Database,
  id: string,
  state: string,
  opts: SeedTaskOpts = {},
): void => {
  db.run(
    `INSERT INTO tasks (id, context_id, state, parent_task_id,
                        agent, session_id, current_run_id, target_agent,
                        cost_usd, tokens_in, tokens_out, metadata,
                        created_at, updated_at)
     VALUES (?, 'c', ?, ?, ?, ?, ?, ?, 0, 0, 0, ?,
             strftime('%s','now'), strftime('%s','now'))`,
    [
      id,
      state,
      opts.parent ?? null,
      opts.agent ?? null,
      opts.sessionId ?? null,
      opts.currentRunId ?? null,
      opts.targetAgent ?? null,
      opts.metadata ?? "{}",
    ],
  );
};

const seedRun = (db: Database, id: string, status: string): void => {
  db.run(
    `INSERT INTO runs (id, agent, kind, status, started_at)
     VALUES (?, 'a', 'chat', ?, strftime('%s','now'))`,
    [id, status],
  );
};

const seedAgentMessage = (
  db: Database,
  taskId: string,
  text: string,
): void => {
  db.run(
    `INSERT INTO messages (task_id, context_id, run_id, role, parts, parts_text, ts, ord)
     VALUES (?, 'c', NULL, 'ROLE_AGENT', '[]', ?, strftime('%s','now'), 0)`,
    [taskId, text],
  );
};

const stateOf = (db: Database, id: string): string => {
  const row = db
    .query("SELECT state FROM tasks WHERE id = ?")
    .get(id) as { state: string } | undefined;
  if (!row) throw new Error(`task not found: ${id}`);
  return row.state;
};

/** Stub re-driver — records calls, never spawns a provider. */
const makeStubRedrive = () => {
  const calls: Array<{
    parentTaskId: string;
    agentName: string;
    message: string;
    resumeFrom?: string;
  }> = [];
  const fn = (
    parentTaskId: string,
    args: { agentName: string; message: string; resumeFrom?: string },
  ): Promise<void> => {
    calls.push({ parentTaskId, ...args });
    return Promise.resolve();
  };
  return { fn, calls };
};

describe("reconcileWaitingParents", () => {
  test("the restart hole: child completed while parent's process was down → parent resumes", () => {
    const db = freshDb();
    seedContext(db);
    // Parent parked on ask_agent; child finished AFTER the daemon died, so
    // the in-memory wake event was never delivered. On next boot the sweep
    // must re-drive the parent — nothing else will.
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT", {
      agent: "maya",
      sessionId: "sess-1",
    });
    seedTask(db, "ch", "TASK_STATE_COMPLETED", {
      parent: "p",
      targetAgent: "builder",
    });
    seedAgentMessage(db, "ch", "child built the thing");

    const redrive = makeStubRedrive();
    const resumed = reconcileWaitingParents(db, redrive.fn);

    expect(resumed).toBe(1);
    expect(stateOf(db, "p")).toBe("TASK_STATE_WORKING");
    expect(redrive.calls).toHaveLength(1);
    expect(redrive.calls[0]!.parentTaskId).toBe("p");
    expect(redrive.calls[0]!.agentName).toBe("maya");
    expect(redrive.calls[0]!.resumeFrom).toBe("sess-1");
    // The child's final output is folded into the resume message.
    expect(redrive.calls[0]!.message).toContain("child built the thing");
    expect(redrive.calls[0]!.message).toContain("builder");
  });

  test("requires ALL children terminal — one running child blocks the resume", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT", { agent: "maya" });
    seedTask(db, "c1", "TASK_STATE_COMPLETED", { parent: "p" });
    seedTask(db, "c2", "TASK_STATE_WORKING", { parent: "p" });

    const redrive = makeStubRedrive();
    const resumed = reconcileWaitingParents(db, redrive.fn);

    expect(resumed).toBe(0);
    expect(stateOf(db, "p")).toBe("TASK_STATE_WAITING_ON_AGENT");
    expect(redrive.calls).toHaveLength(0);
  });

  test("resumes when ALL of several children are terminal", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT", { agent: "maya" });
    seedTask(db, "c1", "TASK_STATE_COMPLETED", { parent: "p" });
    seedTask(db, "c2", "TASK_STATE_FAILED", {
      parent: "p",
      metadata: JSON.stringify({ errorMessage: "boom" }),
    });
    seedTask(db, "c3", "TASK_STATE_CANCELED", { parent: "p" });

    const redrive = makeStubRedrive();
    const resumed = reconcileWaitingParents(db, redrive.fn);

    expect(resumed).toBe(1);
    expect(stateOf(db, "p")).toBe("TASK_STATE_WORKING");
    const msg = redrive.calls[0]!.message;
    expect(msg).toContain("failed: boom");
    expect(msg).toContain("cancelled");
  });

  test("a WAITING_ON_AGENT parent with no children is not resumed", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT", { agent: "maya" });

    const redrive = makeStubRedrive();
    const resumed = reconcileWaitingParents(db, redrive.fn);

    expect(resumed).toBe(0);
    expect(stateOf(db, "p")).toBe("TASK_STATE_WAITING_ON_AGENT");
  });

  test("idempotent: a parent holding a live run is skipped", () => {
    const db = freshDb();
    seedContext(db);
    // current_run_id points at a running run — a re-drive is already in
    // flight (or a prior sweep already fired). Do not double-drive.
    seedRun(db, "run-live", "running");
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT", {
      agent: "maya",
      currentRunId: "run-live",
    });
    seedTask(db, "ch", "TASK_STATE_COMPLETED", { parent: "p" });

    const redrive = makeStubRedrive();
    const resumed = reconcileWaitingParents(db, redrive.fn);

    expect(resumed).toBe(0);
    expect(redrive.calls).toHaveLength(0);
  });

  test("a parent with a stale terminal run is still resumed", () => {
    const db = freshDb();
    seedContext(db);
    // current_run_id points at a run that already finished — the pointer is
    // stale (bootRecovery may not have cleared it). The parent is eligible.
    seedRun(db, "run-old", "interrupted");
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT", {
      agent: "maya",
      currentRunId: "run-old",
    });
    seedTask(db, "ch", "TASK_STATE_COMPLETED", { parent: "p" });

    const redrive = makeStubRedrive();
    const resumed = reconcileWaitingParents(db, redrive.fn);

    expect(resumed).toBe(1);
    expect(stateOf(db, "p")).toBe("TASK_STATE_WORKING");
  });

  test("idempotent: second sweep after the first flipped the parent is a no-op", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WAITING_ON_AGENT", { agent: "maya" });
    seedTask(db, "ch", "TASK_STATE_COMPLETED", { parent: "p" });

    const redrive = makeStubRedrive();
    const first = reconcileWaitingParents(db, redrive.fn);
    expect(first).toBe(1);

    // The first sweep flipped p to WORKING. A second sweep sees it is no
    // longer WAITING_ON_AGENT and does nothing.
    const second = reconcileWaitingParents(db, redrive.fn);
    expect(second).toBe(0);
    expect(redrive.calls).toHaveLength(1);
  });

  test("a parent already WORKING is not touched", () => {
    const db = freshDb();
    seedContext(db);
    seedTask(db, "p", "TASK_STATE_WORKING", { agent: "maya" });
    seedTask(db, "ch", "TASK_STATE_COMPLETED", { parent: "p" });

    const redrive = makeStubRedrive();
    const resumed = reconcileWaitingParents(db, redrive.fn);

    expect(resumed).toBe(0);
    expect(redrive.calls).toHaveLength(0);
  });
});
