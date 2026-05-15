// VOS-89 T15 helper: bootInProcessDaemon — minimal in-process daemon for
// integration tests that need the real wire (orchestrator + bus + MCP +
// answer-route + ask_agent dispatcher) but no Bun.serve, no claude-code
// subprocess, no SDK.
//
// What this DOESN'T use: production buildApp(). buildApp doesn't currently
// expose a seam for `dispatchChildTask`, and the production default is a
// no-op placeholder (see daemon/src/adapters/mcp/index.ts comment block on
// VOS-89 T10/T11/T15). For the integration test we wire a real per-agent
// fake-provider dispatcher inline so the child task actually runs.
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
import { makeMessagesRepo } from "../../src/chat/messages-repo.ts";
import {
  makeOrchestrator,
  resumeParentOnChildTerminal,
  type Orchestrator,
} from "../../src/chat/orchestrator.ts";
import { makeTitlerStub } from "../../src/chat/titler-stub.ts";
import { mountMcp, pendingRegistry } from "../../src/adapters/mcp/index.ts";
import { mountAnswerRoute } from "../../src/api/answer.ts";
import { makeFakeProvider } from "../../src/providers/fake/index.ts";
import { chatsApi } from "../../src/api/chats.ts";
import { chatApi } from "../../src/api/chat.ts";
import { extractAssistantText } from "../../src/providers/claude-code/index.ts";
import { extractToolUses, extractToolResults } from "../../src/chat/util.ts";
import type { AgentDefn } from "../../src/permissions/engine.ts";
import type { Part } from "../../src/types/a2a.ts";

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

  // Seed agent_cards rows so runAskAgent's existence check passes. No
  // per-agent allowlist is set unless the caller injects one — the
  // permission gate treats absent `ask_agent_allow` as permissive.
  const agentNames = Object.keys(opts.agentScripts);
  for (const name of agentNames) {
    const card = JSON.stringify({ name });
    db.run(
      "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
      [name, card],
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
    resumeParentOnChildTerminal(db, p.taskId);
  });

  const repo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);

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
    const provider = makeFakeProvider({ scriptPath });
    o = makeOrchestrator({
      db,
      repo,
      provider,
      cwd: vaultRoot,
      emit,
      titler: makeTitlerStub(),
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

  // dispatchChildTask: production has no real impl (placeholder warns +
  // returns). Here we run the child synchronously: pull the journaler-style
  // fake provider, drain events into the canonical messages table for the
  // child task_id, then flip the child state COMPLETED + emit
  // task.state_changed so the bus listeners (parent resume + ask_agent
  // wait) fire. Child runs OFF the parent's await — runAskAgent does
  // `await ctx.dispatchChildTask(...)`, so we kick into a new microtask
  // and return immediately to keep the wait/race-guard loop healthy.
  const dispatchChildTask = async (
    childTaskId: string,
    args: { agentName: string; message: string; systemMessage?: string },
  ): Promise<void> => {
    // Queue the actual run on the next microtask so runAskAgent can finish
    // its post-dispatch DB recheck before the child terminates. (Without
    // this beat the child can flip state synchronously inside runAskAgent
    // step 8, before step 9's recheck — still correct, just exercises the
    // "post-dispatch recheck found terminal" branch instead of "bus
    // emit settled the await".)
    queueMicrotask(() => {
      runChildTaskOnFakeProvider({
        db,
        bus,
        messages,
        childTaskId,
        contextId: getContextId(db, childTaskId),
        agentName: args.agentName,
        scriptPath: requireScript(opts.agentScripts, args.agentName),
        emit,
      }).catch((e) => {
        // Surface — failing to even start the child is a test bug, not a
        // production error mode worth exercising.
        // eslint-disable-next-line no-console
        console.error(`[boot-daemon] child dispatch failed: ${e}`);
      });
    });
  };

  // Default loadAgentDefn pulls from agent_cards; we override only when the
  // caller provided explicit defns (e.g. for ask_agent_allow tests).
  const loadAgentDefn = opts.agentDefns
    ? (name: string): AgentDefn => {
        const d = opts.agentDefns![name];
        if (!d) throw new Error(`unknown agent: ${name}`);
        return d;
      }
    : undefined;

  mountMcp(app, { vaultRoot, db, bus, dispatchChildTask, loadAgentDefn });
  mountAnswerRoute(app, { db, bus, pending: pendingRegistry });

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

function getContextId(db: Database, taskId: string): string {
  const row = db
    .query("SELECT context_id FROM tasks WHERE id = ?")
    .get(taskId) as { context_id: string } | undefined;
  if (!row) throw new Error(`task not found: ${taskId}`);
  return row.context_id;
}

function requireScript(
  scripts: Record<string, string>,
  agent: string,
): string {
  const s = scripts[agent];
  if (!s) throw new Error(`no fake script for agent: ${agent}`);
  return s;
}

interface RunChildArgs {
  db: Database;
  bus: EventBus;
  messages: ReturnType<typeof makeMessagesRepo>;
  childTaskId: string;
  contextId: string;
  agentName: string;
  scriptPath: string;
  emit: (t: string, p: Record<string, unknown>) => void;
}

/**
 * Drains a fake-provider script into the canonical messages table for a
 * pre-existing child task, then flips the child's state to COMPLETED (or
 * FAILED on script error) and emits task.state_changed.
 *
 * This mirrors the relevant slice of orchestrator.dispatch() — minus the
 * chat row, run row, lock acquisition, and titler — because child tasks
 * are not chats. They live as their own task rows under the parent's
 * context, dispatched by ask_agent and resolved by translateChildResult.
 */
async function runChildTaskOnFakeProvider(args: RunChildArgs): Promise<void> {
  const { db, bus, messages, childTaskId, contextId, scriptPath, emit } = args;
  const provider = makeFakeProvider({ scriptPath });

  // Flip child SUBMITTED -> WORKING so any observer sees a normal lifecycle.
  // Use raw UPDATE — setTaskState is constrained to two states and would
  // not accept SUBMITTED/COMPLETED transitions.
  db.run(
    "UPDATE tasks SET state='TASK_STATE_WORKING', updated_at=? WHERE id=?",
    [Date.now(), childTaskId],
  );

  const handle = provider.spawn({
    runId: childTaskId, // child has no run row; reuse id for prompt/logs only
    prompt: "", // injected by ask_agent.message in production; unused by fake provider
    cwd: "/tmp",
    chatId: contextId,
  });

  const agentParts: Part[] = [];
  let lastText = "";
  let firstAssistantSeen = false;
  let terminalState: "TASK_STATE_COMPLETED" | "TASK_STATE_FAILED" =
    "TASK_STATE_COMPLETED";

  try {
    for await (const evt of handle.events) {
      if (evt.type === "assistant") {
        firstAssistantSeen = true;
        const text = extractAssistantText(evt);
        if (text) {
          lastText += text;
          agentParts.push({ text } as Part);
        }
        for (const tu of extractToolUses(evt)) {
          agentParts.push({
            data: {
              kind: "tool_use",
              tool_call_id: tu.tool_call_id,
              tool_name: tu.name,
              input: tu.input,
            },
            metadata: { ts: Date.now() },
          } as unknown as Part);
        }
      } else if (evt.type === "user") {
        for (const tr of extractToolResults(evt)) {
          const outText =
            typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output);
          agentParts.push({
            data: {
              kind: "tool_result",
              tool_call_id: tr.tool_call_id,
              output: outText,
              is_error: tr.is_error,
            },
            metadata: { ts: Date.now() },
          } as unknown as Part);
        }
      }
    }
    await handle.done;
  } catch (e) {
    terminalState = "TASK_STATE_FAILED";
    emit("child.error", {
      child_task_id: childTaskId,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  if (firstAssistantSeen && agentParts.length > 0) {
    messages.appendMessage(
      childTaskId,
      contextId,
      null, // child has no run row in this harness
      "ROLE_AGENT",
      agentParts,
      Date.now(),
    );
  }

  db.run(
    "UPDATE tasks SET state=?, updated_at=? WHERE id=?",
    [terminalState, Date.now(), childTaskId],
  );

  // Emit task.state_changed so:
  //  - the ask_agent waitForChildTerminal listener resolves the parent's
  //    `await waitP`, returning the terminal state; runAskAgent then
  //    translates it to a tool result via translateChildResult.
  //  - the parent-resume listener (subscribed in bootInProcessDaemon) flips
  //    the parent task back to WORKING.
  bus.emit({
    type: "task.state_changed",
    payload: { taskId: childTaskId, state: terminalState },
  });
}
