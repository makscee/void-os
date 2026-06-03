// reaper.test.ts — unit tests for the idle-reap logic (pure functions + wired sweep).
// VOS-205 T3: injected clock, no real processes.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dueForReap, reapIdle, type ReapCandidate } from "../src/reaper.ts";
import { openRegistry, createExecution, getExecution } from "../src/registry.ts";
import { reapedPath, sessionDir } from "../src/paths.ts";

test("dueForReap selects live sessions idle past the threshold, skips ended ones", () => {
  const now = 1_000_000;
  const idleMs = 10 * 60_000;
  const execs: ReapCandidate[] = [
    { id: "a", tmux_session: "vos-run-a", ended_at: null, last_activity: now - 11 * 60_000 }, // idle 11m → reap
    { id: "b", tmux_session: "vos-run-b", ended_at: null, last_activity: now - 2 * 60_000 },  // idle 2m → keep
    { id: "c", tmux_session: "vos-run-c", ended_at: 500_000, last_activity: now - 60 * 60_000 }, // already ended → skip
  ];
  expect(dueForReap(execs, now, idleMs).map(e => e.id)).toEqual(["a"]);
});

test("dueForReap returns empty when all sessions are within idle window", () => {
  const now = 1_000_000;
  const idleMs = 10 * 60_000;
  const execs: ReapCandidate[] = [
    { id: "x", tmux_session: "vos-run-x", ended_at: null, last_activity: now - 5 * 60_000 },
    { id: "y", tmux_session: "vos-run-y", ended_at: null, last_activity: now - 1 * 60_000 },
  ];
  expect(dueForReap(execs, now, idleMs)).toHaveLength(0);
});

test("dueForReap returns all live sessions when all exceed the threshold", () => {
  const now = 1_000_000;
  const idleMs = 60_000; // 1 minute
  const execs: ReapCandidate[] = [
    { id: "p", tmux_session: "vos-run-p", ended_at: null, last_activity: now - 2 * 60_000 },
    { id: "q", tmux_session: "vos-run-q", ended_at: null, last_activity: now - 3 * 60_000 },
  ];
  expect(dueForReap(execs, now, idleMs).map(e => e.id)).toEqual(["p", "q"]);
});

test("dueForReap exactly-at-threshold session is included (>=)", () => {
  const now = 1_000_000;
  const idleMs = 10 * 60_000;
  const execs: ReapCandidate[] = [
    { id: "exact", tmux_session: "vos-run-exact", ended_at: null, last_activity: now - idleMs },
  ];
  expect(dueForReap(execs, now, idleMs)).toHaveLength(1);
});

test("reapIdle calls killFn for each due session and marks ended_at", () => {
  const db = openRegistry(":memory:");
  const vault = "/tmp/void-os-reaper-test";

  // Seed two executions: one idle beyond threshold, one recent
  const now = 1_000_000;
  const idleMs = 10 * 60_000;

  createExecution(db, { id: "exec-old", agent: null, skill: null, inputRef: null,
    tmuxSession: "vos-run-exec-old", now: now - 15 * 60_000, triggerId: null, stepCeiling: null });
  createExecution(db, { id: "exec-new", agent: null, skill: null, inputRef: null,
    tmuxSession: "vos-run-exec-new", now: now - 2 * 60_000, triggerId: null, stepCeiling: null });

  const killed: string[] = [];
  const reaped = reapIdle(db, vault, now, idleMs, (session) => { killed.push(session); });

  expect(reaped).toEqual(["exec-old"]);
  expect(killed).toEqual(["vos-run-exec-old"]);

  // exec-old should now be ended
  const old = getExecution(db, "exec-old");
  expect(old?.ended_at).toBe(now);
  const fresh = getExecution(db, "exec-new");
  expect(fresh?.ended_at).toBeNull();
});

test("reapIdle stamps reaped.txt for each reaped execution", () => {
  const db = openRegistry(":memory:");
  const vault = "/tmp/void-os-reaper-stamp-test";
  rmSync(vault, { recursive: true, force: true });

  const now = 2_000_000;
  const idleMs = 10 * 60_000;

  // Create two executions, both idle beyond threshold
  createExecution(db, { id: "stamp-a", agent: null, skill: null, inputRef: null,
    tmuxSession: "vos-run-stamp-a", now: now - 20 * 60_000, triggerId: null, stepCeiling: null });
  createExecution(db, { id: "stamp-b", agent: null, skill: null, inputRef: null,
    tmuxSession: "vos-run-stamp-b", now: now - 15 * 60_000, triggerId: null, stepCeiling: null });
  // One recent (should NOT be reaped or stamped)
  createExecution(db, { id: "stamp-c", agent: null, skill: null, inputRef: null,
    tmuxSession: "vos-run-stamp-c", now: now - 2 * 60_000, triggerId: null, stepCeiling: null });

  // Create session dirs so reapedPath's directory exists
  mkdirSync(sessionDir(vault, "stamp-a"), { recursive: true });
  mkdirSync(sessionDir(vault, "stamp-b"), { recursive: true });
  mkdirSync(sessionDir(vault, "stamp-c"), { recursive: true });

  const killed: string[] = [];
  reapIdle(db, vault, now, idleMs, (session) => { killed.push(session); });

  // Both idle execs should have reaped.txt
  expect(existsSync(reapedPath(vault, "stamp-a"))).toBe(true);
  expect(existsSync(reapedPath(vault, "stamp-b"))).toBe(true);
  // Recent exec should NOT have reaped.txt
  expect(existsSync(reapedPath(vault, "stamp-c"))).toBe(false);
});
