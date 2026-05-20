/**
 * Build the Hono app with all routes mounted.
 *
 * Split from index.ts so tests can drive `app.fetch` directly without
 * spinning up Bun.serve / binding a port.
 *
 * VOS-79 T8: buildApp is now `async` so it can lazily fetch the Anthropic
 * key (titler) at startup. Production callers must `await buildApp(...)`.
 * Tests can short-circuit the async wiring by injecting their own
 * `orchestrator` + `titler` — when both are provided, no SDK key fetch
 * occurs, keeping unit tests fully hermetic.
 */

import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import * as path from "node:path";
import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import pkg from "../package.json" with { type: "json" };
import { mountApi } from "./api/index.ts";
import { mountVault } from "./api/vault.ts";
import { makeRequireAuth } from "./auth/middleware.ts";
import { resolveTz } from "./cost/tz.ts";
import { chatsApi } from "./api/chats.ts";
import { agentsApi } from "./api/agents.ts";
import { chatApi, mountChatTaskStateFanout } from "./api/chat.ts";
import { mountMcp, defaultLoadAgentDefn } from "./adapters/mcp/index.ts";
import { makeHandoffLogFromEnv } from "./agents/handoff-log.ts";
import { mountAnswerRoute } from "./api/answer.ts";
import { createEventBus, type EventBus } from "./events/index.ts";
import { mountChatStream } from "./api/chat-stream.ts";
import { mountAgentsInflight } from "./api/agents-inflight.ts";
import { mountAgentsControl } from "./api/agents-control.ts";
import { mountAgentsHookEvent } from "./api/agents-hook-event.ts";
import { createAgentControlRegistry } from "./agents/control.ts";
import { createLiveAgentRegistry } from "./agents/live-agents.ts";
import {
  createInflightBridge,
  createInflightRegistry,
  createJsonlWriter,
  attachJsonlPersistence,
} from "./agents/inflight.ts";
import { createAskUserBridge } from "./chat/ask-user-bridge.ts";
import { makeProvider, type ProviderEnv } from "./providers/factory.ts";
import { createPermissionEngine } from "./permissions/engine.ts";
import { createVaultWriter } from "./vault/writer.ts";
import { runBootDenyProbe } from "./providers/claude-code/boot-probe.ts";
import { makeChatRepo } from "./chat/repo.ts";
import { makeSessionReplay } from "./chat/session-replay.ts";
import { makeTitler, type Titler } from "./chat/titler.ts";
import {
  makeOrchestrator,
  resumeParentOnChildTerminal,
  reconcileWaitingParents,
  type Orchestrator,
} from "./chat/orchestrator.ts";
import {
  makeDispatchChildTask,
  makeRedriveParentTask,
} from "./chat/dispatch-child.ts";
import { fetchAnthropicKey } from "./lib/anthropic-key.ts";
import { subscribeRunEnd } from "./cost/index.ts";

export const VERSION = pkg.version;

export interface BuildAppDeps {
  db: Database;
  vaultRoot: string;
  // Test seams: when provided, the default real-wire pipeline is bypassed.
  orchestrator?: Orchestrator;
  titler?: Titler;
  // Override the emit-to-clients fan-out (defaults to module-level broadcast()).
  emit?: (type: string, payload: Record<string, unknown>) => void;
  // Static chat-dispatch cwd. Defaults to VOID_OS_CHAT_CWD env or the daemon's
  // vaultRoot. Anchoring on the vault root keeps Bash exploration and relative
  // file ops inside the agent's read_scope; process.cwd() (where `bun run dev`
  // happened to be invoked from) leaked daemon source paths into the agent and
  // produced spurious READ_SCOPE_DENIED hits.
  chatCwd?: string;
  // Default agent name for cc-spawner static deps. Overridden per-chat via
  // the run-request agent field once T3 validation is in place (VOS-124).
  defaultAgent?: string;
  // VOS-106
  /** Daemon's own base URL — spawned CC reaches /mcp here. Defaults to
   *  `http://127.0.0.1:${PORT ?? 17777}`. */
  daemonBase?: string;
  /**
   * Opt-IN to the boot deny-probe. Defaults to false so tests stay fast and
   * don't fork `bun` per buildApp call. Production entrypoint
   * (`daemon/src/index.ts`) must explicitly pass `runBootProbe: true`.
   */
  runBootProbe?: boolean;
  // VOS-116 T5: shared bearer token + boot timestamp. Optional in deps so
  // tests can omit them; defaults are applied inside buildApp. Production
  // entrypoint (daemon/src/index.ts) always passes both.
  token?: string;
  bootTime?: number;
  // VOS-116 T10: optional injected EventBus. Tests use this to assert
  // subscribe/unsubscribe lifecycle on the SSE route. Production omits
  // it so buildApp constructs its own bus internally.
  eventBus?: EventBus;
  // VOS-155: session id used for per-session JSONL filename. Defaults to
  // VOID_OS_SESSION_ID env or "default". Tests pass an explicit id so
  // multiple parallel suites don't share the same on-disk file.
  sessionId?: string;
  // VOS-155: disable JSONL persistence entirely. Tests that don't assert
  // disk side-effects pass true to keep the filesystem clean.
  disableInflightJsonl?: boolean;
  /**
   * VOS-170: opt-IN to the durable parent-resume sweep at end of buildApp.
   * Defaults to false so tests don't fire real provider re-drives against
   * leftover WAITING_ON_AGENT rows. Production entrypoint
   * (`daemon/src/index.ts`) passes `runReconcileSweep: true`.
   */
  runReconcileSweep?: boolean;
}

export const buildApp = async (deps: BuildAppDeps): Promise<Hono> => {
  const app = new Hono();
  const token = deps.token ?? "test-token";
  const bootTime = deps.bootTime ?? Date.now();
  app.get("/", (c) => c.text(`void-os daemon v${VERSION}\n`));
  mountApi(app, {
    version: VERSION,
    db: deps.db,
    tz: resolveTz(process.env),
    vaultRoot: deps.vaultRoot,
    token,
    bootTime,
  });

  // VOS-116 T7: vault routes — bearer-auth required on every /vault/*.
  app.use("/vault/*", makeRequireAuth(token));
  mountVault(app, { vaultRoot: deps.vaultRoot });

  // Wire orchestrator + titler. Tests can inject both to skip SDK/key/cc
  // construction entirely. Production path: real bus → real claude-code
  // Provider (createCcSpawner + makeCcSpawnerIter + makeClaudeCodeProvider)
  // → orchestrator; titler uses real Anthropic SDK if key resolution
  // succeeds, otherwise a no-op stub so title generation simply
  // fails-soft via chat.title_failed.
  let orchestrator = deps.orchestrator;
  let titler = deps.titler;

  // VOS-88 T7: bus is shared between orchestrator wiring and the MCP server
  // (ask_user emits task.state_changed / message.appended via this bus).
  // Hoisted out of the orchestrator-only block so mountMcp can receive it.
  const bus = deps.eventBus ?? createEventBus({ db: deps.db });

  // VOS-118: the orchestrator's `emit(type, payload)` shim historically only
  // fanned out to WebSocket clients via broadcast(). The SSE /chat/:id/stream
  // route subscribes to the in-process bus, so chat.token / chat.tool_use /
  // chat.tool_result frames never reached SSE consumers (the CLI). Tee the
  // emit into the bus as well — the WS path is preserved (plugin reducer
  // tests etc. still see chat.* frames), and the bus path lights up the SSE
  // subscriber. Tests that inject `deps.emit` get the same tee so SSE
  // assertions stay consistent across wiring paths.
  const baseEmit = deps.emit ?? broadcast;
  const emit: (type: string, payload: Record<string, unknown>) => void = (
    type,
    payload,
  ) => {
    baseEmit(type, payload);
    bus.emit({ type, payload });
  };
  const bridge = createAskUserBridge({ db: deps.db, bus });

  // VOS-104 T8b: wire cost ledger subscriber. Without this, `run.end` events
  // from the cc provider (carrying usageTurns) never persist a `costs` row,
  // so ChatList's lifetime SUM(cost_usd) stays at 0 forever. Unit tests
  // wire this in isolation; production wiring was missing.
  subscribeRunEnd(bus, deps.db, {
    warn: (event, fields) => console.warn(`[cost] ${event}`, fields ?? {}),
  });

  // VOS-89 T11: when any task reaches a terminal state, check whether its
  // parent is parked in WAITING_ON_AGENT and flip the parent back to WORKING.
  // Mirrors the answer.ts INPUT_REQUIRED -> WORKING resume, but the trigger
  // is a child task terminating (ask_agent flow) rather than a user POST.
  // Wired here so even test-injected orchestrators get parent-resume.
  const ASK_AGENT_TERMINALS: ReadonlySet<string> = new Set([
    "TASK_STATE_COMPLETED",
    "TASK_STATE_FAILED",
    "TASK_STATE_CANCELED",
  ]);
  bus.subscribe("task.state_changed", (ev) => {
    const p = ev.payload as { taskId?: string; state?: string } | undefined;
    if (!p?.taskId || !p.state) return;
    if (!ASK_AGENT_TERMINALS.has(p.state)) return;
    resumeParentOnChildTerminal(deps.db, p.taskId, (t, payload) =>
      bus.emit({ type: t, payload }),
    );
  });

  // VOS-91 T8: fan-out chat.task.state_changed WS frames for every task
  // state transition. All chats share one WS broadcast channel — the
  // payload already carries chat_id for client-side filtering.
  mountChatTaskStateFanout({
    db: deps.db,
    bus,
    broadcast: (_chatId, frame) => emit(frame.type, frame.payload as Record<string, unknown>),
  });

  // VOS-106: permission engine + hook-script path + (opt-in) boot deny-probe.
  // Engine + hookScriptPath are used by both the orchestrator's provider
  // wire-up (real claude-code) and the child dispatcher. Hoisted out of
  // the `if (!orchestrator)` block so dispatchChildTask gets them even
  // when tests inject a stub orchestrator.
  const homeRoot = process.env.HOME ?? "";
  const engine = createPermissionEngine({ vaultRoot: deps.vaultRoot, homeRoot });
  // VOS-108: singleton VaultWriter shared by all vault.* write MCP tools. The
  // writer owns a process-local mutex and a tmpDir for atomic staging; all
  // tool factories MUST share one instance so concurrent ops serialize.
  const writer = createVaultWriter({ vaultRoot: deps.vaultRoot, db: deps.db });
  // Caller should always pass daemonBase (index.ts does). Fallback uses
  // VOID_OS_PORT not PORT — the latter clashes with claudev / dev tools.
  const daemonBase =
    deps.daemonBase ?? `http://127.0.0.1:${process.env.VOID_OS_PORT ?? "7777"}`;
  const hookScriptPath = path.join(
    import.meta.dir,
    "providers",
    "claude-code",
    "hook-bin",
    "pre-tool-use.ts",
  );

  // VOS-164: live-agent registry — the correlation source for the un-authed
  // POST /agents/hook-event ingest. The CC spawner (reached via makeProvider
  // for both the orchestrator's provider and the child dispatcher) registers
  // each run's agent_id on spawn and drops it on finalize. Hoisted here so
  // both the provider wire-up and dispatchChildTask share the same instance.
  const liveAgents = createLiveAgentRegistry();

  // VOS-106 ADR-0003: daemon currently runs from source tree; the hook
  // script must be present on disk. If it isn't, fail loudly with a
  // pointer to the ADR rather than letting the spawned CC discover it
  // mid-tool-call.
  if (!existsSync(hookScriptPath)) {
    throw new Error(
      `VOS-106: PreToolUse hook script not found at ${hookScriptPath}. ` +
        `Daemon currently runs from source only; see docs/adr/ADR-0003-daemon-runs-from-source.md.`,
    );
  }

  // Boot deny-probe — production-only. Tests inherit the default (off) so
  // they don't fork `bun` per buildApp. Production entrypoint passes
  // `runBootProbe: true` explicitly.
  if (deps.runBootProbe === true) {
    const probe = await runBootDenyProbe({ hookScriptPath });
    if (!probe.ok) {
      throw new Error(`VOS-106 boot deny-probe failed: ${probe.reason}`);
    }
  }

  if (!orchestrator || !titler) {
    const repo = makeChatRepo(deps.db);
    const replay = makeSessionReplay(deps.db);

    if (!titler) {
      const useStub =
        process.env.VOS_TITLER === "stub" ||
        (process.env.VOS_TITLER == null && process.env.VOS_PROVIDER === "fake");
      if (useStub) {
        titler = { title: async () => {} } satisfies Titler;
      } else {
        const sdk = await buildAnthropicSdk();
        titler = makeTitler({ repo, sdk, replay, emit });
      }
    }

    if (!orchestrator) {
      const tracesDir = path.join(deps.vaultRoot, ".traces");
      // process.env is an index-signatured ProcessEnv; ProviderEnv only names
      // optional VOS_* keys, so TS flags no-overlap. The cast is safe — the
      // provider factory just reads those keys when present (VOS-167).
      const provider = makeProvider(process.env as unknown as ProviderEnv, {
        bus,
        db: deps.db,
        tracesDir,
        liveAgents,
        // VOS-152: no hardcoded persona fallback. The provider-instance
        // `agent` is the calling-agent identity used in MCP loopback
        // (`/mcp?agent=...`) when a CC run dispatches ask_agent. Per-chat
        // runs override it via ProviderSpawnRequest.agent (VOS-122 F9);
        // chat creation already validates the agent name strictly
        // (chats.ts, VOS-124). If `deps.defaultAgent` is unset and no
        // chat-level agent is supplied, downstream surfaces an explicit
        // E_NO_CALLING_AGENT rather than silently impersonating "maya".
        agent: deps.defaultAgent,
        cwd: deps.chatCwd ?? process.env.VOID_OS_CHAT_CWD ?? deps.vaultRoot,
        engine,
        daemonBase,
        hookScriptPath,
        loadAgentDefn: (name) => defaultLoadAgentDefn(deps.db, name),
      });
      orchestrator = makeOrchestrator({
        db: deps.db,
        repo,
        provider,
        cwd: deps.chatCwd ?? process.env.VOID_OS_CHAT_CWD ?? deps.vaultRoot,
        emit,
        titler,
      });
    }
  }

  // VOS-79: chat-lifecycle HTTP surface. `chatsApi` owns list/create;
  // `chatApi` owns per-chat routes (GET /chat/:id, /messages, POST /message).
  app.route("/", chatsApi(deps.db));
  app.route("/", agentsApi(deps.db, deps.vaultRoot));
  // VOS-118: pass the shared bus so POST /chat/:id/message can return early
  // (with {run_id, status:"running"}) instead of blocking until dispatch
  // finishes — required for ask_user flows where dispatch parks indefinitely
  // waiting for /answer.
  app.route("/", chatApi(deps.db, { orchestrator, bus }));
  // VOS-161: agent control registry — the two-verb (pause/kill) + resume
  // intervention plane. dispatch-child registers a control handle per child
  // (keyed by childTaskId = the inspector's agent_id); the verb routes below
  // resolve handles from it. Created before dispatchChildTask so the
  // dispatcher can be wired with it.
  const agentControl = createAgentControlRegistry();
  // VOS-89 T15.5: real production dispatcher for ask_agent children. Per-
  // agent Provider memoisation lives inside the dispatcher; cwd +
  // tracesDir mirror the orchestrator wiring above so child runs share
  // the same trace tree + working dir as parent runs.
  const dispatchChildTask = makeDispatchChildTask({
    db: deps.db,
    bus,
    cwd: deps.chatCwd ?? process.env.VOID_OS_CHAT_CWD ?? deps.vaultRoot,
    tracesDir: path.join(deps.vaultRoot, ".traces"),
    emit,
    // VOS-106: thread the same engine + hook wiring used by the orchestrator
    // path so dispatched children spawn under identical scope enforcement.
    engine,
    daemonBase,
    hookScriptPath,
    loadAgentDefn: (name) => defaultLoadAgentDefn(deps.db, name),
    // VOS-161: each child registers a control handle on spawn so the
    // inspector pause/kill/resume verbs can address it mid-flight.
    control: agentControl,
    // VOS-164: forward the live-agent registry so a dispatched child's CC
    // spawner registers the child's agent_id for the hook-event gate.
    liveAgents,
  });
  // VOS-170: parent re-driver for the durable-resume sweep. Shares the same
  // provider wiring as dispatchChildTask; re-spawns a parked parent's Claude
  // session with `resumeFrom` so a daemon restart never strands a parent.
  const redriveParentTask = makeRedriveParentTask({
    db: deps.db,
    bus,
    cwd: deps.chatCwd ?? process.env.VOID_OS_CHAT_CWD ?? deps.vaultRoot,
    tracesDir: path.join(deps.vaultRoot, ".traces"),
    emit,
    engine,
    daemonBase,
    hookScriptPath,
    loadAgentDefn: (name) => defaultLoadAgentDefn(deps.db, name),
    control: agentControl,
    liveAgents,
  });
  // VOS-154: build env-driven handoff-log adapter. NULL when VOID_OS_HL_PATH
  // is unset (smoke harness, tests). Threaded into ask_agent so every
  // sibling-dispatch leaves a provenance entry in the hub-side log.
  const handoffLog = makeHandoffLogFromEnv(process.env);

  mountMcp(app, {
    vaultRoot: deps.vaultRoot,
    db: deps.db,
    bus,
    bridge,
    dispatchChildTask,
    emit,
    // VOS-106: thread the permission engine so vault.read can gate per-agent
    // read_scope. mountMcp resolves the calling-agent identity from
    // ?agent=<name> and pairs it with this engine inside buildMcpServer.
    engine,
    writer,
    // VOS-154: provenance adapter + identity threading.
    handoffLog,
    sessionId: process.env.VOID_OS_SESSION_ID ?? null,
    milestone: process.env.VOID_OS_MILESTONE ?? null,
  });
  // VOS-100: user-facing answer route. Shares the SAME `bridge` instance
  // with mountMcp so the MCP tool handler (which awaits via bridge.open)
  // and the HTTP route (which resolves via bridge.resolve) reference the
  // same in-process awaiter map.
  mountAnswerRoute(app, { db: deps.db, bridge, emit });

  // VOS-116 T10: per-chat SSE stream — bearer-auth required, fans out
  // events from the shared bus filtered to the URL's chat id.
  app.use("/chat/:id/stream", makeRequireAuth(token));
  mountChatStream(app, { db: deps.db, bus, version: VERSION });

  // VOS-155: in-flight agent inspector substrate.
  //   - bridge translates legacy chat.*/task.state_changed/run.end/child.*
  //     frames into agent.event on the same bus.
  //   - registry maintains an in-memory snapshot keyed by agent_id.
  //   - JSONL writer persists each event to a per-session log file.
  //   - GET /agents/inflight returns snapshot + SSE delta stream.
  createInflightBridge({ bus, db: deps.db });
  // VOS-161: thread the control registry so /agents/inflight snapshots
  // carry each agent's live control_state (running/paused/killed).
  const inflightRegistry = createInflightRegistry({ bus, control: agentControl });
  if (!deps.disableInflightJsonl) {
    const sessionId =
      deps.sessionId ?? process.env.VOID_OS_SESSION_ID ?? "default";
    const inflightWriter = createJsonlWriter({
      vaultRoot: deps.vaultRoot,
      sessionId,
      // Skip fsync per-record in tests; the env override (false) keeps
      // suites fast. Production callers (daemon/src/index.ts) inherit
      // the default true via `disableInflightJsonl=false` + no override.
      fsync: process.env.VOID_OS_INFLIGHT_FSYNC !== "0",
    });
    attachJsonlPersistence(bus, inflightWriter);
  }
  app.use("/agents/inflight", makeRequireAuth(token));
  mountAgentsInflight(app, { bus, registry: inflightRegistry, version: VERSION });
  // VOS-161: pause/kill/resume verb routes — bearer-auth gated like
  // /agents/inflight. Hono matches the more specific /agents/:id/* paths
  // before the /agents/inflight prefix, so the two auth middlewares don't
  // collide.
  app.use("/agents/:id/pause", makeRequireAuth(token));
  app.use("/agents/:id/resume", makeRequireAuth(token));
  app.use("/agents/:id/kill", makeRequireAuth(token));
  // VOS-162: branch verb — auth-gated like the control verbs. Forks the
  // agent's repo (= the daemon's chat cwd) into a new worktree from HEAD.
  app.use("/agents/:id/branch", makeRequireAuth(token));
  // VOS-165: branch-worktree prune — auth-gated. Removes the `branch/*`
  // worktrees the branch verb accumulates. Static path, so it does not
  // collide with the `/agents/:id/*` param middlewares.
  app.use("/agents/branch/prune", makeRequireAuth(token));
  mountAgentsControl(app, {
    bus,
    control: agentControl,
    inflight: inflightRegistry,
    repoRoot: deps.chatCwd ?? process.env.VOID_OS_CHAT_CWD ?? deps.vaultRoot,
  });
  // VOS-162 Source A: CC harness hook ingest. Un-authed loopback route —
  // same trust posture as /mcp (the hook scripts are spawned by this
  // daemon, only reach it over 127.0.0.1, and carry no bearer token). It
  // completes the union event view: PreToolUse/PostToolUse hook events
  // land here and re-enter the same `agent.event` bus Source B feeds.
  // VOS-164: because the route is un-authed, it gates each event on the
  // live-agent registry — an event for an agent_id the daemon never
  // spawned is rejected with 403, blocking forged-event injection.
  mountAgentsHookEvent(app, { bus, liveAgents });

  // VOS-170: durable parent-resume sweep (ADR-0008). A parent parked in
  // WAITING_ON_AGENT whose children all reached terminal — but whose wake
  // hint (the in-memory bus) and CC subprocess both died with a previous
  // daemon — is re-driven here. Runs after mountMcp so a resumed parent that
  // fires a fresh ask_agent reaches a live MCP server. Opt-in
  // (`runReconcileSweep`) so tests don't fire real provider re-drives.
  if (deps.runReconcileSweep === true) {
    const resumed = reconcileWaitingParents(deps.db, redriveParentTask);
    if (resumed > 0) {
      console.log(`  reconcile: re-drove ${resumed} parked parent task(s)`);
    }
  }

  return app;
};

/**
 * Build a real Anthropic SDK if `fetchAnthropicKey` resolves a key,
 * otherwise return a stub whose `messages.create` rejects. The titler
 * already catches and reports failures via `chat.title_failed`, so a
 * missing key degrades to "no auto-titles" rather than crashing boot.
 */
async function buildAnthropicSdk(): Promise<
  Parameters<typeof makeTitler>[0]["sdk"]
> {
  try {
    const key = await fetchAnthropicKey();
    return new Anthropic({ apiKey: key }) as unknown as Parameters<
      typeof makeTitler
    >[0]["sdk"];
  } catch {
    return {
      messages: {
        create: async () => {
          throw new Error("anthropic key unavailable");
        },
      },
    };
  }
}

/**
 * VOS-79 T9: connected /events sockets + broadcast() fan-out.
 *
 * Shared module-level Set so wsHandler (open/close) and broadcast (orchestrator
 * emit shim) reference the same client roster. One daemon process owns one
 * roster; tests that boot multiple servers in-process share it too, which is
 * fine — broadcasts are typed envelopes, not per-server state.
 *
 * Envelope shape: `{type, ts: <epoch ms>, ...payload}`. `payload` keys take
 * precedence over the wrapper (so `chat_id`, `run_id`, etc. land at top level).
 */
const sockets = new Set<ServerWebSocket<unknown>>();

export const broadcast = (
  type: string,
  payload: Record<string, unknown> = {},
): void => {
  const msg = JSON.stringify({ type, ts: Date.now(), ...payload });
  for (const ws of sockets) {
    try { ws.send(msg); } catch { /* socket dead — close handler will drain */ }
  }
};

/**
 * Test-only: drop all connected sockets without sending anything. Real wire
 * closes happen via the `close` handler. Used by tests that share the module
 * to avoid cross-test bleed.
 */
export const _resetBroadcastSockets = (): void => {
  sockets.clear();
};

/**
 * WebSocket handler for /events. Exported so tests can mount it via
 * `Bun.serve({ websocket: wsHandler, ... })` without spawning the daemon.
 *
 * Wire protocol v1:
 *   open      → server sends {type:"hello", version:"<semver>"}; socket joins
 *               the broadcast set so it receives subsequent broadcast() frames.
 *   ping      → server replies {type:"pong"}
 *   unknown   → server ignores (no reply frame)
 *   close     → socket leaves the broadcast set
 */
export const wsHandler: WebSocketHandler<unknown> = {
  // VOS-104: /events is long-lived. Default Bun WS idleTimeout (120s) drops
  // the socket during ask_user waits, so plugin bus listeners miss
  // subsequent chat.task.state_changed frames. 255s = Bun max.
  idleTimeout: 255,
  open(ws: ServerWebSocket<unknown>) {
    sockets.add(ws);
    ws.send(JSON.stringify({ type: "hello", version: VERSION }));
  },
  message(ws: ServerWebSocket<unknown>, msg: string | Buffer) {
    const text = typeof msg === "string" ? msg : msg.toString();
    let parsed: { type?: unknown } | undefined;
    try { parsed = JSON.parse(text) as { type?: unknown }; } catch { return; }
    if (parsed?.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }
    // unknown type: ignore in v1
  },
  close(ws: ServerWebSocket<unknown>) {
    sockets.delete(ws);
  },
};
