// VOS-89 T15 helper: bootInProcessDaemon — minimal in-process daemon for
// integration tests that need the real wire (orchestrator + bus + MCP +
// answer-route + ask_agent dispatcher) but no Bun.serve, no claude-code
// subprocess, no SDK.
//
// VOS-89 T15.5: now uses the production `makeDispatchChildTask` (rather
// than an inline test-only dispatcher), exercising real production code
// for the child-dispatch path. We inject a `buildProvider` override that
// returns a fake provider per agent — agentScripts maps agent → JSONL
// script path, and the override resolves that map per agentName.
//
// Schema notes (verified against migrations 0007 + 0010 + 0011):
// - `tasks` has NO `agent_name` column. The plan's spec uses
//   `tasks.agent_name`, which would not parse. Caller agent identity is
//   derived from `contexts.agent_name` (one context, one agent). Child
//   agent identity comes from `tasks.target_agent` (added in 0011).
// - `chats` table is a 0007-era VIEW over `contexts` for the chat surface
//   (kept for backward compat by the chat repo). We refer to chat IDs and
//   context IDs as the same string — `repo.create({agent})` returns the
//   id used both as `chats.id` and `contexts.id`.

import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { join } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations.ts";
import { createEventBus, type EventBus } from "../../src/events/index.ts";
import { makeChatRepo } from "../../src/chat/repo.ts";
import {
  makeOrchestrator,
  resumeParentOnChildTerminal,
  type Orchestrator,
} from "../../src/chat/orchestrator.ts";
import { mountMcp } from "../../src/adapters/mcp/index.ts";
import { mountAnswerRoute } from "../../src/api/answer.ts";
import { createAskUserBridge } from "../../src/chat/ask-user-bridge.ts";
import { makeFakeProvider } from "../../src/providers/fake/index.ts";
import { makeDispatchChildTask } from "../../src/chat/dispatch-child.ts";
import { chatsApi } from "../../src/api/chats.ts";
import { chatApi } from "../../src/api/chat.ts";
import { createPermissionEngine, type AgentDefn } from "../../src/permissions/engine.ts";
import { createVaultWriter } from "../../src/vault/writer.ts";
import type { HandoffLog } from "../../src/agents/handoff-log.ts";

const MIGRATIONS_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);

export interface BootOpts {
  /**
   * Per-agent fake-provider scripts. Maps agent name → JSONL ProviderEvent
   * script path. The dispatcher will spin up a fresh fake provider per
   * child task, reading from the agent's script.
   */
  agentScripts: Record<string, string>;
  /** Optional explicit AgentDefn overrides. Defaults to permissive (no
   *  ask_agent_allow restriction) for every named agent. */
  agentDefns?: Record<string, AgentDefn>;
  /** Per-event delay (ms) for parent-chat orchestrators. Children inherit
   *  zero delay (they run via dispatchChildTask, separate provider).
   *  Useful for tests that need to fire ask_agent against a parent whose
   *  run has not yet drained — without a delay the fake-provider stream
   *  finishes synchronously, run.end fires, and parent flips to
   *  COMPLETED before the test bus subscriber can call MCP. */
  parentPerEventDelayMs?: number;
  /**
   * VOS-159: optional handoff-log adapter threaded into mountMcp so
   * integration tests can exercise the real provenance path (ask_agent ->
   * hl writer -> vault/work/handoffs/log.jsonl). Omitted -> ask_agent falls
   * back to NULL_HANDOFF_LOG and writes nothing.
   */
  handoffLog?: HandoffLog;
  /** VOS-159: session id stamped onto handoff entries. */
  sessionId?: string | null;
  /** VOS-159: milestone slug stamped onto handoff entries. */
  milestone?: string | null;
}

export interface BootedDaemon {
  db: Database;
  bus: EventBus;
  app: Hono;
  vaultRoot: string;
  /** Captured emit calls — useful for diagnostic dumps when a test fails. */
  events: Array<{ t: string; p: Record<string, unknown> }>;
  /** Create a chat for `agent` and post an initial user message. Returns
   *  the chat (= context) id once the dispatch resolves. */
  sendUserMessage(opts: { agent: string; text: string }): Promise<string>;
  /** Wait until the root task for `chatId` reaches a terminal state
   *  (COMPLETED / FAILED / CANCELED). Throws on timeout. */
  awaitChatComplete(chatId: string, opts?: { timeoutMs?: number }): Promise<void>;
  /** Cleanup. Closes the DB. */
  close(): void;
}

export async function bootInProcessDaemon(opts: BootOpts): Promise<BootedDaemon> {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrationsFromDir(db, MIGRATIONS_DIR);

  // Vault root: tmpdir; never read from in this harness, but mountMcp wants
  // a path and vault.read tool would resolve against it.
  const vaultRoot = mkdtempSync(join(tmpdir(), "vos89-t15-boot-"));
  mkdirSync(join(vaultRoot, "agents"), { recursive: true });

  // Seed agent_cards rows so the ask_agent handler's existence check passes. No
  // per-agent allowlist is set unless the caller injects one — the
  // permission gate treats absent `ask_agent_allow` as permissive.
  //
  // VOS-152: ALSO seed the `agents` table. POST /chats (chats.ts, VOS-124
  // strict-registry gate) consults `agentRepo.list()` and 404s any agent
  // not present. Prior to migration 0014 the 0008 maya seed implicitly
  // satisfied this check for tests using agent:"maya"; with the seed
  // dropped, tests must seed their own agents. Mirror the agent_cards
  // loop so the same identities populate both tables.
  const agentNames = Object.keys(opts.agentScripts);
  for (const name of agentNames) {
    const card = JSON.stringify({ name });
    db.run(
      "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
      [name, card],
    );
    db.run(
      "INSERT INTO agents (name, description, model, vault_path, updated_at) VALUES (?, ?, ?, ?, ?)",
      [name, null, null, `agents/${name}/agent.md`, 0],
    );
  }

  const bus = createEventBus({ db });

  // Captured events for diagnostics. The orchestrator's `emit` shim in
  // production fans to broadcast() (WS clients); here we ALSO forward
  // every emit onto the event bus so test-side subscribers (e.g. the
  // ask_agent tool_use roleplay loop in T15) can observe orchestrator
  // events via the same surface they'd watch in prod adapters.
  const events: Array<{ t: string; p: Record<string, unknown> }> = [];
  const emit = (t: string, p: Record<string, unknown>): void => {
    events.push({ t, p });
    bus.emit({ type: t, payload: p });
  };

  // Parent-resume listener (mirrors src/app.ts T11 wiring). When a child
  // task reaches a terminal state we flip the parent back to WORKING.
  const ASK_AGENT_TERMINALS = new Set([
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
  ]);
  bus.subscribe("task.state_changed", (ev) => {
    const p = ev.payload as { taskId?: string; state?: string } | undefined;
    if (!p?.taskId || !p.state) return;
    if (!ASK_AGENT_TERMINALS.has(p.state)) return;
    resumeParentOnChildTerminal(db, p.taskId, (t, payload) =>
      bus.emit({ type: t, payload }),
    );
  });

  const repo = makeChatRepo(db);

  // Per-chat orchestrator dispatch: every chat is bound to one agent at
  // creation, so each chat needs an orchestrator wired against THAT agent's
  // fake-provider script. We build orchestrators lazily on first use and
  // memoise per agent.
  const orchByAgent = new Map<string, Orchestrator>();
  function orchestratorFor(agent: string): Orchestrator {
    let o = orchByAgent.get(agent);
    if (o) return o;
    const scriptPath = opts.agentScripts[agent];
    if (!scriptPath) throw new Error(`no fake script registered for agent: ${agent}`);
    const provider = makeFakeProvider({
      scriptPath,
      perEventDelayMs: opts.parentPerEventDelayMs,
    });
    o = makeOrchestrator({
      db,
      repo,
      provider,
      cwd: vaultRoot,
      emit,
      titler: { title: async () => {} },
    });
    orchByAgent.set(agent, o);
    return o;
  }

  // Top-level orchestrator dispatcher for chatApi: routes by chat agent.
  const routedOrchestrator: Orchestrator = {
    async dispatch(chatId, text) {
      const chat = repo.get(chatId);
      if (!chat) throw new Error(`chat not found: ${chatId}`);
      return orchestratorFor(chat.agent).dispatch(chatId, text);
    },
    async cancel(chatId) {
      const chat = repo.get(chatId);
      if (!chat) return { cancelled: false, run_id: null };
      return orchestratorFor(chat.agent).cancel(chatId);
    },
  };

  // Build the Hono app manually. We mirror buildApp's wiring but inject our
  // own orchestrator + dispatchChildTask, neither of which buildApp exposes
  // as a seam for this combination.
  const app = new Hono();
  app.route("/", chatsApi(db));
  app.route("/", chatApi(db, { orchestrator: routedOrchestrator }));

  // VOS-89 T15.5: production dispatcher with a per-agent fake-provider
  // override. The real `makeDispatchChildTask` owns the microtask kick,
  // SUBMITTED→WORKING flip, message draining, terminal flip, and
  // task.state_changed emit — we only inject a fake Provider per agent
  // so we don't need a real claude-code subprocess.
  const dispatchChildTask = makeDispatchChildTask({
    db,
    bus,
    cwd: vaultRoot,
    tracesDir: join(vaultRoot, ".traces"),
    buildProvider: (agentName) => {
      const scriptPath = opts.agentScripts[agentName];
      if (!scriptPath) {
        throw new Error(`no fake script for agent: ${agentName}`);
      }
      return makeFakeProvider({ scriptPath });
    },
  });

  // Default loadAgentDefn pulls from agent_cards; we override only when the
  // caller provided explicit defns (e.g. for ask_agent_allow tests).
  const loadAgentDefn = opts.agentDefns
    ? (name: string): AgentDefn => {
        const d = opts.agentDefns![name];
        if (!d) throw new Error(`unknown agent: ${name}`);
        return d;
      }
    : undefined;

  // VOS-100 T6: single bridge instance shared between mountMcp (ask_user
  // handler parks awaiters via bridge.open) and mountAnswerRoute (HTTP
  // /answer resolves them via bridge.resolve).
  const bridge = createAskUserBridge({ db, bus });
  // VOS-106 T7.5: mountMcp requires a PermissionEngine. Build one rooted at
  // the test's vaultRoot with a /tmp/home anchor — vault.read is not the
  // tool under test here, but the dep is structurally required.
  const engine = createPermissionEngine({ vaultRoot, homeRoot: "/tmp/home" });
  const writer = createVaultWriter({ vaultRoot, db });
  mountMcp(app, {
    vaultRoot,
    db,
    bus,
    bridge,
    dispatchChildTask,
    loadAgentDefn,
    engine,
    writer,
    // VOS-159: thread the optional handoff-log adapter + identity so an
    // integration test can assert provenance entries land on disk.
    handoffLog: opts.handoffLog,
    sessionId: opts.sessionId,
    milestone: opts.milestone,
  });
  mountAnswerRoute(app, { db, bridge });

  return {
    db,
    bus,
    app,
    vaultRoot,
    events,
    async sendUserMessage({ agent, text }) {
      const createRes = await app.request("/chats", {
        method: "POST",
        body: JSON.stringify({ agent }),
        headers: { "content-type": "application/json" },
      });
      if (createRes.status !== 200) {
        throw new Error(`POST /chats failed: ${createRes.status}`);
      }
      const created = (await createRes.json()) as { id: string };
      const msgRes = await app.request(`/chat/${created.id}/message`, {
        method: "POST",
        body: JSON.stringify({ text }),
        headers: { "content-type": "application/json" },
      });
      if (msgRes.status !== 200) {
        throw new Error(`POST /chat/:id/message failed: ${msgRes.status}`);
      }
      // Don't await body fully — dispatch is synchronous in the fake
      // provider, so by the time HTTP returns the orchestrator is done.
      await msgRes.json();
      return created.id;
    },
    async awaitChatComplete(chatId, { timeoutMs = 5_000 } = {}) {
      const TERMINAL = new Set([
        "TASK_STATE_COMPLETED",
        "TASK_STATE_FAILED",
        "TASK_STATE_CANCELED",
      ]);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const row = db
          .query(
            "SELECT state FROM tasks WHERE context_id=? AND parent_task_id IS NULL ORDER BY created_at ASC LIMIT 1",
          )
          .get(chatId) as { state: string } | undefined;
        if (row && TERMINAL.has(row.state)) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      const row = db
        .query(
          "SELECT state FROM tasks WHERE context_id=? AND parent_task_id IS NULL ORDER BY created_at ASC LIMIT 1",
        )
        .get(chatId);
      throw new Error(
        `awaitChatComplete: timeout after ${timeoutMs}ms; root task row=${JSON.stringify(row)}`,
      );
    },
    close() {
      db.close();
    },
  };
}

// VOS-89 T15.5: inline runChildTaskOnFakeProvider helper removed — the
// production `makeDispatchChildTask` is now used end-to-end via a
// `buildProvider` injection.
