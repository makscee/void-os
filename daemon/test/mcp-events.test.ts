import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { recordMcpEvent } from "../src/adapters/mcp/events.ts";

// Mirrors daemon/src/adapters/sqlite/migrations/0001_init.sql
const SCHEMA = `
CREATE TABLE events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  chat_id TEXT,
  run_id  TEXT,
  agent   TEXT,
  type    TEXT    NOT NULL,
  data    TEXT    NOT NULL DEFAULT '{}'
);
`;

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

describe("recordMcpEvent", () => {
  test("inserts a successful tool-call row", () => {
    const db = freshDb();
    recordMcpEvent(db, {
      tool: "vault.read",
      input: { path: "notes/x.md" },
      ok: true,
      result_sha: "abc123",
      run_id: "r-1",
    });
    const row = db.prepare("SELECT type, agent, run_id, data FROM events").get() as {
      type: string; agent: string; run_id: string; data: string;
    };
    expect(row.type).toBe("mcp.vault.read");
    expect(row.agent).toBe("mcp");
    expect(row.run_id).toBe("r-1");
    const data = JSON.parse(row.data);
    expect(data).toEqual({
      input: { path: "notes/x.md" },
      ok: true,
      error_code: null,
      result_sha: "abc123",
    });
  });

  test("inserts an error row with error_code", () => {
    const db = freshDb();
    recordMcpEvent(db, {
      tool: "vault.read",
      input: { path: "../etc/passwd" },
      ok: false,
      error_code: "PATH_ESCAPES_VAULT_ROOT",
    });
    const data = JSON.parse(
      (db.prepare("SELECT data FROM events").get() as { data: string }).data,
    );
    expect(data.ok).toBe(false);
    expect(data.error_code).toBe("PATH_ESCAPES_VAULT_ROOT");
    expect(data.result_sha).toBeNull();
  });

  test("null run_id when not provided", () => {
    const db = freshDb();
    recordMcpEvent(db, { tool: "vault.read", input: {}, ok: true });
    const row = db.prepare("SELECT run_id FROM events").get() as { run_id: string | null };
    expect(row.run_id).toBeNull();
  });

  test("ts is an integer milliseconds value (matches 0001_init.sql column type)", () => {
    const db = freshDb();
    const before = Date.now();
    recordMcpEvent(db, { tool: "vault.read", input: {}, ok: true });
    const after = Date.now();
    const row = db.prepare("SELECT ts FROM events").get() as { ts: number };
    expect(Number.isInteger(row.ts)).toBe(true);
    expect(row.ts).toBeGreaterThanOrEqual(before);
    expect(row.ts).toBeLessThanOrEqual(after);
  });
});
