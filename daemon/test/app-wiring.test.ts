import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Database } from "bun:sqlite";
import { buildApp } from "../src/app.ts";

// Mirrors daemon/src/adapters/sqlite/migrations/0001_init.sql
const SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, chat_id TEXT, run_id TEXT, agent TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
`;

describe("buildApp wires /mcp alongside /health", () => {
  test("GET /health still works", async () => {
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    const db = new Database(":memory:"); db.exec(SCHEMA);
    const app = buildApp({ db, vaultRoot });
    const res = await app.fetch(new Request("http://x/health"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("POST /mcp returns a valid JSON-RPC response shape", async () => {
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    const db = new Database(":memory:"); db.exec(SCHEMA);
    const app = buildApp({ db, vaultRoot });
    const res = await app.fetch(
      new Request("http://x/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
        }),
      }),
    );
    // Either 200 with JSON body or 200 SSE — both acceptable, both fail the old stub.
    expect(res.status).toBeLessThan(400);
    const text = await res.text();
    expect(text).toContain("\"jsonrpc\"");
  });
});
