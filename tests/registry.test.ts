// registry.test.ts — unit tests for SQLite runs+sessions schema and helpers.
import { test, expect } from "bun:test";
import {
  openRegistry,
  createSession,
  createRun,
  setRunState,
  setResumeToken,
  getRun,
  getSession,
  latestRunForSession,
} from "../src/registry.ts";

test("openRegistry creates runs + sessions tables with expected columns", () => {
  const db = openRegistry(":memory:");
  const runCols = (db.query("PRAGMA table_info(runs)").all() as { name: string }[]).map((r) => r.name);
  expect(runCols).toEqual(
    expect.arrayContaining([
      "id", "session_id", "tmux_session", "pid", "state",
      "started_at", "ended_at", "idle_since",
    ]),
  );
  const sesCols = (db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((r) => r.name);
  expect(sesCols).toEqual(
    expect.arrayContaining([
      "id", "resume_token", "state", "agent", "skill", "created_at", "last_run_at",
    ]),
  );
  db.close();
});

test("createSession + createRun insert rows with starting states", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-1", agent: null, skill: "smoke-test", now: 1000 });
  createRun(db, { id: "run-1", sessionId: "ses-1", tmuxSession: "vos-run-run-1", pid: 42, now: 1000 });
  const r = getRun(db, "run-1");
  expect(r).not.toBeNull();
  expect(r!.state).toBe("spawning");
  expect(r!.tmux_session).toBe("vos-run-run-1");
  expect(getSession(db, "ses-1")!.resume_token).toBeNull();
  db.close();
});

test("setResumeToken fills only when NULL (first SessionStart wins)", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-2", agent: null, skill: "x", now: 1 });
  const first = setResumeToken(db, "ses-2", "cc-uuid-A", 2);
  const second = setResumeToken(db, "ses-2", "cc-uuid-B", 3);
  expect(first).toBe(true);   // filled
  expect(second).toBe(false); // already set, untouched
  expect(getSession(db, "ses-2")!.resume_token).toBe("cc-uuid-A");
  db.close();
});

test("setRunState walks the lifecycle and stamps ended_at on terminal", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-3", agent: null, skill: "x", now: 1 });
  createRun(db, { id: "run-3", sessionId: "ses-3", tmuxSession: "t", pid: 1, now: 1 });
  setRunState(db, "run-3", "running", 2);
  setRunState(db, "run-3", "idle", 3);
  setRunState(db, "run-3", "exited_ok", 4);
  const r = getRun(db, "run-3");
  expect(r!.state).toBe("exited_ok");
  expect(r!.ended_at).toBe(4);
  expect(r!.idle_since).toBeNull(); // cleared on terminal
  expect(latestRunForSession(db, "ses-3")!.id).toBe("run-3");
  db.close();
});

test("setRunState sets idle_since when transitioning to idle", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "ses-4", agent: null, skill: "x", now: 1 });
  createRun(db, { id: "run-4", sessionId: "ses-4", tmuxSession: "t4", pid: 1, now: 1 });
  setRunState(db, "run-4", "running", 5);
  setRunState(db, "run-4", "idle", 10);
  const r = getRun(db, "run-4");
  expect(r!.state).toBe("idle");
  expect(r!.idle_since).toBe(10);
  db.close();
});
