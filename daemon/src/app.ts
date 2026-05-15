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
import Anthropic from "@anthropic-ai/sdk";
import pkg from "../package.json" with { type: "json" };
import { mountApi } from "./api/index.ts";
import { chatsApi } from "./api/chats.ts";
import { agentsApi } from "./api/agents.ts";
import { chatApi } from "./api/chat.ts";
import { mountMcp, pendingRegistry } from "./adapters/mcp/index.ts";
import { mountAnswerRoute } from "./api/answer.ts";
import { createEventBus } from "./events/index.ts";
import { makeProvider } from "./providers/factory.ts";
import { makeChatRepo } from "./chat/repo.ts";
import { makeSessionReplay } from "./chat/session-replay.ts";
import { makeTitler, type Titler } from "./chat/titler.ts";
import { makeTitlerStub } from "./chat/titler-stub.ts";
import {
  makeOrchestrator,
  type Orchestrator,
} from "./chat/orchestrator.ts";
import { fetchAnthropicKey } from "./lib/anthropic-key.ts";

export const VERSION = pkg.version;

export interface BuildAppDeps {
  db: Database;
  vaultRoot: string;
  // Test seams: when provided, the default real-wire pipeline is bypassed.
  orchestrator?: Orchestrator;
  titler?: Titler;
  // Override the emit-to-clients fan-out (defaults to module-level broadcast()).
  emit?: (type: string, payload: Record<string, unknown>) => void;
  // Static chat-dispatch cwd. Defaults to VOID_OS_CHAT_CWD env or process.cwd().
  chatCwd?: string;
  // Default agent name for cc-spawner static deps. Overridden in production
  // wiring once per-chat agent lookup lands; for now mirrors the chats.agent
  // default ("maya").
  defaultAgent?: string;
}

export const buildApp = async (deps: BuildAppDeps): Promise<Hono> => {
  const app = new Hono();
  app.get("/", (c) => c.text(`void-os daemon v${VERSION}\n`));
  mountApi(app, { version: VERSION, db: deps.db });

  const emit = deps.emit ?? broadcast;

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
  const bus = createEventBus({ db: deps.db });

  if (!orchestrator || !titler) {
    const repo = makeChatRepo(deps.db);
    const replay = makeSessionReplay(deps.db);

    if (!titler) {
      const useStub =
        process.env.VOS_TITLER === "stub" ||
        (process.env.VOS_TITLER == null && process.env.VOS_PROVIDER === "fake");
      if (useStub) {
        titler = makeTitlerStub();
      } else {
        const sdk = await buildAnthropicSdk();
        titler = makeTitler({ repo, sdk, replay, emit });
      }
    }

    if (!orchestrator) {
      const tracesDir = path.join(deps.vaultRoot, ".traces");
      const provider = makeProvider(process.env, {
        bus,
        db: deps.db,
        tracesDir,
        agent: deps.defaultAgent ?? "maya",
        cwd: deps.chatCwd ?? process.env.VOID_OS_CHAT_CWD ?? process.cwd(),
      });
      orchestrator = makeOrchestrator({
        db: deps.db,
        repo,
        provider,
        cwd: deps.chatCwd ?? process.env.VOID_OS_CHAT_CWD ?? process.cwd(),
        emit,
        titler,
      });
    }
  }

  // VOS-79: chat-lifecycle HTTP surface. `chatsApi` owns list/create;
  // `chatApi` owns per-chat routes (GET /chat/:id, /messages, POST /message).
  app.route("/", chatsApi(deps.db));
  app.route("/", agentsApi(deps.db));
  app.route("/", chatApi(deps.db, { orchestrator }));
  mountMcp(app, { vaultRoot: deps.vaultRoot, db: deps.db, bus });
  // VOS-88 T8: user-facing answer route. Shares the SAME `pendingRegistry`
  // singleton with mountMcp so the MCP tool handler (which awaits the slot)
  // and the HTTP route (which resolves it) reference the same map.
  mountAnswerRoute(app, { db: deps.db, bus, pending: pendingRegistry });
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
