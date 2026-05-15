// VOS-79 T11: End-to-end integration test — full chat flow.
//
// Drives the entire chat-lifecycle pipeline through buildApp + Hono's
// app.request() (no port binding), using a stubbed Spawner (AsyncIterable
// of canned events) and a stubbed Anthropic SDK (returns a fixed title).
// Verifies:
//   - POST /chats response shape
//   - POST /chat/:id/message → orchestrator emits chat.* and run.* events
//     in the documented order
//   - sessionCaptured fires exactly once (setSession spy)
//   - titler runs on first turn → chats.title populated
//   - GET /chats reflects last_run_status='done' and the new title
//   - bootRecovery flips orphan running runs to interrupted on restart
//
// Concurrency / Conflict409 mapping is covered at the orchestrator layer
// in test/chat/orchestrator.test.ts and at the HTTP layer in
// test/integration/chats-routes.test.ts. The plan-spec T11 originally
// included a duplicate concurrency assertion; per the task brief that
// assertion now lives in the orchestrator suite (T7), so this file
// focuses on happy-path end-to-end signal.
//
// Hermetic by design: no real claudev process spawn, no real SDK call,
// no real WebSocket. The Anthropic SDK and CcSpawner are bypassed by
// injecting `orchestrator` + `titler` into buildApp.

import { test, expect, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../../src/app.ts";
import { makeOrchestrator } from "../../src/chat/orchestrator.ts";
import type { Provider, ProviderEvent, ProviderHandle, ProviderSpawnRequest } from "../../src/providers/index.ts";
import { makeChatRepo } from "../../src/chat/repo.ts";
import { bootRecovery } from "../../src/boot.ts";

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

/**
 * Canned provider: emits a `system` event with a stable session_id, then
 * two `assistant` deltas concatenating to "hello back", then ends. Captures
 * the args it was called with for resume-arg assertions.
 */
function cannedProvider(sessionId: string) {
  const calls: Array<{ chatId: string | undefined; resumeFrom: string | undefined; prompt: string }> = [];
  const provider: Provider & { calls: typeof calls } = {
    name: "canned",
    get calls() { return calls; },
    spawn(req: ProviderSpawnRequest): ProviderHandle {
      calls.push({ chatId: req.chatId, resumeFrom: req.resumeFrom, prompt: req.prompt });
      const events = (async function* () {
        yield { type: "system", session_id: sessionId };
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello " }],
          },
        };
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "back" }],
          },
        };
      })();
      return {
        events,
        cancel: async () => false,
        done: Promise.resolve({ reason: "exit" as const, exitCode: 0 }),
      };
    },
  };
  return provider;
}

test("full chat lifecycle: create → message → events streamed → title set → list reflects state", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos79-e2e-"));

  // Event sink shared by orchestrator + titler stub. In production this
  // is `broadcast()` which fans to /events sockets (covered by T9).
  const events: Array<{ t: string; p: Record<string, unknown> }> = [];
  const emit = (t: string, p: Record<string, unknown>): void => {
    events.push({ t, p });
  };

  // Stubbed SDK reply for titler — never reached because we inject a
  // titler stub directly, but kept for documentation of contract.
  const titlerTitle = mock(async (chatId: string): Promise<void> => {
    // Mirror real titler behavior: setTitle + emit chat.title.
    const ok = repo.setTitle(chatId, "Hello Greeting");
    if (ok) emit("chat.title", { chat_id: chatId, title: "Hello Greeting" });
  });
  const titlerStub = { title: titlerTitle };

  // Spy on setSession to assert sessionCaptured fires exactly once.
  const setSessionSpy = mock(repo.setSession.bind(repo));
  const wrappedRepo = { ...repo, setSession: setSessionSpy };

  const spawner = cannedProvider("sid-e2e-1");
  const orchestrator = makeOrchestrator({
    db,
    repo: wrappedRepo,
    provider: spawner,
    cwd: "/tmp",
    emit,
    titler: titlerStub,
  });

  const app = await buildApp({
    db,
    vaultRoot,
    orchestrator,
    titler: titlerStub,
    emit,
  });

  // ── Step 1: POST /chats ────────────────────────────────────────────
  const createRes = await app.request("/chats", {
    method: "POST",
    body: JSON.stringify({ agent: "maya" }),
    headers: { "content-type": "application/json" },
  });
  expect(createRes.status).toBe(200);
  const created = (await createRes.json()) as {
    id: string;
    title: string | null;
    created_at: number;
  };
  expect(created.id).toBeTruthy();
  expect(created.title).toBeNull();
  expect(typeof created.created_at).toBe("number");

  // ── Step 2: POST /chat/:id/message ─────────────────────────────────
  const msgRes = await app.request(`/chat/${created.id}/message`, {
    method: "POST",
    body: JSON.stringify({ text: "hello" }),
    headers: { "content-type": "application/json" },
  });
  expect(msgRes.status).toBe(200);
  const dispatch = (await msgRes.json()) as {
    run_id: string;
    status: string;
  };
  expect(dispatch.status).toBe("done");
  expect(dispatch.run_id).toBeTruthy();

  // Provider was called with resumeFrom=undefined (first turn) and the user text.
  expect(spawner.calls.length).toBe(1);
  expect(spawner.calls[0]!.chatId).toBe(created.id);
  expect(spawner.calls[0]!.resumeFrom ?? null).toBeNull();
  expect(spawner.calls[0]!.prompt).toBe("hello");

  // ── Step 3: assert event sequence on the sink (what WS would see) ──
  const types = events.map((e) => e.t);
  // Required ordering: message_user before run.start before any token,
  // and run.end last (authoritative terminal frame).
  expect(types).toContain("chat.message_user");
  expect(types).toContain("run.start");
  expect(types).toContain("chat.token");
  expect(types).toContain("run.end");

  expect(types.indexOf("chat.message_user")).toBeLessThan(
    types.indexOf("run.start"),
  );
  expect(types.indexOf("run.start")).toBeLessThan(
    types.indexOf("chat.token"),
  );
  expect(types.indexOf("chat.token")).toBeLessThan(
    types.indexOf("run.end"),
  );

  // Token deltas concatenate to the streamed assistant text.
  const tokens = events
    .filter((e) => e.t === "chat.token")
    .map((e) => e.p.delta as string);
  expect(tokens.join("")).toBe("hello back");

  // run.end carries status='done'.
  const runEnd = events.find((e) => e.t === "run.end")!;
  expect(runEnd.p.status).toBe("done");
  expect(runEnd.p.run_id).toBe(dispatch.run_id);

  // ── Step 4: sessionCaptured fired exactly once ─────────────────────
  expect(setSessionSpy).toHaveBeenCalledTimes(1);
  expect(setSessionSpy.mock.calls[0]![0]).toBe(created.id);
  expect(setSessionSpy.mock.calls[0]![1]).toBe("sid-e2e-1");
  // Canonical row reflects it.
  expect(repo.get(created.id)!.session_id).toBe("sid-e2e-1");

  // ── Step 5: titler fire-and-forget completed; title is set ─────────
  // Orchestrator awaits nothing; give the microtask queue a beat.
  await new Promise((r) => setTimeout(r, 10));
  expect(titlerTitle).toHaveBeenCalledTimes(1);
  expect(repo.get(created.id)!.title).toBe("Hello Greeting");
  const titleEvt = events.find((e) => e.t === "chat.title");
  expect(titleEvt).toBeTruthy();
  expect(titleEvt!.p.title).toBe("Hello Greeting");

  // ── Step 6: GET /chats reflects last_run_status + title ────────────
  const listRes = await app.request("/chats");
  expect(listRes.status).toBe(200);
  const list = (await listRes.json()) as Array<{
    id: string;
    title: string | null;
    last_run_status: string | null;
  }>;
  expect(list.length).toBe(1);
  expect(list[0]!.id).toBe(created.id);
  expect(list[0]!.title).toBe("Hello Greeting");
  expect(list[0]!.last_run_status).toBe("done");

  // ── Step 7: GET /chat/:id full row reflects session_id + title ─────
  const getRes = await app.request(`/chat/${created.id}`);
  expect(getRes.status).toBe(200);
  const row = (await getRes.json()) as {
    id: string;
    session_id: string | null;
    title: string | null;
    current_run_id: string | null;
  };
  expect(row.session_id).toBe("sid-e2e-1");
  expect(row.title).toBe("Hello Greeting");
  // Lock released — current_run_id cleared by finally-cleanup.
  expect(row.current_run_id).toBeNull();

  // ── Step 8: persisted runs row reflects done + ended_at ────────────
  const runRow = db
    .query("SELECT status, ended_at FROM runs WHERE id = ?")
    .get(dispatch.run_id) as { status: string; ended_at: number | null };
  expect(runRow.status).toBe("done");
  expect(typeof runRow.ended_at).toBe("number");
});

test("restart with orphan running run: bootRecovery flips to interrupted, last_run_status reflects it", async () => {
  // Simulate a crashed daemon: chat + running run + dangling current_run_id.
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  const runId = "orphan-run";
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES (?, ?, ?, 'chat', 'running', ?)",
    [runId, chat.id, "maya", Date.now()],
  );
  repo.setCurrentRun(chat.id, runId);

  // Run boot recovery (what daemon does on startup).
  bootRecovery(db);

  // Verify state: run flipped, lock cleared.
  const after = repo.get(chat.id)!;
  expect(after.current_run_id).toBeNull();
  const runAfter = db
    .query("SELECT status, ended_at FROM runs WHERE id = ?")
    .get(runId) as { status: string; ended_at: number | null };
  expect(runAfter.status).toBe("interrupted");
  expect(typeof runAfter.ended_at).toBe("number");

  // GET /chats surfaces it — wire through a fresh app (no titler/orch
  // needed for read-only routes; inject no-op stubs to skip SDK init).
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vos79-e2e-restart-"));
  const orchestrator = {
    dispatch: async () => {
      throw new Error("orchestrator not used in restart test");
    },
    cancel: async () => ({ cancelled: false, run_id: null }),
  };
  const app = await buildApp({
    db,
    vaultRoot,
    orchestrator,
    titler: { title: async () => {} },
    emit: () => {},
  });
  const listRes = await app.request("/chats");
  const list = (await listRes.json()) as Array<{
    id: string;
    last_run_status: string | null;
  }>;
  expect(list[0]!.id).toBe(chat.id);
  expect(list[0]!.last_run_status).toBe("interrupted");
});
