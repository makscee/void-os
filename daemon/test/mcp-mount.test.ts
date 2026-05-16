import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mountMcp } from "../src/adapters/mcp/index.ts";
import { createEventBus } from "../src/events/index.ts";
import { createAskUserBridge } from "../src/chat/ask-user-bridge.ts";
import { createPermissionEngine, type AgentDefn } from "../src/permissions/engine.ts";

// Mirrors daemon/src/adapters/sqlite/migrations/0001_init.sql
const SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, chat_id TEXT, run_id TEXT, agent TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
`;

interface Ctx { vaultRoot: string; db: Database; app: Hono; server: { stop: () => void; port: number }; }

async function startApp(): Promise<Ctx> {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-"));
  fs.mkdirSync(path.join(vaultRoot, "notes"));
  fs.writeFileSync(path.join(vaultRoot, "notes", "hello.md"), "marker-xyzzy");
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  const app = new Hono();
  const bus = createEventBus({ db });
  const bridge = createAskUserBridge({ db, bus });
  const engine = createPermissionEngine({ vaultRoot: fs.realpathSync(vaultRoot), homeRoot: "/tmp/home" });
  // VOS-106: stub loadAgentDefn so /mcp?agent=test resolves to a permissive
  // AgentDefn without needing an agent_cards row. The scope ["vault/**"]
  // resolves against vaultRoot via the engine — permissive for these tests.
  const loadAgentDefn = (_name: string): AgentDefn => ({ name: "test", read_scope: ["vault/**"] });
  mountMcp(app, { vaultRoot: fs.realpathSync(vaultRoot), db, bus, bridge, engine, loadAgentDefn });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  return { vaultRoot, db, app, server: { stop: () => server.stop(true), port: server.port as number } };
}

describe("mountMcp /mcp", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await startApp(); });

  test("tools/list returns vault.read, ask_user, and ask_agent", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    // VOS-106: /mcp requires ?agent=<name> to resolve calling-agent identity.
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ctx.server.port}/mcp?agent=test`));
    await client.connect(transport);
    const { tools } = await client.listTools();
    // VOS-88 T7: ask_user joins vault.read on the tools list.
    // VOS-89 T10: ask_agent registered alongside.
    expect(tools.map((t) => t.name).sort()).toEqual(["ask_agent", "ask_user", "vault.read"]);
    await client.close();
    ctx.server.stop();
  });

  test("call vault.read returns file content", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ctx.server.port}/mcp?agent=test`));
    await client.connect(transport);
    const result = await client.callTool({ name: "vault.read", arguments: { path: "notes/hello.md" } });
    const content = result.content as Array<{ text: string }>;
    expect(content[0]!.text).toBe("marker-xyzzy");
    await client.close();
    // VOS-83: events persistence removed; vault.read no longer records rows.
    ctx.server.stop();
  });

  test("call vault.read on escaping path returns isError", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ctx.server.port}/mcp?agent=test`));
    await client.connect(transport);
    const result = await client.callTool({ name: "vault.read", arguments: { path: "../etc/passwd" } });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ text: string }>;
    expect(content[0]!.text).toContain("PATH_ESCAPES_VAULT_ROOT");
    await client.close();
    ctx.server.stop();
  });

  test("raw POST: initialize JSON-RPC envelope returns a parseable response", async () => {
    // Bypasses the SDK client — proves the body-handling path is correct
    // when a real Streamable-HTTP client POSTs a JSON-RPC envelope.
    const res = await fetch(`http://127.0.0.1:${ctx.server.port}/mcp?agent=test`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "raw", version: "0" },
        },
      }),
    });
    expect(res.status).toBeLessThan(400);
    const text = await res.text();
    // Streamable HTTP servers may return JSON or SSE — in both, "jsonrpc"
    // appears literally in the body.
    expect(text).toContain("\"jsonrpc\"");
    ctx.server.stop();
  });
});
