import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../../../src/adapters/sqlite/migrations";
import {
  askAgentChainDepth,
  MAX_ASK_AGENT_DEPTH,
} from "../../../../src/adapters/mcp/tools/ask-agent-depth";

const MIGRATIONS = join(
  import.meta.dir,
  "../../../../src/adapters/sqlite/migrations",
);

function seedTaskChain(db: Database, length: number): string {
  // root has no parent; subsequent tasks chain via parent_task_id.
  let prev: string | null = null;
  let lastId = "";
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < length; i++) {
    const id = `t${i}`;
    db.run(
      `INSERT INTO tasks
         (id, context_id, parent_task_id, state,
          cost_usd, tokens_in, tokens_out, metadata,
          created_at, updated_at)
       VALUES (?, 'c', ?, 'TASK_STATE_WORKING',
               0, 0, 0, '{}', ?, ?)`,
      [id, prev, now, now],
    );
    prev = id;
    lastId = id;
  }
  return lastId;
}

describe("askAgentChainDepth", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS);
    const now = Math.floor(Date.now() / 1000);
    db.run(
      `INSERT INTO contexts (id, agent_name, title, created_at, updated_at)
       VALUES ('c', 'a', NULL, ?, ?)`,
      [now, now],
    );
  });

  test("root task has depth 0", () => {
    const id = seedTaskChain(db, 1);
    expect(askAgentChainDepth(db, id)).toBe(0);
  });

  test("chain of 5 — deepest has depth 4", () => {
    const id = seedTaskChain(db, 5);
    expect(askAgentChainDepth(db, id)).toBe(4);
  });

  test("MAX_ASK_AGENT_DEPTH is 5", () => {
    expect(MAX_ASK_AGENT_DEPTH).toBe(5);
  });
});
