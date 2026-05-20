// VOS-155: tests for in-flight agent event substrate.
//
// Three concerns under test:
//   1. Bridge — every legacy bus topic translates to the right AgentEvent
//      kind, with summary truncated and tool/tool_call_id carried through.
//   2. Endpoint — GET /agents/inflight returns the snapshot; ?stream=1
//      returns hello + snapshot + delta SSE frames.
//   3. JSONL — each emitted agent.event lands on disk as one line, in order;
//      a fresh reader can parse the file back into the original event array.

import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { createEventBus } from "../src/events/index.ts";
import {
  createInflightBridge,
  createInflightRegistry,
  createJsonlWriter,
  attachJsonlPersistence,
  type AgentEvent,
} from "../src/agents/inflight.ts";
import { runMigrationsFromDir } from "../src/adapters/sqlite/migrations";

const TOKEN = "test-token";
const MIGRATIONS_DIR = join(__dirname, "..", "src", "adapters", "sqlite", "migrations");

interface Ctx {
  app: Awaited<ReturnType<typeof buildApp>>;
  vaultRoot: string;
  db: Database;
  bus: ReturnType<typeof createEventBus>;
}
let ctx: Ctx;

beforeEach(async () => {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-vos155-"));
  const bus = createEventBus();
  const app = await buildApp({
    db,
    vaultRoot,
    token: TOKEN,
    bootTime: Date.now(),
    eventBus: bus,
    sessionId: "test-" + Math.random().toString(36).slice(2, 8),
  });
  ctx = { app, vaultRoot, db, bus };
});

afterEach(() => {
  fs.rmSync(ctx.vaultRoot, { recursive: true, force: true });
});

async function readSSE(res: Response, frameCount: number, timeoutMs = 2000): Promise<string[]> {
  const frames: string[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (frames.length < frameCount && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>(r => setTimeout(() => r({ value: undefined, done: true }), 100)),
    ]);
    if (done) break;
    buf += decoder.decode(value!, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      frames.push(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

// Helper: pluck the JSON data line out of an SSE frame.
function dataOf(frame: string): unknown {
  const line = frame.split("\n").find(l => l.startsWith("data: "));
  if (!line) return null;
  return JSON.parse(line.slice("data: ".length));
}

// ---------------------------------------------------------------------------
// Bridge: legacy → agent.event translation
// ---------------------------------------------------------------------------

test("bridge: chat.tool_use emits tool_call with name + correlator", () => {
  // Isolated bus so this test doesn't observe the buildApp-wired bridge.
  const bus = createEventBus();
  const seen: AgentEvent[] = [];
  bus.subscribe("agent.event", (e) => seen.push(e.payload as AgentEvent));
  createInflightBridge({ bus, now: () => "2026-05-20T00:00:00.000Z" });

  bus.emit({
    type: "chat.tool_use",
    payload: { chat_id: "c1", task_id: "t1", run_id: "r1", tool_call_id: "tc1", name: "Bash", input: { cmd: "ls" } },
  });

  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    kind: "tool_call",
    agent_id: "t1",
    tool: "Bash",
    tool_call_id: "tc1",
    source: "daemon",
  });
});

test("bridge: chat.tool_result emits tool_return with ok/error signal", () => {
  const bus = createEventBus();
  const seen: AgentEvent[] = [];
  bus.subscribe("agent.event", (e) => seen.push(e.payload as AgentEvent));
  createInflightBridge({ bus });

  bus.emit({
    type: "chat.tool_result",
    payload: { chat_id: "c1", task_id: "t1", tool_call_id: "tc1", is_error: false, output: "ok" },
  });
  bus.emit({
    type: "chat.tool_result",
    payload: { chat_id: "c1", task_id: "t1", tool_call_id: "tc2", is_error: true, output: "boom" },
  });

  expect(seen).toHaveLength(2);
  expect(seen[0].kind).toBe("tool_return");
  expect(seen[0].summary).toContain("ok");
  expect(seen[1].summary).toContain("error");
});

test("bridge: task.state_changed emits status with state field", () => {
  const bus = createEventBus();
  const seen: AgentEvent[] = [];
  bus.subscribe("agent.event", (e) => seen.push(e.payload as AgentEvent));
  createInflightBridge({ bus });

  bus.emit({
    type: "task.state_changed",
    payload: { taskId: "t1", state: "TASK_STATE_WORKING" },
  });

  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ kind: "status", agent_id: "t1", state: "TASK_STATE_WORKING" });
});

test("bridge: run.end emits end with reason", () => {
  const bus = createEventBus();
  const seen: AgentEvent[] = [];
  bus.subscribe("agent.event", (e) => seen.push(e.payload as AgentEvent));
  createInflightBridge({ bus });

  bus.emit({
    type: "run.end",
    payload: { taskId: "t1", reason: "exited" },
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ kind: "end", agent_id: "t1", reason: "exited" });
});

test("bridge: child.spawn emits spawn with parent_id", () => {
  const bus = createEventBus();
  const seen: AgentEvent[] = [];
  bus.subscribe("agent.event", (e) => seen.push(e.payload as AgentEvent));
  createInflightBridge({ bus });

  bus.emit({
    type: "child.spawn",
    payload: { child_task_id: "child1", parent_task_id: "parent1", agent_name: "impl" },
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ kind: "spawn", agent_id: "child1", parent_id: "parent1" });
  expect(seen[0].summary).toContain("impl");
});

test("bridge: child.dispatch_error emits end with reason=dispatch_error", () => {
  const bus = createEventBus();
  const seen: AgentEvent[] = [];
  bus.subscribe("agent.event", (e) => seen.push(e.payload as AgentEvent));
  createInflightBridge({ bus });

  bus.emit({
    type: "child.dispatch_error",
    payload: { child_task_id: "child1", agent_name: "impl", error: "provider missing" },
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ kind: "end", agent_id: "child1", reason: "dispatch_error" });
});

test("bridge: chat.token emits text with collapsed whitespace summary", () => {
  const bus = createEventBus();
  const seen: AgentEvent[] = [];
  bus.subscribe("agent.event", (e) => seen.push(e.payload as AgentEvent));
  createInflightBridge({ bus });

  bus.emit({
    type: "chat.token",
    payload: { chat_id: "c1", task_id: "t1", delta: "  hello\n  world  " },
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ kind: "text", agent_id: "t1", summary: "hello world" });
});

test("bridge: summary caps at 200 chars (default)", () => {
  const bus = createEventBus();
  const seen: AgentEvent[] = [];
  bus.subscribe("agent.event", (e) => seen.push(e.payload as AgentEvent));
  createInflightBridge({ bus });

  const big = "x".repeat(500);
  bus.emit({ type: "chat.token", payload: { task_id: "t1", delta: big } });
  expect(seen[0].summary.length).toBeLessThanOrEqual(200);
  expect(seen[0].summary.endsWith("…")).toBe(true);
});

// ---------------------------------------------------------------------------
// Registry: snapshot stays in sync with bus
// ---------------------------------------------------------------------------

test("registry: spawn → tool_call updates current_phase + last_action", () => {
  const bus = createEventBus();
  const reg = createInflightRegistry({ bus });
  // Bridge translates legacy events; here we emit agent.event directly
  // so the registry test is decoupled from bridge logic.
  bus.emit({
    type: "agent.event",
    payload: {
      ts: "2026-05-20T00:00:00.000Z",
      agent_id: "t1",
      parent_id: null,
      kind: "spawn",
      summary: "spawn impl",
    } satisfies AgentEvent,
  });
  bus.emit({
    type: "agent.event",
    payload: {
      ts: "2026-05-20T00:00:01.000Z",
      agent_id: "t1",
      parent_id: null,
      kind: "tool_call",
      summary: "tool_call Bash",
    } satisfies AgentEvent,
  });
  const list = reg.list();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({
    agent_id: "t1",
    current_phase: "tool_call",
    last_action: "tool_call Bash",
    started_at: "2026-05-20T00:00:00.000Z",
  });
});

test("registry: end kind removes the row", () => {
  const bus = createEventBus();
  const reg = createInflightRegistry({ bus });
  bus.emit({
    type: "agent.event",
    payload: { ts: "t", agent_id: "t1", parent_id: null, kind: "spawn", summary: "s" } satisfies AgentEvent,
  });
  expect(reg.list()).toHaveLength(1);
  bus.emit({
    type: "agent.event",
    payload: { ts: "t", agent_id: "t1", parent_id: null, kind: "end", summary: "done" } satisfies AgentEvent,
  });
  expect(reg.list()).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// JSONL roundtrip
// ---------------------------------------------------------------------------

test("jsonl: write + read roundtrip preserves order + fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vos155-jsonl-"));
  try {
    const w = createJsonlWriter({ vaultRoot: root, sessionId: "test", fsync: false });
    const events: AgentEvent[] = [
      { ts: "2026-05-20T00:00:00.000Z", agent_id: "t1", parent_id: null, kind: "spawn", summary: "s" },
      { ts: "2026-05-20T00:00:01.000Z", agent_id: "t1", parent_id: null, kind: "tool_call", summary: "Bash", tool: "Bash" },
      { ts: "2026-05-20T00:00:02.000Z", agent_id: "t1", parent_id: null, kind: "end", summary: "done", reason: "exited" },
    ];
    for (const e of events) w.write(e);
    w.close();

    const raw = fs.readFileSync(w.path, "utf8");
    const parsed = raw.trim().split("\n").map(l => JSON.parse(l) as AgentEvent);
    expect(parsed).toEqual(events);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("jsonl: persistence subscriber writes every agent.event", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vos155-persist-"));
  try {
    const bus = createEventBus();
    const w = createJsonlWriter({ vaultRoot: root, sessionId: "test", fsync: false });
    const unsub = attachJsonlPersistence(bus, w);
    bus.emit({
      type: "agent.event",
      payload: { ts: "t", agent_id: "t1", parent_id: null, kind: "spawn", summary: "s" } satisfies AgentEvent,
    });
    bus.emit({
      type: "agent.event",
      payload: { ts: "t", agent_id: "t1", parent_id: null, kind: "end", summary: "done" } satisfies AgentEvent,
    });
    unsub();
    w.close();
    const raw = fs.readFileSync(w.path, "utf8").trim().split("\n");
    expect(raw).toHaveLength(2);
    expect(JSON.parse(raw[0]).kind).toBe("spawn");
    expect(JSON.parse(raw[1]).kind).toBe("end");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Endpoint: snapshot + SSE
// ---------------------------------------------------------------------------

test("GET /agents/inflight without token → 401", async () => {
  const res = await ctx.app.request("/agents/inflight");
  expect(res.status).toBe(401);
});

test("GET /agents/inflight returns snapshot JSON", async () => {
  // Emit a spawn so the registry has one row.
  ctx.bus.emit({
    type: "agent.event",
    payload: { ts: "2026-05-20T00:00:00.000Z", agent_id: "t-snap", parent_id: null, kind: "spawn", summary: "s" } satisfies AgentEvent,
  });
  const res = await ctx.app.request("/agents/inflight?token=" + TOKEN);
  expect(res.status).toBe(200);
  const body = await res.json() as { agents: Array<{ agent_id: string }> };
  expect(body.agents.find(a => a.agent_id === "t-snap")).toBeDefined();
});

test("GET /agents/inflight?stream=1 sends hello → snapshot → delta", async () => {
  // Pre-seed one in-flight agent before opening the stream so snapshot has content.
  ctx.bus.emit({
    type: "agent.event",
    payload: { ts: "2026-05-20T00:00:00.000Z", agent_id: "t-pre", parent_id: null, kind: "spawn", summary: "s" } satisfies AgentEvent,
  });

  const before = ctx.bus.listenerCount();
  const resP = ctx.app.request("/agents/inflight?stream=1&token=" + TOKEN);
  // Give the route a beat to subscribe.
  await new Promise(r => setTimeout(r, 20));
  const res = await resP;
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  // +1 listener for the agent.event subscription opened by mountAgentsInflight.
  expect(ctx.bus.listenerCount()).toBe(before + 1);

  // Emit a delta after the stream is open.
  ctx.bus.emit({
    type: "agent.event",
    payload: { ts: "2026-05-20T00:00:01.000Z", agent_id: "t-pre", parent_id: null, kind: "tool_call", summary: "Bash" } satisfies AgentEvent,
  });

  const frames = await readSSE(res, 3);
  expect(frames[0]).toContain("event: hello");
  expect(frames[1]).toContain("event: snapshot");
  expect(frames[2]).toContain("event: agent_event");

  const snap = dataOf(frames[1]) as { agents: Array<{ agent_id: string }> };
  expect(snap.agents.find(a => a.agent_id === "t-pre")).toBeDefined();

  const delta = dataOf(frames[2]) as AgentEvent;
  expect(delta.agent_id).toBe("t-pre");
  expect(delta.kind).toBe("tool_call");
});

test("GET /agents/inflight?stream=1 client disconnect drops subscription", async () => {
  const before = ctx.bus.listenerCount();
  const resP = ctx.app.request("/agents/inflight?stream=1&token=" + TOKEN);
  await new Promise(r => setTimeout(r, 20));
  const res = await resP;
  await new Promise(r => setTimeout(r, 20));
  expect(ctx.bus.listenerCount()).toBe(before + 1);
  await res.body!.cancel();
  await new Promise(r => setTimeout(r, 50));
  expect(ctx.bus.listenerCount()).toBe(before);
});
