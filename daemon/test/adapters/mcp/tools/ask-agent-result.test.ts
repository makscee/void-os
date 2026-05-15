import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../../../src/adapters/sqlite/migrations";
import { translateChildResult } from "../../../../src/adapters/mcp/tools/ask-agent-result";
import { AskAgentError } from "../../../../src/adapters/mcp/tools/ask-agent-errors";

const MIGRATIONS = join(
  import.meta.dir,
  "../../../../src/adapters/sqlite/migrations",
);

function seedChildCompleted(db: Database): void {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO contexts (id, agent_name, title, created_at, updated_at)
     VALUES ('c', 'a', NULL, ?, ?)`,
    [now, now],
  );
  db.run(
    `INSERT INTO tasks
       (id, context_id, parent_task_id, state,
        cost_usd, tokens_in, tokens_out, metadata,
        created_at, updated_at, target_agent)
     VALUES ('child', 'c', NULL, 'TASK_STATE_COMPLETED',
             0, 0, 0, '{}', ?, ?, 'b')`,
    [now, now],
  );
}

describe("translateChildResult", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS);
    seedChildCompleted(db);
  });

  test("COMPLETED with assistant text returns text content", () => {
    const parts = JSON.stringify([{ text: "Answer" }]);
    db.run(
      `INSERT INTO messages
         (task_id, context_id, run_id, role, parts, parts_text, ts, ord)
       VALUES ('child', 'c', NULL, 'ROLE_AGENT', ?, 'Answer', ?, 1)`,
      [parts, Date.now()],
    );
    const r = translateChildResult(db, "child", "TASK_STATE_COMPLETED", null);
    expect(r).toEqual({ content: [{ type: "text", text: "Answer" }] });
  });

  test("COMPLETED with no assistant message → (no message) fallback", () => {
    const r = translateChildResult(db, "child", "TASK_STATE_COMPLETED", null);
    expect(r).toEqual({ content: [{ type: "text", text: "(no message)" }] });
  });

  test("FAILED throws AskAgentError with child error", () => {
    expect(() =>
      translateChildResult(db, "child", "TASK_STATE_FAILED", "boom"),
    ).toThrow(AskAgentError);
    expect(() =>
      translateChildResult(db, "child", "TASK_STATE_FAILED", "boom"),
    ).toThrow(/child task failed: boom/);
  });

  test("CANCELED throws AskAgentError", () => {
    expect(() =>
      translateChildResult(db, "child", "TASK_STATE_CANCELED", null),
    ).toThrow(AskAgentError);
    expect(() =>
      translateChildResult(db, "child", "TASK_STATE_CANCELED", null),
    ).toThrow(/child task cancelled/);
  });
});
