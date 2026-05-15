// orchestrator tests — per VOS-79 plan Task 7.
//
// Covers: txn lock (chats.current_run_id), run row lifecycle (running → done/error),
// sessionCaptured guard (single setSession per chat lifetime, even with --resume),
// finally-cleanup on success and error, titler fire-and-forget on first turn only,
// concurrent dispatch race → exactly one fulfilled + one 409.
//
// The spawner is mocked as an AsyncIterable so the orchestrator stays decoupled
// from the real CcSpawner shape (which returns a CcProcess that emits via bus).
// The runtime adapter that bridges CcSpawner → AsyncIterable lives in the wiring
// layer (Task 9), not here.

import { test, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeChatRepo } from "../../src/chat/repo";
import {
  makeOrchestrator,
  Conflict409,
} from "../../src/chat/orchestrator";
import type { Provider, ProviderEvent, ProviderHandle, ProviderSpawnRequest } from "../../src/providers/index.ts";
import { extractAssistantText } from "../../src/providers/claude-code/extract.ts";

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

// Minimal Provider wrapping an inline async-generator factory.
// Used by tests that only need to script the event sequence.
function inlineProvider(gen: () => AsyncIterable<ProviderEvent>): Provider {
  return {
    name: "inline",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      const events = gen();
      return {
        events,
        cancel: async () => false,
        done: Promise.resolve({ reason: "exit" as const, exitCode: 0 }),
      };
    },
  };
}

interface FakeProviderOpts {
  sessionId?: string;
  throwBefore?: boolean;
  throwMid?: boolean;
  // When set, the provider asserts on the resumeFrom arg it receives.
  expectResume?: string | null;
}

function fakeProvider(opts: FakeProviderOpts = {}): Provider {
  return {
    name: "fake",
    spawn(req: ProviderSpawnRequest): ProviderHandle {
      if (opts.expectResume !== undefined) {
        expect(req.resumeFrom ?? null).toBe(opts.expectResume);
      }
      if (opts.throwBefore) {
        throw new Error("ENOENT: claudev not found");
      }
      const sid = opts.sessionId ?? "sid-fresh";
      const throwMid = opts.throwMid;
      const events = (async function* () {
        yield { type: "system", session_id: sid };
        yield {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
        };
        if (throwMid) throw new Error("stream blew up");
        yield { type: "tool_use", name: "vault.read", input: { path: "x" } };
      })();
      return {
        events,
        cancel: async () => false,
        done: Promise.resolve({ reason: "exit" as const, exitCode: 0 }),
      };
    },
  };
}

test("happy path: lock acquired, run inserted, sessionCaptured, cleanup", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });

  const events: Array<{ t: string; p: unknown }> = [];
  const titler = { title: mock(async () => {}) };
  const spawner = fakeProvider({ expectResume: null });
  const orch = makeOrchestrator({
    db,
    repo,
    provider: spawner,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler,
  });

  const result = await orch.dispatch(chat.id, "hello");
  expect(result.run_id).toBeTruthy();
  expect(result.status).toBe("done");

  const afterChat = repo.get(chat.id)!;
  expect(afterChat.current_run_id).toBeNull();
  expect(afterChat.session_id).toBe("sid-fresh");

  const run = db
    .query("SELECT status, ended_at FROM runs WHERE id = ?")
    .get(result.run_id) as { status: string; ended_at: number | null };
  expect(run.status).toBe("done");
  expect(run.ended_at).not.toBeNull();

  // Bus events: run.start, run.end at minimum
  const types = events.map((e) => e.t);
  expect(types).toContain("run.start");
  expect(types).toContain("run.end");

  // chat.token carries non-empty delta extracted from message.content[].
  const tokens = events
    .filter((e) => e.t === "chat.token")
    .map((e) => (e.p as { delta: string }).delta);
  expect(tokens.length).toBe(1);
  expect(tokens[0]).toBe("Hi");

  // Persisted last_msg snippet reflects the assembled assistant text.
  expect(afterChat.last_msg).toBe("Hi");

  // Wait one microtask for fire-and-forget titler
  await new Promise((r) => setTimeout(r, 5));
  expect(titler.title).toHaveBeenCalledTimes(1);
});

// ── extractAssistantText unit coverage ─────────────────────────────────

test("extractAssistantText: single text block", () => {
  expect(
    extractAssistantText({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    } as any),
  ).toBe("hello");
});

test("extractAssistantText: multiple text blocks concatenate", () => {
  expect(
    extractAssistantText({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "foo " },
          { type: "text", text: "bar" },
        ],
      },
    } as any),
  ).toBe("foo bar");
});

test("extractAssistantText: mixed text + tool_use blocks return only text", () => {
  expect(
    extractAssistantText({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "thinking: " },
          { type: "tool_use", id: "u_1", name: "vault.read", input: {} },
          { type: "text", text: "done" },
        ],
      },
    } as any),
  ).toBe("thinking: done");
});

test("extractAssistantText: missing message returns empty string", () => {
  expect(extractAssistantText({ type: "assistant" } as any)).toBe("");
});

test("extractAssistantText: empty content array returns empty string", () => {
  expect(
    extractAssistantText({
      type: "assistant",
      message: { role: "assistant", content: [] },
    } as any),
  ).toBe("");
});

test("extractAssistantText: tool-use-only content returns empty string", () => {
  expect(
    extractAssistantText({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "u_1", name: "x", input: {} }],
      },
    } as any),
  ).toBe("");
});

// ── orchestrator-level: multi-block assistant + empty/tool-only turns ──

test("orchestrator: assistant with multiple text blocks emits one delta + persists full text", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  const events: Array<{ t: string; p: any }> = [];
  const spawner = inlineProvider(() => (async function* () {
    yield { type: "system", session_id: "sid-multi" };
    yield {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "alpha " },
          { type: "text", text: "beta" },
        ],
      },
    };
  })());
  const orch = makeOrchestrator({
    db,
    repo,
    provider: spawner,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });
  await orch.dispatch(chat.id, "go");
  const tokens = events.filter((e) => e.t === "chat.token");
  expect(tokens.length).toBe(1);
  expect(tokens[0]!.p.delta).toBe("alpha beta");
  expect(repo.get(chat.id)!.last_msg).toBe("alpha beta");
});

// ── VOS-80 S4: tool_use / tool_result WS frames ─────────────────────────

test("orchestrator: assistant tool_use block → chat.tool_use frame with id/name/input", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  const events: Array<{ t: string; p: any }> = [];
  const spawner = inlineProvider(() => (async function* () {
    yield { type: "system", session_id: "sid-tu" };
    yield {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "let me check " },
          {
            type: "tool_use",
            id: "u_1",
            name: "vault.read",
            input: { path: "x" },
          },
        ],
      },
    };
  })());
  const orch = makeOrchestrator({
    db,
    repo,
    provider: spawner,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });
  const result = await orch.dispatch(chat.id, "go");
  const tu = events.filter((e) => e.t === "chat.tool_use");
  expect(tu.length).toBe(1);
  expect(tu[0]!.p).toEqual({
    chat_id: chat.id,
    run_id: result.run_id,
    tool_call_id: "u_1",
    name: "vault.read",
    input: { path: "x" },
  });
  // text block still surfaces as chat.token in the same turn.
  const tokens = events.filter((e) => e.t === "chat.token");
  expect(tokens.length).toBe(1);
  expect(tokens[0]!.p.delta).toBe("let me check ");
});

test("orchestrator: user tool_result block → chat.tool_result frame", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  const events: Array<{ t: string; p: any }> = [];
  const spawner = inlineProvider(() => (async function* () {
    yield { type: "system", session_id: "sid-tr" };
    yield {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "u_1", name: "bash", input: { cmd: "ls" } },
        ],
      },
    };
    yield {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "u_1", content: "file1\n" },
        ],
      },
    };
  })());
  const orch = makeOrchestrator({
    db,
    repo,
    provider: spawner,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });
  const result = await orch.dispatch(chat.id, "ls");
  const tr = events.filter((e) => e.t === "chat.tool_result");
  expect(tr.length).toBe(1);
  expect(tr[0]!.p).toEqual({
    chat_id: chat.id,
    run_id: result.run_id,
    tool_call_id: "u_1",
    output: "file1\n",
    is_error: false,
  });
});

test("orchestrator: tool_result with is_error=true surfaces is_error on frame", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  const events: Array<{ t: string; p: any }> = [];
  const spawner = inlineProvider(() => (async function* () {
    yield { type: "system", session_id: "sid-err" };
    yield {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "u_1",
            content: "ENOENT",
            is_error: true,
          },
        ],
      },
    };
  })());
  const orch = makeOrchestrator({
    db,
    repo,
    provider: spawner,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });
  await orch.dispatch(chat.id, "x");
  const tr = events.filter((e) => e.t === "chat.tool_result");
  expect(tr.length).toBe(1);
  expect(tr[0]!.p.is_error).toBe(true);
  expect(tr[0]!.p.output).toBe("ENOENT");
});

test("orchestrator: multiple tool_use blocks in one assistant turn emit multiple frames in order", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  const events: Array<{ t: string; p: any }> = [];
  const spawner = inlineProvider(() => (async function* () {
    yield { type: "system", session_id: "sid-multi-tu" };
    yield {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "u_1", name: "a", input: {} },
          { type: "tool_use", id: "u_2", name: "b", input: { k: 2 } },
        ],
      },
    };
  })());
  const orch = makeOrchestrator({
    db,
    repo,
    provider: spawner,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });
  await orch.dispatch(chat.id, "x");
  const tu = events.filter((e) => e.t === "chat.tool_use");
  expect(tu.length).toBe(2);
  expect(tu.map((e) => e.p.tool_call_id)).toEqual(["u_1", "u_2"]);
  expect(tu.map((e) => e.p.name)).toEqual(["a", "b"]);
});

test("orchestrator: malformed tool_use (no id) emits NO frame", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  const events: Array<{ t: string; p: any }> = [];
  const spawner = inlineProvider(() => (async function* () {
    yield { type: "system", session_id: "sid-bad" };
    yield {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "x", input: {} }],
      },
    };
  })());
  const orch = makeOrchestrator({
    db,
    repo,
    provider: spawner,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });
  await orch.dispatch(chat.id, "x");
  expect(events.filter((e) => e.t === "chat.tool_use").length).toBe(0);
});

test("orchestrator: user tool_result does NOT emit a chat.message_user echo of tool output", async () => {
  // tool_result lives in user-role records — they must NOT be confused for
  // a user-typed message. chat.message_user only fires once per dispatch
  // for the actual prompt text.
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  const events: Array<{ t: string; p: any }> = [];
  const spawner = inlineProvider(() => (async function* () {
    yield { type: "system", session_id: "sid-no-echo" };
    yield {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "u_1", content: "out" },
        ],
      },
    };
  })());
  const orch = makeOrchestrator({
    db,
    repo,
    provider: spawner,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });
  await orch.dispatch(chat.id, "prompt");
  const userMsgs = events.filter((e) => e.t === "chat.message_user");
  expect(userMsgs.length).toBe(1);
  expect(userMsgs[0]!.p.text).toBe("prompt");
});

test("orchestrator: pure tool-call assistant turn emits NO chat.token", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  const events: Array<{ t: string; p: any }> = [];
  const spawner = inlineProvider(() => (async function* () {
    yield { type: "system", session_id: "sid-tool-only" };
    yield {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "u_1", name: "x", input: {} }],
      },
    };
  })());
  const orch = makeOrchestrator({
    db,
    repo,
    provider: spawner,
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler: { title: async () => {} },
  });
  await orch.dispatch(chat.id, "go");
  const tokens = events.filter((e) => e.t === "chat.token");
  expect(tokens.length).toBe(0);
  // Run still terminates cleanly (run.end is the authoritative terminal frame).
  expect(events.some((e) => e.t === "run.end")).toBe(true);
});

test("concurrent dispatch: second rejects with Conflict409 carrying current_run_id", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });

  // Slow spawner so two dispatches race for the lock.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const slowSpawner = inlineProvider(() => (async function* () {
    await gate;
    yield { type: "system", session_id: "sid-slow" };
  })());
  const orch = makeOrchestrator({
    db,
    repo,
    provider: slowSpawner,
    cwd: "/tmp",
    emit: () => {},
    titler: { title: async () => {} },
  });

  const settled = await Promise.allSettled([
    orch.dispatch(chat.id, "first"),
    (async () => {
      // Give the first dispatch a tick to claim the lock.
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await orch.dispatch(chat.id, "second");
      } finally {
        release();
      }
    })(),
  ]);

  const fulfilled = settled.filter((s) => s.status === "fulfilled");
  const rejected = settled.filter((s) => s.status === "rejected");
  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(1);
  const err = (rejected[0] as PromiseRejectedResult).reason;
  expect(err).toBeInstanceOf(Conflict409);
  expect(err.status).toBe(409);
  expect(typeof err.current_run_id).toBe("string");
  expect(err.current_run_id.length).toBeGreaterThan(0);
});

test("spawn throws synchronously: lock released, run marked error", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  const events: Array<{ t: string; p: unknown }> = [];
  const titler = { title: mock(async () => {}) };
  const orch = makeOrchestrator({
    db,
    repo,
    provider: fakeProvider({ throwBefore: true }),
    cwd: "/tmp",
    emit: (t, p) => events.push({ t, p }),
    titler,
  });

  const result = await orch.dispatch(chat.id, "x");
  expect(result.status).toBe("error");
  expect(repo.get(chat.id)!.current_run_id).toBeNull();

  const run = db
    .query("SELECT status, error FROM runs WHERE id = ?")
    .get(result.run_id) as { status: string; error: string | null };
  expect(run.status).toBe("error");
  expect(run.error).toContain("ENOENT");

  await new Promise((r) => setTimeout(r, 5));
  expect(titler.title).toHaveBeenCalledTimes(0);
});

test("spawn throws mid-stream: lock released, run marked error", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  const orch = makeOrchestrator({
    db,
    repo,
    provider: fakeProvider({ throwMid: true }),
    cwd: "/tmp",
    emit: () => {},
    titler: { title: async () => {} },
  });

  const result = await orch.dispatch(chat.id, "x");
  expect(result.status).toBe("error");
  expect(repo.get(chat.id)!.current_run_id).toBeNull();
  const run = db
    .query("SELECT status FROM runs WHERE id = ?")
    .get(result.run_id) as { status: string };
  expect(run.status).toBe("error");
});

test("sessionCaptured fires exactly once: --resume path does NOT re-call setSession", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  // Pre-seed: first turn already captured a session id.
  repo.setSession(chat.id, "sid-original");

  // Spy on setSession by wrapping the repo.
  const setSessionSpy = mock(repo.setSession.bind(repo));
  const wrappedRepo = { ...repo, setSession: setSessionSpy };

  // Spawner asserts orchestrator passes resume="sid-original".
  const spawner = fakeProvider({
    sessionId: "sid-original",
    expectResume: "sid-original",
  });
  const orch = makeOrchestrator({
    db,
    repo: wrappedRepo,
    provider: spawner,
    cwd: "/tmp",
    emit: () => {},
    titler: { title: async () => {} },
  });

  await orch.dispatch(chat.id, "second turn");

  // setSession should NOT have been called: chat already had a session.
  expect(setSessionSpy).toHaveBeenCalledTimes(0);
  // session unchanged
  expect(repo.get(chat.id)!.session_id).toBe("sid-original");
});

test("titler NOT fired when chat already has a title (second turn)", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  repo.setSession(chat.id, "sid-prev");
  repo.setTitle(chat.id, "Existing Title");

  const titler = { title: mock(async () => {}) };
  const orch = makeOrchestrator({
    db,
    repo,
    provider: fakeProvider({ sessionId: "sid-prev", expectResume: "sid-prev" }),
    cwd: "/tmp",
    emit: () => {},
    titler,
  });
  await orch.dispatch(chat.id, "x");
  await new Promise((r) => setTimeout(r, 5));
  expect(titler.title).toHaveBeenCalledTimes(0);
});

test("missing chat: dispatch rejects with 404-shaped error", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const orch = makeOrchestrator({
    db,
    repo,
    provider: fakeProvider(),
    cwd: "/tmp",
    emit: () => {},
    titler: { title: async () => {} },
  });
  let caught: unknown;
  try {
    await orch.dispatch("no-such-chat", "x");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeTruthy();
  expect((caught as { status?: number }).status).toBe(404);
});

test("stale current_run_id (terminal run) does NOT block new dispatch", async () => {
  const db = freshDb();
  const repo = makeChatRepo(db);
  const chat = repo.create({ agent: "maya" });
  // Simulate a crash that left current_run_id pointing at a finished run.
  const staleRunId = "stale-run-id";
  db.run(
    "INSERT INTO runs (id, chat_id, agent, kind, status, started_at, ended_at) VALUES (?, ?, ?, ?, 'done', ?, ?)",
    [staleRunId, chat.id, "maya", "chat", Date.now() - 1000, Date.now() - 500],
  );
  repo.setCurrentRun(chat.id, staleRunId);

  const orch = makeOrchestrator({
    db,
    repo,
    provider: fakeProvider({ sessionId: "sid-after-crash" }),
    cwd: "/tmp",
    emit: () => {},
    titler: { title: async () => {} },
  });
  const result = await orch.dispatch(chat.id, "x");
  expect(result.status).toBe("done");
  expect(repo.get(chat.id)!.current_run_id).toBeNull();
});
