// VOS-171: terminal-Task freeze enforcement.
//
// A root Task that has reached a terminal state (completed / failed /
// canceled) is frozen — orchestrator.dispatch() rejects any new user
// message against it with a 409 TASK_TERMINAL error. The caller must
// start a fresh sibling root Task instead. No stray runs row is left
// behind by the rejected dispatch.

import { test, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/adapters/sqlite/migrations.ts";
import { join } from "node:path";
import { makeChatRepo, openTaskFor } from "../../src/chat/repo";
import { makeOrchestrator } from "../../src/chat/orchestrator";
import type {
  Provider,
  ProviderHandle,
  ProviderSpawnRequest,
} from "../../src/providers/index.ts";
import { normalizeStream } from "../helpers/normalize-stream.ts";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);

function freshDb(): Database {
  const db = new Database(":memory:");
  applyMigrations(
    db,
    loadMigrations(MIGRATIONS_DIR).filter((mg) => mg.version.slice(0, 4) <= "0016"),
  );
  return db;
}

function trivialProvider(): Provider {
  return {
    name: "trivial",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      const events = normalizeStream(
        (async function* () {
          yield { type: "system", session_id: "sid-1" };
          yield {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          };
        })(),
      );
      return {
        events,
        cancel: async () => false,
        done: Promise.resolve({ reason: "exit" as const, exitCode: 0 }),
      };
    },
  };
}

function mkOrch(db: Database) {
  const repo = makeChatRepo(db);
  return {
    repo,
    orch: makeOrchestrator({
      db,
      repo,
      provider: trivialProvider(),
      cwd: "/tmp",
      emit: () => {},
      titler: { title: mock(async () => {}) },
    }),
  };
}

// A frozen root Task: agent-declared COMPLETED, or any FAILED / CANCELED.
// A bare run-end-inferred COMPLETED is deliberately NOT in this list — it is
// "idle between turns" and must stay re-engageable (covered separately).
const FROZEN_CASES: Array<{ label: string; seed: (db: Database, id: string) => void }> = [
  {
    label: "agent-declared COMPLETED",
    seed: (db, id) =>
      db.run(
        "UPDATE tasks SET state = 'TASK_STATE_COMPLETED', metadata = json_set('{}','$.terminal_declared', json('true')) WHERE id = ?",
        [id],
      ),
  },
  {
    label: "FAILED",
    seed: (db, id) =>
      db.run("UPDATE tasks SET state = 'TASK_STATE_FAILED' WHERE id = ?", [id]),
  },
  {
    label: "CANCELED",
    seed: (db, id) =>
      db.run("UPDATE tasks SET state = 'TASK_STATE_CANCELED' WHERE id = ?", [id]),
  },
];

for (const { label, seed } of FROZEN_CASES) {
  test(`dispatch rejects a re-engaging message on a ${label} root Task`, async () => {
    const db = freshDb();
    const { repo, orch } = mkOrch(db);
    const c = repo.create({ agent: "maya" });
    const taskId = openTaskFor(db, c.id);
    seed(db, taskId);

    let caught: (Error & { status?: number }) | undefined;
    try {
      await orch.dispatch(c.id, "are you still there?");
    } catch (e) {
      caught = e as Error & { status?: number };
    }
    expect(caught).toBeDefined();
    expect(caught!.status).toBe(409);
    expect(caught!.message).toContain("TASK_TERMINAL");

    // No stray runs row for the rejected dispatch.
    const runCount = db
      .query("SELECT COUNT(*) AS n FROM runs WHERE chat_id = ?")
      .get(c.id) as { n: number };
    expect(runCount.n).toBe(0);

    // Task is untouched by the rejected dispatch — still terminal.
    const after = db
      .query("SELECT state FROM tasks WHERE id = ?")
      .get(taskId) as { state: string };
    expect(
      ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED"].includes(
        after.state,
      ),
    ).toBe(true);
  });
}

test("dispatch still accepts a message on a non-terminal (WORKING) root Task", async () => {
  const db = freshDb();
  const { repo, orch } = mkOrch(db);
  const c = repo.create({ agent: "maya" });
  // root Task starts WORKING — dispatch must succeed.
  const result = await orch.dispatch(c.id, "hello");
  expect(result.status).toBe("done");
});

test("dispatch still accepts a message on a run-end-inferred COMPLETED root Task (multi-turn)", async () => {
  // A bare COMPLETED with no `terminal_declared` flag is the orchestrator's
  // run-end "idle" state. A multi-turn chat must re-engage it — the freeze
  // guard only seals AGENT-declared completions.
  const db = freshDb();
  const { repo, orch } = mkOrch(db);
  const c = repo.create({ agent: "maya" });
  const taskId = openTaskFor(db, c.id);
  db.run("UPDATE tasks SET state = 'TASK_STATE_COMPLETED' WHERE id = ?", [taskId]);
  const result = await orch.dispatch(c.id, "follow-up question");
  expect(result.status).toBe("done");
});
