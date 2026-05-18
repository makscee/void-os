// Asserts migration 0007 produces the A2A target schema (spec §4).
import { describe, it, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { applyMigrations, loadMigrations } from "../src/adapters/sqlite/migrations";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/adapters/sqlite/migrations");

const introspect = (db: Database, table: string) =>
  db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
    dflt_value: string | null;
  }>;

const fkList = (db: Database, table: string) =>
  db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>;

describe("migration 0007 — A2A schema alignment", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    // Scope to first 7 migrations: this file asserts that 0007 alone lands
    // the narrow v1 CHECK enum on tasks.state. Later migrations (e.g. 0010)
    // legitimately expand that enum and would otherwise invalidate the
    // CHECK-enforcement assertions below.
    const migrations = loadMigrations(MIGRATIONS_DIR).filter(
      (m) => m.version.slice(0, 4) <= "0007",
    );
    applyMigrations(db, migrations);
  });

  it("drops legacy tables", () => {
    // 0007 drops `events` and `agents` (the legacy event-log + agent-list
    // surfaces replaced by the A2A schema). `plans` never existed in this
    // schema lineage. 0008 recreates `agents` (AgentRepo still targets the
    // v1 shape), but this file scopes to <=0007, so `agents` is absent here.
    const droppedTables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('events','agents')",
    ).all();
    expect(droppedTables).toEqual([]);
  });

  it("creates `contexts` with target schema", () => {
    const cols = introspect(db, "contexts").map((c) => c.name).sort();
    expect(cols).toEqual([
      "agent_name","archived","created_at","current_run_id","id","session_id","title","updated_at",
    ]);
  });

  it("creates `tasks` with narrow v1 state CHECK", () => {
    const cols = introspect(db, "tasks").map((c) => c.name).sort();
    expect(cols).toEqual([
      "context_id","cost_usd","created_at","id","metadata","parent_task_id",
      "state","tokens_in","tokens_out","updated_at",
    ]);
    // CHECK enforcement: terminal states must reject.
    db.exec(`INSERT INTO contexts (id, agent_name, created_at, updated_at)
             VALUES ('c1','maya', strftime('%s','now')*1000, strftime('%s','now')*1000)`);
    expect(() =>
      db.exec(`INSERT INTO tasks (id, context_id, state, created_at, updated_at)
               VALUES ('t1','c1','TASK_STATE_COMPLETED', 0, 0)`)
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(`INSERT INTO tasks (id, context_id, state, created_at, updated_at)
               VALUES ('t2','c1','TASK_STATE_WORKING', 0, 0)`)
    ).not.toThrow();
  });

  it("creates `artifacts` keyed on task_id", () => {
    const cols = introspect(db, "artifacts").map((c) => c.name).sort();
    expect(cols).toEqual(["created_at","id","name","task_id","vault_path"]);
  });

  it("creates `agent_cards`", () => {
    const cols = introspect(db, "agent_cards").map((c) => c.name).sort();
    expect(cols).toEqual(["agent_name","card_json","source_mtime"]);
  });

  it("recreates `messages` with A2A 2-role + parts JSON", () => {
    const cols = introspect(db, "messages").map((c) => c.name).sort();
    expect(cols).toEqual([
      "context_id","id","ord","parts","parts_text","role","run_id","task_id","ts",
    ]);
    expect(() =>
      db.exec(`INSERT INTO messages (task_id, context_id, role, parts, ts, ord)
               VALUES ('t2','c1','assistant','[]', 0, 0)`)
    ).toThrow(/CHECK/);
  });

  it("extends `runs` with task_id FK", () => {
    const fk = fkList(db, "runs");
    expect(fk.some((f) => f.from === "task_id" && f.table === "tasks")).toBe(true);
  });

  it("rewrites `runs.chat_id` FK to point at renamed `contexts`", () => {
    const fk = fkList(db, "runs");
    expect(fk.some((f) => f.from === "chat_id" && f.table === "contexts")).toBe(true);
  });

  it("creates required indexes", () => {
    const wanted = [
      "idx_tasks_context","idx_tasks_parent",
      "idx_artifacts_task","idx_artifacts_created",
      "idx_messages_task","idx_messages_context","idx_messages_run",
      "idx_runs_task","idx_contexts_updated",
    ];
    const all = db.query(
      "SELECT name FROM sqlite_master WHERE type='index'"
    ).all() as Array<{ name: string }>;
    const names = new Set(all.map((r) => r.name));
    for (const w of wanted) expect(names.has(w)).toBe(true);
  });

  it("foreign_key_check is clean after migration", () => {
    const violations = db.query("PRAGMA foreign_key_check").all();
    expect(violations).toEqual([]);
  });
});
