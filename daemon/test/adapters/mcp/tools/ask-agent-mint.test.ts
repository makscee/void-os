import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../../../src/adapters/sqlite/migrations";
import { mintChildAndFlipParent } from "../../../../src/adapters/mcp/tools/ask-agent-mint";
import { AskAgentError } from "../../../../src/adapters/mcp/tools/ask-agent-errors";

const MIGRATIONS = join(
  import.meta.dir,
  "../../../../src/adapters/sqlite/migrations",
);

function seedContextAndParent(
  db: Database,
  parentState: string = "TASK_STATE_WORKING",
): { contextId: string; parentId: string } {
  const now = Math.floor(Date.now() / 1000);
  const contextId = "ctx-1";
  const parentId = "parent-1";
  db.run(
    `INSERT INTO contexts (id, agent_name, title, created_at, updated_at)
     VALUES (?, 'a', NULL, ?, ?)`,
    [contextId, now, now],
  );
  db.run(
    `INSERT INTO tasks
       (id, context_id, parent_task_id, state,
        cost_usd, tokens_in, tokens_out, metadata,
        created_at, updated_at, target_agent)
     VALUES (?, ?, NULL, ?,
             0, 0, 0, '{}', ?, ?, NULL)`,
    [parentId, contextId, parentState, now, now],
  );
  return { contextId, parentId };
}

describe("mintChildAndFlipParent", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS);
  });

  test("happy path: mints child + flips parent atomically", () => {
    const { contextId, parentId } = seedContextAndParent(db);

    const childId = "child-1";
    mintChildAndFlipParent(db, {
      childId,
      contextId,
      parentId,
      targetAgent: "journaler",
    });

    const child = db
      .query("SELECT id, context_id, parent_task_id, state, target_agent FROM tasks WHERE id = ?")
      .get(childId) as {
      id: string;
      context_id: string;
      parent_task_id: string;
      state: string;
      target_agent: string;
    };
    expect(child.id).toBe(childId);
    expect(child.context_id).toBe(contextId);
    expect(child.parent_task_id).toBe(parentId);
    expect(child.state).toBe("TASK_STATE_SUBMITTED");
    expect(child.target_agent).toBe("journaler");

    const parent = db
      .query("SELECT state FROM tasks WHERE id = ?")
      .get(parentId) as { state: string };
    expect(parent.state).toBe("TASK_STATE_WAITING_ON_AGENT");
  });

  test("parent not in WORKING: throws AskAgentError + no orphan child", () => {
    const { contextId, parentId } = seedContextAndParent(
      db,
      "TASK_STATE_INPUT_REQUIRED",
    );

    const childId = "child-2";
    expect(() =>
      mintChildAndFlipParent(db, {
        childId,
        contextId,
        parentId,
        targetAgent: "journaler",
      }),
    ).toThrow(AskAgentError);

    const childRow = db
      .query("SELECT id FROM tasks WHERE id = ?")
      .get(childId);
    expect(childRow).toBeNull();

    const parent = db
      .query("SELECT state FROM tasks WHERE id = ?")
      .get(parentId) as { state: string };
    expect(parent.state).toBe("TASK_STATE_INPUT_REQUIRED");
  });
});
