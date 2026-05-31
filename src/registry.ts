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
  a: { id: string; sessionId: string; tmuxSession: string; pid: number | null; now: number },
): void {
  db.query(
    "INSERT INTO runs (id, session_id, tmux_session, pid, state, started_at, ended_at, idle_since) VALUES (?, ?, ?, ?, 'spawning', ?, NULL, NULL)",
  ).run(a.id, a.sessionId, a.tmuxSession, a.pid, a.now);
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
