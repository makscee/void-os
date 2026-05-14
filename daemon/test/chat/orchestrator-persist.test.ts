// VOS-80 architecture (a): orchestrator persists user / assistant / tool
// events into the canonical `messages` table.
//
// Validates the contract that GET /chat/:id/messages can read from DB:
//   - user prompt at dispatch start → 'user' row.
//   - assistant text accumulated, persisted ONCE at terminal (chat.completion
//     or cancel/error finally) — UPSERT keyed on (chat_id, run_id).
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

test("happy path: user + assistant + tool_use + tool_result all persisted", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const chat = repo.create({ agent: "maya" });

  const spawner = {
    spawn() {
      return (async function* () {
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
      })();
    },
  };

  const orch = makeOrchestrator({
    db,
    repo,
    spawner,
    emit: () => {},
    titler: { title: async () => {} },
  });

  const result = await orch.dispatch(chat.id, "hello");
  expect(result.status).toBe("done");

  const walked = messages.walk(chat.id);
  expect(walked.map((m: any) => m.role)).toEqual([
    "user",
    "tool_use",
    "tool_result",
    "assistant",
  ]);
  expect((walked[0] as any).content).toBe("hello");
  expect((walked[1] as any).tool_call_id).toBe("u_1");
  expect((walked[1] as any).name).toBe("Bash");
  expect((walked[2] as any).tool_call_id).toBe("u_1");
  expect((walked[2] as any).output).toBe("ok");
  expect((walked[3] as any).content).toBe("thinking... done");
});

test("cancel mid-stream: user + partial assistant in messages table", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
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
        yield { type: "system", session_id: "sid-c" };
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "partial " }] },
        };
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

  const dispatchP = orch.dispatch(chat.id, "go");
  await waitFor(() => events.some((e) => e.t === "chat.token"), 1000);
  await orch.cancel(chat.id);
  const r = await dispatchP;
  expect(r.status).toBe("cancelled");

  const walked = messages.walk(chat.id);
  expect(walked.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  expect((walked[1] as any).content).toBe("partial ");

  // chats.last_msg derived from same write.
  expect(repo.get(chat.id)!.last_msg).toBe("partial ");
});

test("error mid-stream: partial assistant text persisted, runs.status='error'", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);
  const chat = repo.create({ agent: "maya" });

  const spawner = {
    spawn() {
      return (async function* () {
        yield { type: "system", session_id: "sid-e" };
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "halfway" }] },
        };
        throw new Error("stream blew up");
      })();
    },
  };
  const orch = makeOrchestrator({
    db,
    repo,
    spawner,
    emit: () => {},
    titler: { title: async () => {} },
  });

  const r = await orch.dispatch(chat.id, "go");
  expect(r.status).toBe("error");

  const walked = messages.walk(chat.id);
  expect(walked.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  expect((walked[1] as any).content).toBe("halfway");

  // chats.last_msg also updated from messages.
  expect(repo.get(chat.id)!.last_msg).toBe("halfway");

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

  const spawner = {
    spawn() {
      return (async function* () {
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
      })();
    },
  };
  const orch = makeOrchestrator({
    db,
    repo,
    spawner,
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

  const makeSpawner = (sid: string, reply: string) => ({
    spawn() {
      return (async function* () {
        yield { type: "system", session_id: sid };
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: reply }] },
        };
      })();
    },
  });

  let orch = makeOrchestrator({
    db,
    repo,
    spawner: makeSpawner("sid-1", "first"),
    emit: () => {},
    titler: { title: async () => {} },
  });
  await orch.dispatch(chat.id, "q1");

  orch = makeOrchestrator({
    db,
    repo,
    spawner: makeSpawner("sid-1", "second"),
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
