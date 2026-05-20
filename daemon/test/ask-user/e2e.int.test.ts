// VOS-88 T12: end-to-end ask_user round-trip via real MCP client + HTTP answer route.
//
// Path B (fallback per plan §T12): full daemon spawn + smoke-agent fixture
// would require building a daemon-as-library bootstrap + a fake LLM provider
// + a wired Claude-Code adapter — wider than the 30-min budget the plan
// authorised. Instead this test drives the orchestration boundary directly:
//
//   - One Hono app mounts BOTH `mountMcp` and `mountAnswerRoute`, sharing
//     a single AskUserBridge instance (VOS-100 T6 — replaces the deleted
//     module-singleton `pendingRegistry`). If the bridge is not shared the
//     test is meaningless — that's the thing the production composition
//     root in app.ts wires up.
//   - A real `@modelcontextprotocol/sdk` Client connects over
//     StreamableHTTPClientTransport to /mcp and issues a `callTool` for
//     `ask_user` with `task_id` injected into the arguments (matching the
//     production contract where the caller's runtime injects it; see
//     index.ts comment block).
//   - We poll the DB for `TASK_STATE_INPUT_REQUIRED` + read the
//     `pending_tool_use_id` from metadata, then POST to /chat/:id/answer
//     just as the UI would.
//   - The original `callTool` promise must resolve with
//     `{content:[{type:"text", text:<answer>}]}`, proving the full round
//     trip: tool call → state flip → answer route delivers → tool returns.
//
// Two cases: button answer ("yes") and free-text answer ("maybe"). Same
// loop, different answer payloads — what the UI distinguishes is purely
// presentational; the contract is "answer travels back as a text content
// block".

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations.ts";
import { mountMcp } from "../../src/adapters/mcp/index.ts";
import { mountAnswerRoute } from "../../src/api/answer.ts";
import { createAskUserBridge } from "../../src/chat/ask-user-bridge.ts";
import { createEventBus } from "../../src/events/index.ts";
import { createPermissionEngine } from "../../src/permissions/engine.ts";
import { createVaultWriter } from "../../src/vault/writer.ts";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";

const MIGRATIONS = join(import.meta.dir, "../../src/adapters/sqlite/migrations");

interface Ctx {
  db: Database;
  server: { stop: () => void; port: number };
}

async function startApp(): Promise<Ctx> {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS);
  // VOS-106 T7.5: mountMcp now resolves the calling agent from ?agent=<name>
  // via agent_cards.card_json, so seed a permissive "maya" card. The same
  // name flows through the MCP URL below.
  db.run(
    "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES ('maya', ?, 0)",
    [JSON.stringify({ name: "maya" })],
  );
  db.run(
    "INSERT INTO contexts (id, title, created_at) VALUES ('ctx', NULL, 0)",
  );
  db.run(
    "INSERT INTO tasks (id, context_id, state, cost_usd, tokens_in, tokens_out, metadata, created_at, updated_at) " +
      "VALUES ('t', 'ctx', 'TASK_STATE_WORKING', 0, 0, 0, '{}', 0, 0)",
  );
  db.run(
    "INSERT INTO runs (id, chat_id, task_id, agent, kind, status, started_at) " +
      "VALUES ('r', 'ctx', 't', 'maya', 'chat', 'running', 0)",
  );
  const bus = createEventBus({ db });
  // VOS-100 T6: same AskUserBridge instance MUST be shared between mountMcp
  // (which parks awaiters via bridge.open()) and mountAnswerRoute (which
  // resolves them via bridge.resolve()). If the test wired two separate
  // bridges the round-trip would deadlock — that's what the production
  // composition root (app.ts) guarantees by constructing one bridge and
  // threading it into both surfaces.
  const bridge = createAskUserBridge({ db, bus });
  // VOS-106 T7.5: mountMcp now requires a PermissionEngine for vault.read's
  // per-agent scope gate. ask_user doesn't hit the engine but the dep is
  // structurally required; build a permissive engine rooted at /tmp.
  // VOS-108: VaultWriter does realpathSync + mkdirSync on vaultRoot, so we
  // need a real directory. ask_user doesn't write to it, but the dep is
  // structurally required.
  const vaultRoot = realpathSync(mkdtempSync(join(tmpdir(), "vos-108-ask-user-")));
  const engine = createPermissionEngine({
    vaultRoot,
    homeRoot: "/tmp/home",
  });
  const writer = createVaultWriter({ vaultRoot, db });
  const app = new Hono();
  mountMcp(app, { vaultRoot, db, bus, bridge, engine, writer });
  mountAnswerRoute(app, { db, bridge });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  return { db, server: { stop: () => server.stop(true), port: server.port as number } };
}

async function waitForInputRequired(db: Database, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db.query("SELECT state, metadata FROM tasks WHERE id='t'").get() as
      | { state: string; metadata: string }
      | undefined;
    if (row && row.state === "TASK_STATE_INPUT_REQUIRED") {
      const md = JSON.parse(row.metadata) as { pending_tool_use_id?: string };
      if (md.pending_tool_use_id) return md.pending_tool_use_id;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("TIMEOUT: task never entered TASK_STATE_INPUT_REQUIRED");
}

async function runRoundTrip(answer: string) {
  const ctx = await startApp();
  try {
    const client = new Client({ name: "test-e2e", version: "0.0.0" });
    // VOS-106 T7.5: /mcp now requires ?agent=<name> so the daemon can resolve
    // the calling agent's read_scope before instantiating tool handlers.
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${ctx.server.port}/mcp?agent=maya`),
    );
    await client.connect(transport);

    // Kick off the MCP ask_user call. Do NOT await — the server side will
    // park on `pending.register(tu).promise` until we POST the answer.
    const callPromise = client.callTool({
      name: "ask_user",
      arguments: {
        question: "ok?",
        options: ["yes", "no"],
      },
      _meta: {
        task_id: "t",
        context_id: "ctx",
        run_id: "r",
      },
    });

    // Wait for the daemon to flip the task into INPUT_REQUIRED and surface
    // the tool_use_id via tasks.metadata (same path the UI reads).
    const tuid = await waitForInputRequired(ctx.db);

    // Post the answer through the production HTTP route.
    const res = await fetch(`http://127.0.0.1:${ctx.server.port}/chat/ctx/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_use_id: tuid, answer }),
    });
    expect(res.status).toBe(200);

    // The original tool call must now resolve with the answer as text.
    const result = await callPromise;
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toBe(answer);

    // Task must be back to WORKING; pending cleared.
    const row = ctx.db
      .query("SELECT state, metadata FROM tasks WHERE id='t'")
      .get() as { state: string; metadata: string };
    expect(row.state).toBe("TASK_STATE_WORKING");
    expect(JSON.parse(row.metadata).pending_tool_use_id).toBeUndefined();

    // Tool_result message landed on the task.
    const msg = ctx.db
      .query(
        "SELECT role, parts FROM messages WHERE task_id='t' ORDER BY ord DESC LIMIT 1",
      )
      .get() as { role: string; parts: string };
    expect(msg.role).toBe("ROLE_USER");
    const parts = JSON.parse(msg.parts) as Array<{
      data?: { kind?: string; output?: string; tool_call_id?: string };
    }>;
    expect(parts[0]?.data?.kind).toBe("tool_result");
    expect(parts[0]?.data?.output).toBe(answer);
    expect(parts[0]?.data?.tool_call_id).toBe(tuid);

    await client.close();
  } finally {
    ctx.server.stop();
  }
}

describe("ask_user E2E (MCP client ↔ answer route, shared PendingRegistry)", () => {
  // VOS-97 T6: ids now travel on `params._meta` (per ADR-0002 §"Caller-side
  // _meta injection"). The MCP SDK Client.callTool forwards the full params
  // shape into the JSON-RPC envelope, which the SDK server-side transport
  // parses out into RequestHandlerExtra._meta. The hono bridge is a byte
  // pipe — it never touches the body shape, so no bridge-side change is
  // needed for forwarding to work.
  it("button answer 'yes' round trip", async () => {
    await runRoundTrip("yes");
  });

  it("free-text 'maybe' round trip", async () => {
    await runRoundTrip("maybe");
  });
});
