// workspace/void-os/daemon/test/migration-0013.test.ts
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrationsFromDir } from "../src/adapters/sqlite/migrations";
import * as path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../src/adapters/sqlite/migrations");

describe("migration 0013 — tasks.parent_tool_call_id", () => {
  it("adds nullable parent_tool_call_id column", () => {
    const db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS_DIR);
    const cols = db.query("PRAGMA table_info(tasks)").all() as Array<{
      name: string; type: string; notnull: number; dflt_value: unknown;
    }>;
    const col = cols.find((c) => c.name === "parent_tool_call_id");
    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
  });

  it("accepts NULL for existing rows + a value for new rows", () => {
    const db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS_DIR);
    const now = Date.now();
    db.run(
      `INSERT INTO contexts (id, title, created_at) VALUES (?, NULL, ?)`,
      ["ctx-1", now],
    );
    db.run(
      `INSERT INTO tasks (id, context_id, state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at)
         VALUES (?, ?, 'TASK_STATE_WORKING', 0, 0, 0, '{}', ?, ?)`,
      ["task-parent", "ctx-1", now, now],
    );
    db.run(
      `INSERT INTO tasks (id, context_id, parent_task_id, parent_tool_call_id, state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'TASK_STATE_SUBMITTED', 0, 0, 0, '{}', ?, ?)`,
      ["task-child", "ctx-1", "task-parent", "tool-call-abc", now, now],
    );
    const parent = db.query("SELECT parent_tool_call_id FROM tasks WHERE id=?")
      .get("task-parent") as { parent_tool_call_id: string | null };
    const child = db.query("SELECT parent_tool_call_id FROM tasks WHERE id=?")
      .get("task-child") as { parent_tool_call_id: string | null };
    expect(parent.parent_tool_call_id).toBeNull();
    expect(child.parent_tool_call_id).toBe("tool-call-abc");
  });
});
