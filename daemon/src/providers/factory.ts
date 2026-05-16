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
      daemonBase: env.VOS_DAEMON_BASE,
      // VOS-84: pass tracesDir + agent so the fake writes JSONL traces
      // matching the cc-spawner production wiring.
      tracesDir: deps.tracesDir,
      agent: deps.agent,
    });
  }
  throw new Error(`unknown provider: ${kind}`);
}
