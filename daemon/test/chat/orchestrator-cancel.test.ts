// VOS-80 S5: orchestrator cancel() — interrupts an in-flight run,
// terminates provider handle, flushes partial assistant text, emits run.end
// with status="cancelled".
//
// Provider is mocked as a Provider with handle.cancel() that flips `killed`,
// causing the parked iterator to exit. Mirrors real ProviderHandle behaviour.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  applyMigrations,
  loadMigrations,
} from "../../src/adapters/sqlite/migrations.ts";
import { join } from "node:path";
import { makeChatRepo } from "../../src/chat/repo";
import { makeOrchestrator } from "../../src/chat/orchestrator";
import { makeMessagesRepo } from "../../src/chat/messages-repo";
import type { Provider, ProviderEvent, ProviderHandle, ProviderSpawnRequest } from "../../src/providers/index.ts";
import { normalizeStream } from "../helpers/normalize-stream.ts";

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
  applyMigrations(
    db,
    loadMigrations(MIGRATIONS_DIR).filter(
      (mg) => mg.version.slice(0, 4) <= "0016",
    ),
  );
  return db;
}

/**
 * Mock provider that mid-stream blocks until handle.cancel() is called.
 * Mirrors the real ProviderHandle: cancel() flips `killed`, the parked
 * iterator's polling loop notices and returns.
 */
function blockingProvider(): Provider & { wasKilled(): boolean } {
  let killed = false;
  return {
    name: "blocking",
    wasKilled() {
      return killed;
    },
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      const events = normalizeStream((async function* () {
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
      })());
      return {
        events,
        cancel: async () => {
          killed = true;
          return true;
        },
        done: Promise.resolve({ reason: "cancel" as const }),
      };
    },
  };
}

/**
 * Provider that parks mid-stream with a `killed` flag, exposing per-spawn cancel.
 */
function parkingProvider(
  genFn: (killed: () => boolean) => AsyncIterable<unknown>,
): Provider & { cancel_(): Promise<boolean> } {
  let cancelFn: () => Promise<boolean> = async () => false;
  return {
    name: "parking",
    cancel_: () => cancelFn(),
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      let killed = false;
      cancelFn = async () => { killed = true; return true; };
      const events = normalizeStream(genFn(() => killed));
      return {
        events,
        cancel: async () => { killed = true; return true; },
        done: Promise.resolve({ reason: "cancel" as const }),
      };
    },
  };
}

test("cancel(): in-flight run → run.end status='cancelled', partial text flushed", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });

  const events: Array<{ t: string; p: any }> = [];
  const provider = blockingProvider();
  const orch = makeOrchestrator({
    db,
    repo,
    provider,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });

  // Kick off dispatch — will park inside provider mid-stream.
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

  // VOS-83 mig-0007: last_msg derived from messages.parts_text.
  const messages0 = makeMessagesRepo(db);
  expect(messages0.lastAssistantText(chat.id)).toBe("partial ");

  // Lock cleared.
  const afterChat = repo.get(chat.id)!;
  expect(afterChat.current_run_id).toBeNull();

  // Runs row status="cancelled".
  const run = db
    .query("SELECT status FROM runs WHERE id = ?")
    .get(result.run_id) as { status: string };
  expect(run.status).toBe("cancelled");

  // VOS-80: ChatList sidebar dot reads `last_run_status` (derived from
  // runs.status via SELECT … LIMIT 1). After cancel, the dot must reflect
  // 'cancelled', not 'running' — that was the regression the original
  // cancel endpoint left behind.
  const listed = repo.list().find((c) => c.id === chat.id)!;
  expect(listed.last_run_status).toBe("cancelled");

  // handle.cancel was actually called.
  expect(provider.wasKilled()).toBe(true);
});

test("cancel(): no active run → returns cancelled=false (409 surface)", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });

  const provider = blockingProvider();
  const orch = makeOrchestrator({
    db,
    repo,
    provider,
    cwd: "/tmp",
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
  const provider = blockingProvider();
  const orch = makeOrchestrator({
    db,
    repo,
    provider,
    cwd: "/tmp",
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
  const provider: Provider = {
    name: "partial-tokens",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      let killed = false;
      const evts = (async function* () {
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
      return {
        events: normalizeStream(evts),
        cancel: async () => { killed = true; return true; },
        done: Promise.resolve({ reason: "cancel" as const }),
      };
    },
  };

  const orch = makeOrchestrator({
    db,
    repo,
    provider,
    cwd: "/tmp",
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
  const m1 = makeMessagesRepo(db);
  expect(m1.lastAssistantText(chat.id)).toBe("hello world");
});

test("cancel(): mid-tool-call — terminates cleanly without is_error frame leak", async () => {
  // Provider emits a tool_use, then parks waiting for tool_result (real CC
  // would block on subprocess output). Cancel arrives mid-tool-call: the
  // run must finalise cancelled, lock released, no chat.tool_result frame
  // (because the parked stream never gets to that yield).
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });

  const events: Array<{ t: string; p: any }> = [];
  const provider: Provider = {
    name: "mid-tool",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      let killed = false;
      const evts = (async function* () {
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
      return {
        events: normalizeStream(evts),
        cancel: async () => { killed = true; return true; },
        done: Promise.resolve({ reason: "cancel" as const }),
      };
    },
  };

  const orch = makeOrchestrator({
    db,
    repo,
    provider,
    cwd: "/tmp",
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
  const m2 = makeMessagesRepo(db);
  expect(m2.lastAssistantText(chat.id)).toBe("checking...");
  expect(repo.get(chat.id)!.current_run_id).toBeNull();
});

// VOS-80 stopped-badge fix (b): persist an empty cancelled-marker row when
// ESC fires before any tokens stream, so chat-switch / remount preserves
// the "↯ stopped" bubble. The plugin's "(stopped)" badge is derived from
// the LEFT JOIN runs.status='cancelled', which requires a row to attach to.
test("cancel() before any tokens: persists empty assistant row tagged cancelled via JOIN", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });

  const events: Array<{ t: string; p: any }> = [];
  // Provider that parks BEFORE emitting any assistant token. Just `system`
  // (session_id) — then waits to be cancelled.
  const provider: Provider = {
    name: "pre-token-cancel",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      let killed = false;
      const evts = (async function* () {
        yield { type: "system", session_id: "sid-empty-cancel" };
        // Park indefinitely — no assistant tokens emitted before cancel.
        while (!killed) {
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
      return {
        events: normalizeStream(evts),
        cancel: async () => { killed = true; return true; },
        done: Promise.resolve({ reason: "cancel" as const }),
      };
    },
  };

  const orch = makeOrchestrator({
    db,
    repo,
    provider,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });

  const dispatchP = orch.dispatch(chat.id, "test123");
  // Wait until run.start has fired (so provider is parked, but no tokens yet).
  await waitFor(() => events.some((e) => e.t === "run.start"), 1000);
  expect(events.some((e) => e.t === "chat.token")).toBe(false);

  const result = await orch.cancel(chat.id);
  expect(result.cancelled).toBe(true);
  await dispatchP;

  // The assistant row exists with empty content + cancelled flag set via JOIN.
  const messages = makeMessagesRepo(db);
  const walk = messages.walk(chat.id);
  // Expect: [user "test123", assistant {content: "", cancelled: true}].
  expect(walk).toHaveLength(2);
  expect((walk[0] as { role: string }).role).toBe("user");
  expect(walk[0]).toMatchObject({ role: "user", content: "test123" });
  expect(walk[1]).toMatchObject({
    role: "assistant",
    content: "",
    cancelled: true,
  });
});

// Regression: partial-text cancel must STILL persist the streamed text
// (not regress the (a) flush path).
test("cancel() with partial tokens: assistant row carries streamed text + cancelled flag", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });

  const events: Array<{ t: string; p: any }> = [];
  const provider: Provider = {
    name: "partial-cancel",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      let killed = false;
      const evts = (async function* () {
        yield { type: "system", session_id: "sid-partial-cancel" };
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial answer" }],
          },
        };
        while (!killed) {
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
      return {
        events: normalizeStream(evts),
        cancel: async () => { killed = true; return true; },
        done: Promise.resolve({ reason: "cancel" as const }),
      };
    },
  };

  const orch = makeOrchestrator({
    db,
    repo,
    provider,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });

  const dispatchP = orch.dispatch(chat.id, "go");
  await waitFor(() => events.some((e) => e.t === "chat.token"), 1000);

  await orch.cancel(chat.id);
  await dispatchP;

  const messages = makeMessagesRepo(db);
  const walk = messages.walk(chat.id);
  // user "go" + assistant "partial answer" (cancelled).
  expect(walk).toHaveLength(2);
  expect(walk[1]).toMatchObject({
    role: "assistant",
    content: "partial answer",
    cancelled: true,
  });
  // last_msg preserved.
  expect(messages.lastAssistantText(chat.id)).toBe("partial answer");
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
