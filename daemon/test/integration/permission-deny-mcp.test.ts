/**
 * VOS-108 T11: end-to-end integration test for the MCP boundary deny path.
 *
 * Boots a real Hono app via `buildApp`, binds a port via `Bun.serve`, then
 * connects a real MCP `Client` (StreamableHTTP transport) as `?agent=maya`.
 * `maya`'s seeded `agent_cards` row has `write_scope=[]`, so every vault.*
 * write tool must reject with `SCOPE_DENIED`.
 *
 * Asserts:
 *  - `vault.create` returns `{isError:true}` with first content text starting
 *    `SCOPE_DENIED:`
 *  - Target file was NOT created on disk
 *  - No orphan staging files left under `.void/tmp/`
 *
 * Schema mirrors `daemon/test/app-wiring.test.ts` (events + agent_cards only —
 * `buildApp` does not run migrations itself).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../../src/app.ts";

// Mirrors daemon/test/app-wiring.test.ts SCHEMA + adds the maya agent_card
// with empty write_scope. read_scope is permissive so the scope gate denies
// for the write reason, not for an unrelated missing-read-permission.
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
INSERT INTO agent_cards (agent_name, card_json) VALUES
  ('maya', '{"name":"maya","read_scope":["vault/**"],"write_scope":[]}');
`;

interface Ctx {
  vaultRoot: string;
  db: Database;
  server: { stop: () => void; port: number };
}

let ctx: Ctx;

beforeEach(async () => {
  const vaultRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "vos-108-itest-")),
  );
  fs.mkdirSync(path.join(vaultRoot, "journal"), { recursive: true });
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  const app = await buildApp({ db, vaultRoot });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  ctx = {
    vaultRoot,
    db,
    server: { stop: () => server.stop(true), port: server.port as number },
  };
});

afterEach(() => {
  ctx.server.stop();
  ctx.db.close();
  fs.rmSync(ctx.vaultRoot, { recursive: true, force: true });
});

describe("VOS-108 permission deny at MCP boundary (integration)", () => {
  test("vault.create as maya is rejected with SCOPE_DENIED and writes no file", async () => {
    const base = `http://127.0.0.1:${ctx.server.port}`;
    const transport = new StreamableHTTPClientTransport(
      new URL(`${base}/mcp?agent=maya`),
    );
    const client = new Client({ name: "vos-108-test", version: "0" });
    await client.connect(transport);

    const res = await client.callTool({
      name: "vault.create",
      arguments: { path: "journal/forbidden.md", content: "x" },
    });

    expect(res.isError).toBe(true);
    const content = res.content as Array<{ text: string }>;
    expect(content[0]!.text).toMatch(/^SCOPE_DENIED:/);

    // Disk side-effects: file MUST NOT exist; staging dir MUST be empty.
    expect(
      fs.existsSync(path.join(ctx.vaultRoot, "journal/forbidden.md")),
    ).toBe(false);
    const tmp = path.join(ctx.vaultRoot, ".void", "tmp");
    expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toEqual([]);

    await client.close();
  });
});
