// reaper.test.ts — unit tests for idle-reaper (injected clock + tmux stub).
import { test, expect } from "bun:test";
import { openRegistry, createSession, createRun, setRunState, getRun } from "../src/registry.ts";
import { reapIdleRuns } from "../src/reaper.ts";

test("reapIdleRuns kills + exits an idle run older than TTL, leaves a fresh idle run alone", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "s", agent: null, skill: "x", now: 0 });
  createRun(db, { id: "stale", sessionId: "s", tmuxSession: "vos-run-stale", pid: 1, now: 0 });
  createRun(db, { id: "fresh", sessionId: "s", tmuxSession: "vos-run-fresh", pid: 2, now: 0 });
  setRunState(db, "stale", "idle", 0);     // idle since t=0
  setRunState(db, "fresh", "idle", 9_000); // idle since t=9000

  const killed: string[] = [];
  reapIdleRuns(db, { killSession: (n) => killed.push(n) }, 10_000, 5_000); // now=10000, ttl=5000

  expect(killed).toEqual(["vos-run-stale"]);
  expect(getRun(db, "stale")!.state).toBe("exited_ok");
  expect(getRun(db, "fresh")!.state).toBe("idle");
  db.close();
});

test("reapIdleRuns does nothing when no idle runs exist", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "s2", agent: null, skill: "x", now: 0 });
  createRun(db, { id: "running", sessionId: "s2", tmuxSession: "vos-run-r", pid: 1, now: 0 });
  setRunState(db, "running", "running", 1);

  const killed: string[] = [];
  reapIdleRuns(db, { killSession: (n) => killed.push(n) }, 10_000, 5_000);
  expect(killed).toHaveLength(0);
  db.close();
});

test("reapIdleRuns handles runs with NULL idle_since (spawning/running) without killing them", () => {
  const db = openRegistry(":memory:");
  createSession(db, { id: "s3", agent: null, skill: "x", now: 0 });
  createRun(db, { id: "spawning", sessionId: "s3", tmuxSession: "vos-run-sp", pid: 1, now: 0 });
  // spawning state — idle_since is NULL

  const killed: string[] = [];
  reapIdleRuns(db, { killSession: (n) => killed.push(n) }, 10_000, 0);
  expect(killed).toHaveLength(0);
  db.close();
});
