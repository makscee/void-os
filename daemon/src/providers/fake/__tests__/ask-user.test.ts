import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventBus } from "../../../events/index.ts";
import { mountMcp } from "../../../adapters/mcp/index.ts";
import { mountAnswerRoute } from "../../../api/answer.ts";
import { createAskUserBridge } from "../../../chat/ask-user-bridge.ts";
import { createPermissionEngine } from "../../../permissions/engine.ts";
import { createVaultWriter } from "../../../vault/writer.ts";
import { realpathSync } from "node:fs";
import { runMigrationsFromDir } from "../../../adapters/sqlite/migrations.ts";
import { makeFakeProvider } from "../index.ts";
import type { ProviderSpawnRequest } from "../../types.ts";

const MIGRATIONS = join(import.meta.dir, "../../../adapters/sqlite/migrations");

// VOS-100 T6: migration 0010 uses the void-os:fk-rebuild rename-rebuild-copy
// pattern that requires `PRAGMA foreign_keys = OFF` outside the surrounding
// transaction. Using runMigrationsFromDir (which honors that marker) instead
// of a naive `for f of files; exec(...)` loop is what keeps the seed below
// from blowing up on `no such table: tasks_old`.
function migrate(db: Database) {
  runMigrationsFromDir(db, MIGRATIONS);
}

interface Ctx { db: Database; port: number; stop: () => void; scriptDir: string; }

async function start(): Promise<Ctx> {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  // VOS-106 T7.5: mountMcp resolves the calling agent from ?agent=<name>
  // via agent_cards.card_json. Seed a permissive maya card.
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
  // VOS-100 T6: same bridge instance must be shared between mountMcp (which
  // parks awaiters in open()) and mountAnswerRoute (which resolves them).
  // If the test wired two separate bridges the round-trip would deadlock.
  const bridge = createAskUserBridge({ db, bus });
  // VOS-106 T7.5: mountMcp requires a PermissionEngine for vault.read scope
  // gating. ask_user does not exercise the engine, but the dep is required.
  // VOS-108: VaultWriter does realpathSync + mkdirSync on vaultRoot, so we
  // need a real directory. ask_user doesn't write to it.
  const vaultRoot = realpathSync(mkdtempSync(join(tmpdir(), "vos-108-fake-ask-")));
  const engine = createPermissionEngine({
    vaultRoot,
    homeRoot: "/tmp/home",
  });
  const writer = createVaultWriter({ vaultRoot, db });
  const app = new Hono();
  mountMcp(app, { vaultRoot, db, bus, bridge, engine, writer });
  mountAnswerRoute(app, { db, bridge });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const scriptDir = mkdtempSync(join(tmpdir(), "fake-ask-"));
  return { db, port: server.port as number, stop: () => server.stop(true), scriptDir };
}

describe("fake provider vos_ask_user directive", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await start(); });
  afterEach(() => { ctx.stop(); });

  it("yields a tool_use block + waits for /answer + emits assistant text using the answer", async () => {
    const script = ctx.scriptDir + "/ask.jsonl";
    writeFileSync(
      script,
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "fake-ask" }),
        JSON.stringify({ type: "vos_ask_user", question: "color?", options: ["red", "blue"] }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "chose ${answer}" }] } }),
      ].join("\n"),
    );
    const provider = makeFakeProvider({
      scriptPath: script,
      daemonBase: `http://127.0.0.1:${ctx.port}`,
    });
    const spawnReq: ProviderSpawnRequest & { taskId: string; contextId: string; agent: string } = {
      runId: "r",
      prompt: "",
      cwd: "/tmp",
      taskId: "t",
      contextId: "ctx",
      agent: "maya",
    };
    const handle = provider.spawn(spawnReq);

    // Drain events; when we see the tool_use DataPart, fire /answer.
    //
    // VOS-100 T6: the fake provider yields canonical events (VOS-96), shape:
    //   { type: "parts", role: "ROLE_AGENT", parts: [{ data: { kind: "tool_use", tool_call_id, ... }}], ts }
    // The previous matcher looked for legacy `{type:"assistant",message:{content:[...]}}`
    // and silently never matched — the test was timing out because the answer
    // POST was never sent. The /answer route must reach `bridge.resolve()`
    // with the right tool_use_id for the round-trip to complete.
    const events: unknown[] = [];
    let answered = false;
    for await (const ev of handle.events) {
      events.push(ev);
      if (answered) continue;
      const e = ev as { type?: string; parts?: Array<{ data?: { kind?: string; tool_call_id?: string } }> };
      if (e.type !== "parts" || !Array.isArray(e.parts)) continue;
      const toolUsePart = e.parts.find(
        (p) => p?.data?.kind === "tool_use" && typeof p.data.tool_call_id === "string",
      );
      const toolUseId = toolUsePart?.data?.tool_call_id;
      if (!toolUseId) continue;
      answered = true;
      const res = await fetch(`http://127.0.0.1:${ctx.port}/chat/ctx/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool_use_id: toolUseId, answer: "red" }),
      });
      expect(res.status).toBe(200);
    }
    const done = await handle.done;
    expect(done.reason).toBe("exit");
    // The final canonical "parts" event must have substituted ${answer} with
    // the user's reply. Canonical parts carry text as `{text: string}` rather
    // than the legacy `{type:"text", text}` block.
    const last = events[events.length - 1] as {
      type: string;
      role: string;
      parts: Array<{ text?: string }>;
    };
    expect(last.type).toBe("parts");
    expect(last.role).toBe("ROLE_AGENT");
    expect(last.parts[0]?.text).toBe("chose red");
  });
});
