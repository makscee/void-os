// VOS-80 architecture (a): orchestrator persists user / assistant / tool
// events into the canonical `messages` table.
//
// Validates the contract that GET /chat/:id/messages can read from DB:
//   - user prompt at dispatch start → 'user' row.
//   - assistant text accumulated, persisted ONCE at terminal (happy
//     completion or cancel/error finally) — UPSERT keyed on (chat_id, run_id).
//   - tool_use blocks → 'tool_use' rows emitted immediately as they arrive.
//   - tool_result blocks → 'tool_result' rows emitted immediately.
//   - On cancel mid-stream, partial assistant text is in messages table.
//   - On error mid-stream, partial assistant text is in messages table.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeChatRepo } from "../../src/chat/repo";
import { makeMessagesRepo } from "../../src/chat/messages-repo";
import { makeOrchestrator } from "../../src/chat/orchestrator";
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
  for (const m of [
    "0001_init.sql",
    "0002_runs_columns.sql",
    "0003_chat_lifecycle.sql",
    "0004_messages.sql",
    "0005_costs_cache.sql",
    "0006_costs_chat_id.sql",
    "0007_a2a_tables.sql",
  ]) {
    db.run(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }
  return db;
}

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

function inlineProvider(gen: () => AsyncIterable<unknown>): Provider {
  return {
    name: "inline",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      return {
        events: normalizeStream(gen()),
        cancel: async () => false,
        done: Promise.resolve({ reason: "exit" as const, exitCode: 0 }),
      };
    },
  };
}

test("happy path: user + assistant + tool_use + tool_result all persisted", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const chat = repo.create({ agent: "maya" });

  const provider = inlineProvider(() => (async function* () {
    yield { type: "system", session_id: "sid-1" };
    yield {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "thinking..." },
          { type: "tool_use", id: "u_1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    };
    yield {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "u_1", content: "ok" },
        ],
      },
    };
    yield {
      type: "assistant",
      message: {
        content: [{ type: "text", text: " done" }],
      },
    };
  })());

  const orch = makeOrchestrator({
    db,
    repo,
    provider,
    cwd: "/tmp",
    emit: () => {},
    titler: { title: async () => {} },
  });

  const result = await orch.dispatch(chat.id, "hello");
  expect(result.status).toBe("done");

  const walked = messages.walk(chat.id);
  // VOS-83 mig-0007: a turn's parts (text + tool_use + tool_result) are
  // buffered onto a single agent row. walk emits the merged text entry
  // first, then iterates DataParts (tool_use, tool_result) in declaration
  // order. The legacy interleaved [user, tool_use, tool_result, assistant]
  // order is replaced by [user, assistant, tool_use, tool_result].
  expect(walked.map((m: any) => m.role)).toEqual([
    "user",
    "assistant",
    "tool_use",
    "tool_result",
  ]);
  expect((walked[0] as any).content).toBe("hello");
  expect((walked[1] as any).content).toBe("thinking...\n done");
  expect((walked[2] as any).tool_call_id).toBe("u_1");
  expect((walked[2] as any).name).toBe("Bash");
  expect((walked[3] as any).tool_call_id).toBe("u_1");
  expect((walked[3] as any).output).toBe("ok");
});

test("cancel mid-stream: user + partial assistant in messages table", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const chat = repo.create({ agent: "maya" });

  const events: Array<{ t: string; p: any }> = [];
  const provider: Provider = {
    name: "cancel-mid",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      let killed = false;
      const evts = (async function* () {
        yield { type: "system", session_id: "sid-c" };
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "partial " }] },
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
  const r = await dispatchP;
  expect(r.status).toBe("cancelled");

  const walked = messages.walk(chat.id);
  expect(walked.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  expect((walked[1] as any).content).toBe("partial ");

  // VOS-83 mig-0007: last_msg column dropped — preview comes from
  // messages.parts_text via lastAssistantText.
  expect(messages.lastAssistantText(chat.id)).toBe("partial ");
});

test("error mid-stream: partial assistant text persisted, runs.status='error'", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const chat = repo.create({ agent: "maya" });

  const provider = inlineProvider(() => (async function* () {
    yield { type: "system", session_id: "sid-e" };
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "halfway" }] },
    };
    throw new Error("stream blew up");
  })());

  const orch = makeOrchestrator({
    db,
    repo,
    provider,
    cwd: "/tmp",
    emit: () => {},
    titler: { title: async () => {} },
  });

  const r = await orch.dispatch(chat.id, "go");
  expect(r.status).toBe("error");

  const walked = messages.walk(chat.id);
  expect(walked.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  expect((walked[1] as any).content).toBe("halfway");

  // VOS-83 mig-0007: last_msg column dropped — preview comes from
  // messages.parts_text via lastAssistantText.
  expect(messages.lastAssistantText(chat.id)).toBe("halfway");

  // runs.status === 'error'
  const run = db
    .query("SELECT status FROM runs WHERE id = ?")
    .get(r.run_id) as { status: string };
  expect(run.status).toBe("error");
});

test("assistant UPSERT: streamed tokens collapse into single row per run", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const chat = repo.create({ agent: "maya" });

  const provider = inlineProvider(() => (async function* () {
    yield { type: "system", session_id: "sid-up" };
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "one " }] },
    };
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "two " }] },
    };
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "three" }] },
    };
  })());

  const orch = makeOrchestrator({
    db,
    repo,
    provider,
    cwd: "/tmp",
    emit: () => {},
    titler: { title: async () => {} },
  });

  await orch.dispatch(chat.id, "q");

  const walked = messages.walk(chat.id);
  const assistantRows = walked.filter((m: any) => m.role === "assistant");
  expect(assistantRows.length).toBe(1);
  expect((assistantRows[0] as any).content).toBe("one two three");
});

test("second turn appends without disturbing first", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const chat = repo.create({ agent: "maya" });

  const makeProvider = (sid: string, reply: string): Provider =>
    inlineProvider(() => (async function* () {
      yield { type: "system", session_id: sid };
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: reply }] },
      };
    })());

  let orch = makeOrchestrator({
    db,
    repo,
    provider: makeProvider("sid-1", "first"),
    cwd: "/tmp",
    emit: () => {},
    titler: { title: async () => {} },
  });
  await orch.dispatch(chat.id, "q1");

  orch = makeOrchestrator({
    db,
    repo,
    provider: makeProvider("sid-1", "second"),
    cwd: "/tmp",
    emit: () => {},
    titler: { title: async () => {} },
  });
  await orch.dispatch(chat.id, "q2");

  const walked = messages.walk(chat.id);
  expect(walked.map((m: any) => m.content)).toEqual([
    "q1",
    "first",
    "q2",
    "second",
  ]);
});
