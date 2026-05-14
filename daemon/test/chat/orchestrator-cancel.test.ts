// VOS-80 S5: orchestrator cancel() — interrupts an in-flight run,
// terminates spawner, flushes partial assistant text, emits run.end
// with status="cancelled".
//
// Spawner is mocked as an AsyncIterable + a `cancel(runId)` hook. When
// orchestrator.cancel(chatId) fires, the spawner is signalled to stop
// yielding (mirroring real CcProcess.kill()), the iterator returns, and
// orchestrator's finally-block records status="cancelled" and persists
// any tokens already streamed.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeChatRepo } from "../../src/chat/repo";
import { makeOrchestrator } from "../../src/chat/orchestrator";

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
  ]) {
    db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }
  return db;
}

/**
 * Mock spawner that mid-stream blocks until cancelled. Mirrors the real
 * CcProcess.kill() shape: spawner.cancel(runId) flips `killed`, the parked
 * iterator's polling loop notices and returns. The runId-keyed lookup the
 * spawner-iter adapter performs is not exercised here — that's covered in
 * the adapter's own test suite.
 */
function blockingSpawner() {
  let killed = false;
  return {
    wasKilled() {
      return killed;
    },
    cancel(_runId: string): Promise<boolean> {
      killed = true;
      return Promise.resolve(true);
    },
    spawn(_args: { chat_id: string; resume: string | null; prompt: string }) {
      return (async function* () {
        yield { type: "system", session_id: "sid-cancel" };
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial " }],
          },
        };
        // Park here until cancel fires.
        while (!killed) {
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
    },
  };
}

test("cancel(): in-flight run → run.end status='cancelled', partial text flushed", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });

  const events: Array<{ t: string; p: any }> = [];
  const spawner = blockingSpawner();
  const orch = makeOrchestrator({
    db,
    repo,
    spawner,
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });

  // Kick off dispatch — will park inside spawner mid-stream.
  const dispatchP = orch.dispatch(chat.id, "go");

  // Wait until run.start has fired (so current_run_id is set + partial token streamed).
  await waitFor(() => events.some((e) => e.t === "chat.token"), 1000);

  // Now cancel — orchestrator must find the current run, terminate, finalise.
  const result = await orch.cancel(chat.id);
  expect(result.cancelled).toBe(true);
  expect(typeof result.run_id).toBe("string");

  // dispatch resolves with cancelled status
  const dispatchResult = await dispatchP;
  expect(dispatchResult.status).toBe("cancelled");

  // run.end frame emitted with status="cancelled"
  const runEnds = events.filter((e) => e.t === "run.end");
  expect(runEnds.length).toBe(1);
  expect(runEnds[0]!.p.status).toBe("cancelled");

  // Partial assistant text was persisted to last_msg before terminate.
  const afterChat = repo.get(chat.id)!;
  expect(afterChat.last_msg).toBe("partial ");

  // Lock cleared.
  expect(afterChat.current_run_id).toBeNull();

  // Runs row status="cancelled".
  const run = db
    .query("SELECT status FROM runs WHERE id = ?")
    .get(result.run_id) as { status: string };
  expect(run.status).toBe("cancelled");

  // spawner.cancel was actually called.
  expect(spawner.wasKilled()).toBe(true);
});

test("cancel(): no active run → returns cancelled=false (409 surface)", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });

  const spawner = blockingSpawner();
  const orch = makeOrchestrator({
    db,
    repo,
    spawner,
    emit: () => {},
    titler: { title: async () => {} },
  });

  const result = await orch.cancel(chat.id);
  expect(result.cancelled).toBe(false);
  expect(result.run_id).toBeNull();
});

test("cancel(): idempotent — second cancel after completion returns cancelled=false", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });

  const events: Array<{ t: string; p: any }> = [];
  const spawner = blockingSpawner();
  const orch = makeOrchestrator({
    db,
    repo,
    spawner,
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });

  const dispatchP = orch.dispatch(chat.id, "go");
  await waitFor(() => events.some((e) => e.t === "chat.token"), 1000);

  const first = await orch.cancel(chat.id);
  expect(first.cancelled).toBe(true);

  await dispatchP;

  const second = await orch.cancel(chat.id);
  expect(second.cancelled).toBe(false);
});

test("cancel(): partial-token stream — only emitted text is persisted, no extra yields", async () => {
  // Variant: emit two tokens, then cancel. Both should appear in last_msg.
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });

  const events: Array<{ t: string; p: any }> = [];
  let killed = false;
  const spawner = {
    cancel(_runId: string): Promise<boolean> {
      killed = true;
      return Promise.resolve(true);
    },
    spawn() {
      return (async function* () {
        yield { type: "system", session_id: "sid-x" };
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
            content: [{ type: "text", text: "world" }],
          },
        };
        // Park until cancelled — never reach this further yield.
        while (!killed) {
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
    },
  };

  const orch = makeOrchestrator({
    db,
    repo,
    spawner,
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });

  const dispatchP = orch.dispatch(chat.id, "x");
  await waitFor(
    () => events.filter((e) => e.t === "chat.token").length >= 2,
    1000,
  );

  await orch.cancel(chat.id);
  const result = await dispatchP;
  expect(result.status).toBe("cancelled");

  // Concatenated partial: "hello world"
  expect(repo.get(chat.id)!.last_msg).toBe("hello world");
});

test("cancel(): mid-tool-call — terminates cleanly without is_error frame leak", async () => {
  // Spawner emits a tool_use, then parks waiting for tool_result (real CC
  // would block on subprocess output). Cancel arrives mid-tool-call: the
  // run must finalise cancelled, lock released, no chat.tool_result frame
  // (because the parked stream never gets to that yield).
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });

  const events: Array<{ t: string; p: any }> = [];
  let killed = false;
  const spawner = {
    cancel(_runId: string): Promise<boolean> {
      killed = true;
      return Promise.resolve(true);
    },
    spawn() {
      return (async function* () {
        yield { type: "system", session_id: "sid-tool-mid" };
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "checking..." },
              { type: "tool_use", id: "u_1", name: "bash", input: { cmd: "ls" } },
            ],
          },
        };
        // Park waiting for the tool_result that never comes.
        while (!killed) {
          await new Promise((r) => setTimeout(r, 5));
        }
        // Would-be-emitted tool_result must NOT surface post-cancel.
        yield {
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "u_1", content: "leaked" },
            ],
          },
        };
      })();
    },
  };
  const orch = makeOrchestrator({
    db,
    repo,
    spawner,
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });

  const dispatchP = orch.dispatch(chat.id, "do tool thing");
  await waitFor(() => events.some((e) => e.t === "chat.tool_use"), 1000);

  const result = await orch.cancel(chat.id);
  expect(result.cancelled).toBe(true);
  const dr = await dispatchP;
  expect(dr.status).toBe("cancelled");

  // Tool-use was seen, tool-result must NOT have leaked post-cancel.
  expect(events.filter((e) => e.t === "chat.tool_use").length).toBe(1);
  expect(events.filter((e) => e.t === "chat.tool_result").length).toBe(0);

  // Partial assistant text persisted.
  expect(repo.get(chat.id)!.last_msg).toBe("checking...");
  expect(repo.get(chat.id)!.current_run_id).toBeNull();
});

// ── helper ───────────────────────────────────────────────────────────────

async function waitFor(
  cond: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: timeout");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
