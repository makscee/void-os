import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Database } from "bun:sqlite";
import { buildApp } from "../src/app.ts";

// Mirrors daemon/src/adapters/sqlite/migrations/0001_init.sql
// VOS-106 T7.5: also seed `agent_cards` so the mountMcp ?agent=<name> resolver
// can load a permissive AgentDefn — tests don't run full migrations here.
const SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, chat_id TEXT, run_id TEXT, agent TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE agent_cards (
  agent_name TEXT PRIMARY KEY,
  card_json TEXT NOT NULL,
  source_mtime INTEGER NOT NULL DEFAULT 0
);
INSERT INTO agent_cards (agent_name, card_json) VALUES ('test', '{"name":"test"}');
`;

describe("buildApp wires /mcp alongside /health", () => {
  test("GET /health still works", async () => {
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    const db = new Database(":memory:"); db.exec(SCHEMA);
    const app = await buildApp({ db, vaultRoot });
    const res = await app.fetch(new Request("http://x/health"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("POST /mcp returns a valid JSON-RPC response shape", async () => {
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    const db = new Database(":memory:"); db.exec(SCHEMA);
    const app = await buildApp({ db, vaultRoot });
    // VOS-106 T7.5: /mcp now requires ?agent=<name> for calling-agent
    // resolution; mountMcp 400s without it. Use the seeded "test" card.
    const res = await app.fetch(
      new Request("http://x/mcp?agent=test", {
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
