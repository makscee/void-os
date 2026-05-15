// VOS-80 S5: integration test — POST /chat/:id/cancel.
//
// Drives buildApp with an injected orchestrator that has a real `cancel()`
// method, and verifies HTTP status mapping:
//   200 + {run_id, status:"cancelled"} on success
//   409 + {error:"no_active_run"}      when no run is in flight (idempotent)
//   404 + {error:"not_found"}          when chat does not exist

import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../../src/app.ts";
import { makeOrchestrator } from "../../src/chat/orchestrator.ts";
import type { Provider, ProviderHandle, ProviderSpawnRequest } from "../../src/providers/index.ts";
import { makeChatRepo } from "../../src/chat/repo.ts";

const MIGRATIONS_DIR = join(
  __dirname,
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);

function freshDb(): Database {
  const db = new Database(":memory:");
  for (const m of [
    "0001_init.sql",
    "0002_runs_columns.sql",
    "0003_chat_lifecycle.sql",
    "0004_messages.sql",
  ]) {
    db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }
  return db;
}

async function bootstrap() {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const provider: Provider = {
    name: "cancel-test",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      let killed = false;
      const events_ = (async function* () {
        yield { type: "system", session_id: "sid-cancel" };
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial " }],
          },
        };
        while (!killed) {
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
      return {
        events: events_,
        cancel: async () => { killed = true; return true; },
        done: Promise.resolve({ reason: "cancel" as const }),
      };
    },
  };

  const events: Array<{ t: string; p: any }> = [];
  const orchestrator = makeOrchestrator({
    db,
    repo,
    provider,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });

  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const app = await buildApp({
    db,
    vaultRoot,
    orchestrator,
    titler: { title: async () => {} },
  });

  return { app, db, repo, events, orchestrator };
}

test("POST /chat/:id/cancel — 404 when chat does not exist", async () => {
  const { app } = await bootstrap();
  const res = await app.request("/chat/no-such/cancel", { method: "POST" });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not_found");
});

test("POST /chat/:id/cancel — 409 when no run is in flight", async () => {
  const { app } = await bootstrap();
  const create = (await (
    await app.request("/chats", {
      method: "POST",
      body: JSON.stringify({ agent: "maya" }),
      headers: { "content-type": "application/json" },
    })
  ).json()) as { id: string };

  const res = await app.request(`/chat/${create.id}/cancel`, {
    method: "POST",
  });
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("no_active_run");
});

test("POST /chat/:id/cancel — 200 cancels an in-flight run + idempotent 409 after", async () => {
  const { app, events } = await bootstrap();
  const create = (await (
    await app.request("/chats", {
      method: "POST",
      body: JSON.stringify({ agent: "maya" }),
      headers: { "content-type": "application/json" },
    })
  ).json()) as { id: string };

  // Kick off message — do NOT await; let it park in the spawner.
  const dispatchP = app.request(`/chat/${create.id}/message`, {
    method: "POST",
    body: JSON.stringify({ text: "go" }),
    headers: { "content-type": "application/json" },
  });

  // Wait until orchestrator has emitted chat.token (run is actually in flight).
  const start = Date.now();
  while (!events.some((e) => e.t === "chat.token")) {
    if (Date.now() - start > 2000) throw new Error("timeout: no chat.token");
    await new Promise((r) => setTimeout(r, 5));
  }

  // Cancel
  const res = await app.request(`/chat/${create.id}/cancel`, {
    method: "POST",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { run_id: string; status: string };
  expect(body.status).toBe("cancelled");
  expect(typeof body.run_id).toBe("string");

  // Original dispatch finalises.
  await dispatchP;

  // Idempotent: second cancel after the run has already terminated → 409.
  const res2 = await app.request(`/chat/${create.id}/cancel`, {
    method: "POST",
  });
  expect(res2.status).toBe(409);

  // run.end frame fired with status="cancelled".
  const runEnds = events.filter((e) => e.t === "run.end");
  expect(runEnds.length).toBe(1);
  expect(runEnds[0]!.p.status).toBe("cancelled");
});
