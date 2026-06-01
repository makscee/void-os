// registry.ts — SQLite executions schema (ADR-0003 §2): one row per skill-execution.
// Stateless: no sessions, no resume_token, no idle state. The executions table is the
// ONE runtime read-model and is rebuildable from the file-level event log (events.ts).
import { Database } from "bun:sqlite";

export function openRegistry(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id              TEXT PRIMARY KEY,
      agent           TEXT,
      skill           TEXT,
      input_ref       TEXT,
      tmux_session    TEXT NOT NULL,
      started_at      INTEGER NOT NULL,
      ended_at        INTEGER,
      produced_change INTEGER NOT NULL DEFAULT 0,
      nudged          INTEGER NOT NULL DEFAULT 0,
      trigger_id      TEXT,
      step_count      INTEGER NOT NULL DEFAULT 0,
      step_ceiling    INTEGER,
      reason          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exec_tmux ON executions(tmux_session);
    CREATE INDEX IF NOT EXISTS idx_exec_started ON executions(started_at);
  `);

  // Triggers table — UNCHANGED from VOS-189 (preserved wholesale per plan)
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      name          TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      skill         TEXT NOT NULL,
      agent         TEXT NOT NULL,
      cron_expr     TEXT,
      inbox         TEXT,
      step_ceiling  INTEGER NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      next_fire_at  INTEGER,
      last_fired_at INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
  `);

  return db;
}

// --- Types ---

export interface ExecutionRow {
  id: string;
  agent: string | null;
  skill: string | null;
  input_ref: string | null;
  tmux_session: string;
  started_at: number;
  ended_at: number | null;
  produced_change: number; // 0|1 — populated by VOS-191
  nudged: number;          // 0|1 — populated by VOS-191
  trigger_id: string | null;
  step_count: number;
  step_ceiling: number | null;
  reason: string | null;
}

export interface TriggerRow {
  name: string;
  kind: string;
  skill: string;
  agent: string;
  cron_expr: string | null;
  inbox: string | null;
  step_ceiling: number;
  enabled: number;
  next_fire_at: number | null;
  last_fired_at: number | null;
  created_at: number;
  updated_at: number;
}

// --- Execution helpers ---

export function createExecution(
  db: Database,
  a: { id: string; agent: string | null; skill: string | null; inputRef: string | null;
       tmuxSession: string; now: number; triggerId: string | null; stepCeiling: number | null },
): void {
  db.query(
    "INSERT INTO executions (id, agent, skill, input_ref, tmux_session, started_at, ended_at, " +
    "produced_change, nudged, trigger_id, step_count, step_ceiling, reason) " +
    "VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0, ?, 0, ?, NULL)",
  ).run(a.id, a.agent, a.skill, a.inputRef, a.tmuxSession, a.now, a.triggerId, a.stepCeiling);
}

export function setExecutionEnded(db: Database, id: string, now: number): void {
  db.query("UPDATE executions SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(now, id);
}

export function getExecution(db: Database, id: string): ExecutionRow | null {
  return (db.query("SELECT * FROM executions WHERE id = ?").get(id) as ExecutionRow) ?? null;
}

export function executionByTmuxSession(db: Database, tmux: string): ExecutionRow | null {
  return (db.query("SELECT * FROM executions WHERE tmux_session = ?").get(tmux) as ExecutionRow) ?? null;
}

export function listExecutions(db: Database): ExecutionRow[] {
  return db.query("SELECT * FROM executions ORDER BY started_at DESC").all() as ExecutionRow[];
}

/** Increment an execution's step_count and return the new value. */
export function incrementStep(db: Database, id: string): number {
  db.query("UPDATE executions SET step_count = step_count + 1 WHERE id = ?").run(id);
  const row = db.query("SELECT step_count FROM executions WHERE id = ?").get(id) as { step_count: number } | null;
  return row?.step_count ?? 0;
}

/** Terminal fail with a reason (e.g. "runaway-ceiling"). */
export function setExecutionFail(db: Database, id: string, reason: string, now: number): void {
  db.query("UPDATE executions SET ended_at = ?, reason = ? WHERE id = ?").run(now, reason, id);
}

/** Record the Stop-time output-target result (VOS-191). */
export function setOutputResult(
  db: Database,
  id: string,
  a: { producedChange: boolean; nudged: boolean },
): void {
  db.query("UPDATE executions SET produced_change = ?, nudged = ? WHERE id = ?")
    .run(a.producedChange ? 1 : 0, a.nudged ? 1 : 0, id);
}

// --- Trigger helpers (UNCHANGED from VOS-189) ---

export function upsertTrigger(
  db: Database,
  a: { name: string; kind: string; skill: string; agent: string;
       cronExpr: string | null; inbox: string | null; stepCeiling: number; now: number },
): void {
  db.query(`
    INSERT INTO triggers (name, kind, skill, agent, cron_expr, inbox, step_ceiling, enabled, next_fire_at, last_fired_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      kind=excluded.kind, skill=excluded.skill, agent=excluded.agent,
      cron_expr=excluded.cron_expr, inbox=excluded.inbox,
      step_ceiling=excluded.step_ceiling, updated_at=excluded.updated_at
  `).run(a.name, a.kind, a.skill, a.agent, a.cronExpr, a.inbox, a.stepCeiling, a.now, a.now);
}

export function getTrigger(db: Database, name: string): TriggerRow | null {
  return (db.query("SELECT * FROM triggers WHERE name = ?").get(name) as TriggerRow) ?? null;
}

export function listTriggers(db: Database): TriggerRow[] {
  return db.query("SELECT * FROM triggers").all() as TriggerRow[];
}

export function setTriggerFireTimes(
  db: Database,
  name: string,
  a: { nextFireAt: number | null; lastFiredAt?: number | null },
): void {
  if (a.lastFiredAt !== undefined) {
    db.query("UPDATE triggers SET next_fire_at = ?, last_fired_at = ? WHERE name = ?")
      .run(a.nextFireAt, a.lastFiredAt, name);
  } else {
    db.query("UPDATE triggers SET next_fire_at = ? WHERE name = ?").run(a.nextFireAt, name);
  }
}

export function setTriggerEnabled(db: Database, name: string, enabled: boolean): void {
  db.query("UPDATE triggers SET enabled = ? WHERE name = ?").run(enabled ? 1 : 0, name);
}
