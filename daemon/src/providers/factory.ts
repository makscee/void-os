/**
 * Provider factory — dispatches on VOS_PROVIDER env.
 *
 * Default: "claude-code" (production). e2e sets "fake".
 */
import type { Provider } from "./types.ts";
import { makeClaudeCodeProviderComposed } from "./claude-code/index.ts";
import {
  makeFakeProvider,
  resolveFakeScript,
  resolveFakePerEventDelayMs,
} from "./fake/index.ts";
import type { Database } from "bun:sqlite";
import type { EventBus } from "../events/index.ts";
import type { PermissionEngine, AgentDefn } from "../permissions/engine.ts";

export interface ProviderEnv {
  VOS_PROVIDER?: string;
  VOS_FAKE_SCRIPT?: string;
  /** Daemon's own base URL for loopback MCP calls in fake mode. */
  VOS_DAEMON_BASE?: string;
}

export interface ProviderDeps {
  bus: EventBus;
  db: Database;
  tracesDir: string;
  agent: string;
  cwd: string;
  // VOS-106
  engine: PermissionEngine;
  daemonBase: string;
  hookScriptPath: string;
  loadAgentDefn: (name: string) => AgentDefn;
}

export function makeProvider(env: ProviderEnv, deps: ProviderDeps): Provider {
  const kind = env.VOS_PROVIDER ?? "claude-code";
  if (kind === "claude-code") {
    return makeClaudeCodeProviderComposed({
      bus: deps.bus,
      db: deps.db,
      tracesDir: deps.tracesDir,
      agent: deps.agent,
      cwd: deps.cwd,
      engine: deps.engine,
      daemonBase: deps.daemonBase,
      hookScriptPath: deps.hookScriptPath,
      loadAgentDefn: deps.loadAgentDefn,
    });
  }
  if (kind === "fake") {
    const scriptPath = resolveFakeScript(deps.agent) ?? env.VOS_FAKE_SCRIPT;
    if (!scriptPath) {
      throw new Error("VOS_PROVIDER=fake requires VOS_FAKE_SCRIPT env var");
    }
    const perEventDelayMs = resolveFakePerEventDelayMs(deps.agent);
    return makeFakeProvider({
      scriptPath,
      perEventDelayMs,
      // VOS-118: fake provider's vos_ask_user directive POSTs to /mcp on the
      // daemon. It requires a base URL — prefer the explicit env override (used
      // by some legacy tests), fall back to the daemon's own base (which app.ts
      // computes from VOID_OS_PORT). Without this fallback, top-level
      // vos_ask_user tests silently throw "requires daemonBase" inside the
      // provider's generator, the orchestrator sees no further yields, and the
      // run ends "done" with no ask_user SSE frame — exactly the symptom
      // VOS-118 T8 hit before the fix.
      daemonBase: env.VOS_DAEMON_BASE ?? deps.daemonBase,
      // VOS-84: pass tracesDir + agent so the fake writes JSONL traces
      // matching the cc-spawner production wiring.
      tracesDir: deps.tracesDir,
      agent: deps.agent,
      // VOS-104: pass bus + db so the fake emits a bus `run.end` with
      // usageTurns at successful exit — feeds subscribeRunEnd so e2e cost
      // assertions land on a real row.
      bus: deps.bus,
      db: deps.db,
    });
  }
  throw new Error(`unknown provider: ${kind}`);
}
