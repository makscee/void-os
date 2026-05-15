import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventBus } from "../../../events/index.ts";
import { mountMcp, pendingRegistry } from "../../../adapters/mcp/index.ts";
import { mountAnswerRoute } from "../../../api/answer.ts";
import { makeFakeProvider } from "../index.ts";
import type { ProviderSpawnRequest } from "../../types.ts";

const MIGRATIONS = join(import.meta.dir, "../../../adapters/sqlite/migrations");

function migrate(db: Database) {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
}

interface Ctx { db: Database; port: number; stop: () => void; scriptDir: string; }

async function start(): Promise<Ctx> {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  db.run(
    "INSERT INTO contexts (id, agent_name, title, created_at, updated_at, archived) VALUES ('ctx', 'maya', NULL, 0, 0, 0)",
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
  const app = new Hono();
  mountMcp(app, { vaultRoot: "/tmp/__not_used__", db, bus });
  mountAnswerRoute(app, { db, bus, pending: pendingRegistry });
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

    // Drain events; when we see the tool_use, fire /answer.
    const events: unknown[] = [];
    let answered = false;
    for await (const ev of handle.events) {
      events.push(ev);
      if (!answered && (ev as { type: string }).type === "assistant") {
        const content = (ev as { message: { content: Array<{ type: string }> } }).message.content;
        const toolUse = content.find((c) => c.type === "tool_use") as { id?: string } | undefined;
        if (toolUse?.id) {
          answered = true;
          const res = await fetch(`http://127.0.0.1:${ctx.port}/chat/ctx/answer`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tool_use_id: toolUse.id, answer: "red" }),
          });
          expect(res.status).toBe(200);
        }
      }
    }
    const done = await handle.done;
    expect(done.reason).toBe("exit");
    // The final assistant event must have substituted ${answer} with the user's reply.
    const last = events[events.length - 1] as { type: string; message: { content: Array<{ text: string }> } };
    expect(last.type).toBe("assistant");
    expect(last.message.content[0]?.text).toBe("chose red");
  });
});
