// registry.ts — SQLite runs+sessions schema, open/migrate, typed insert/update/query helpers.
// One responsibility: registry persistence + state-transition writes.
// Pure: unit-testable against :memory: or tmp-file DB.
import { Database } from "bun:sqlite";

export type RunState = "spawning" | "running" | "idle" | "exited_ok" | "exited_fail";
export type SessionState = "open" | "resumable" | "closed";

export function openRegistry(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      resume_token TEXT,
      state        TEXT NOT NULL DEFAULT 'open',
      agent        TEXT,
      skill        TEXT,
      created_at   INTEGER NOT NULL,
      last_run_at  INTEGER
    );
    CREATE TABLE IF NOT EXISTS runs (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(id),
      tmux_session  TEXT NOT NULL,
      pid           INTEGER,
      state         TEXT NOT NULL DEFAULT 'spawning',
      started_at    INTEGER NOT NULL,
      ended_at      INTEGER,
      idle_since    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_runs_state ON runs(state);
  `);

  // Triggers table (phase-2)
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

  // Additive migration of runs (idempotent): each ALTER throws if the column
  // already exists — swallow that specific case.
  for (const ddl of [
    "ALTER TABLE runs ADD COLUMN trigger_id TEXT",
    "ALTER TABLE runs ADD COLUMN step_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE runs ADD COLUMN step_ceiling INTEGER",
    "ALTER TABLE runs ADD COLUMN reason TEXT",
  ]) {
    try { db.exec(ddl); } catch (e) {
      if (!String(e).includes("duplicate column")) throw e;
    }
  }

  return db;
}

// --- Types ---

export interface RunRow {
  id: string;
  session_id: string;
  tmux_session: string;
  pid: number | null;
  state: RunState;
  started_at: number;
  ended_at: number | null;
  idle_since: number | null;
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

export interface SessionRow {
  id: string;
  resume_token: string | null;
  state: SessionState;
  agent: string | null;
  skill: string | null;
  created_at: number;
  last_run_at: number | null;
}

// --- Helpers ---

const TERMINAL: ReadonlySet<RunState> = new Set(["exited_ok", "exited_fail"]);

export function createSession(
  db: Database,
  a: { id: string; agent: string | null; skill: string | null; now: number },
): void {
  db.query(
    "INSERT INTO sessions (id, resume_token, state, agent, skill, created_at, last_run_at) VALUES (?, NULL, 'open', ?, ?, ?, ?)",
  ).run(a.id, a.agent, a.skill, a.now, a.now);
}

export function createRun(
  db: Database,
  a: { id: string; sessionId: string; tmuxSession: string; pid: number | null; now: number;
       triggerId?: string | null; stepCeiling?: number | null },
): void {
  db.query(
    "INSERT INTO runs (id, session_id, tmux_session, pid, state, started_at, ended_at, idle_since, trigger_id, step_count, step_ceiling, reason) " +
    "VALUES (?, ?, ?, ?, 'spawning', ?, NULL, NULL, ?, 0, ?, NULL)",
  ).run(a.id, a.sessionId, a.tmuxSession, a.pid, a.now, a.triggerId ?? null, a.stepCeiling ?? null);
  // Update last_run_at on the parent session
  db.query("UPDATE sessions SET last_run_at = ? WHERE id = ?").run(a.now, a.sessionId);
}

export function setRunState(db: Database, runId: string, state: RunState, now: number): void {
  if (TERMINAL.has(state)) {
    db.query(
      "UPDATE runs SET state = ?, ended_at = ?, idle_since = NULL WHERE id = ?",
    ).run(state, now, runId);
  } else if (state === "idle") {
    db.query(
      "UPDATE runs SET state = 'idle', idle_since = ? WHERE id = ?",
    ).run(now, runId);
  } else {
    db.query("UPDATE runs SET state = ?, idle_since = NULL WHERE id = ?").run(state, runId);
  }
}

/**
 * Set the session's resume_token only if it is currently NULL (first SessionStart wins).
 * Returns true if the token was written, false if it was already set.
 */
export function setResumeToken(db: Database, sessionId: string, token: string, now: number): boolean {
  const result = db.query(
    "UPDATE sessions SET resume_token = ?, last_run_at = ? WHERE id = ? AND resume_token IS NULL",
  ).run(token, now, sessionId);
  return (result as { changes: number }).changes > 0;
}

export function getRun(db: Database, id: string): RunRow | null {
  return (db.query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow) ?? null;
}

export function getSession(db: Database, id: string): SessionRow | null {
  return (db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow) ?? null;
}

export function latestRunForSession(db: Database, sessionId: string): RunRow | null {
  return (
    (db.query(
      "SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1",
    ).get(sessionId) as RunRow) ?? null
  );
}

/** Run lookup by the tmux session name. */
export function runByTmuxSession(db: Database, tmux: string): RunRow | null {
  return (db.query("SELECT * FROM runs WHERE tmux_session = ?").get(tmux) as RunRow) ?? null;
}

// --- Trigger helpers ---

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

/** Increment a Run's step_count and return the new value. */
export function incrementStep(db: Database, runId: string): number {
  db.query("UPDATE runs SET step_count = step_count + 1 WHERE id = ?").run(runId);
  const row = db.query("SELECT step_count FROM runs WHERE id = ?").get(runId) as { step_count: number } | null;
  return row?.step_count ?? 0;
}

/** Terminal fail with a reason (e.g. "runaway-ceiling"). */
export function setRunFail(db: Database, runId: string, reason: string, now: number): void {
  db.query("UPDATE runs SET state = 'exited_fail', ended_at = ?, idle_since = NULL, reason = ? WHERE id = ?")
    .run(now, reason, runId);
}
