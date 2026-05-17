// VOS-106 T5: per-spawn settings builder. Pure function (modulo
// the two JSON files it writes). Inputs are deterministic; outputs are
// the two paths CC needs (--settings, --mcp-config) plus the env vars
// the PreToolUse hook script consumes.

import { writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// VOS-112: stdio bridge entrypoint shipped with the daemon. The daemon runs
// from source (ADR-0003), so this path is the source file itself. Resolved
// once at module init; an existsSync assertion makes a misconfigured tree
// fail at daemon boot rather than at first CC spawn.
const BRIDGE_PATH = resolve(
  import.meta.dir, "..", "..", "adapters", "mcp", "stdio-bridge.ts",
);
if (!existsSync(BRIDGE_PATH)) {
  throw new Error(`VOS-112 stdio-bridge.ts not found at ${BRIDGE_PATH}`);
}

// Absolute bun binary path — survives systemd / launchd that strip the user
// shell PATH. `process.execPath` is the bun running the daemon itself, so a
// spawned CC subprocess inherits the daemon's exact runtime.
const BUN_PATH = process.env.VOS_BUN_PATH ?? process.execPath;

// VOS-111: agent isolation surface.
//
// The spawned CC subprocess must NOT load operator-personal config from
// ~/.claude/. The three flags in index.ts (--strict-mcp-config,
// --setting-sources, --tools) carry the constants below.
//
// MCP tool names: CC exposes registered MCP tools as
// `mcp__<server>__<tool>` with `.` rewritten to `_`. The exact form was
// pinned by VOS-111 T0 — see daemon/test/probes/vos-111-isolation-probe.md.

export function mcpToolNameFor(server: string, tool: string): string {
  return `mcp__${server}__${tool.replace(/\./g, "_")}`;
}

export const ALLOWED_TOOLS: readonly string[] = Object.freeze([
  "Bash",
  "Edit",
  "MultiEdit",
  "Read",
  "Write",
  "Grep",
  "Glob",
  "NotebookEdit",
  "NotebookRead",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  mcpToolNameFor("void-os", "vault.read"),
  mcpToolNameFor("void-os", "ask_user"),
  mcpToolNameFor("void-os", "ask_agent"),
]);

export const ALLOWED_MCP_SERVERS: readonly string[] = Object.freeze(["void-os"]);

// Pinned by T0 — runbook records SETTING_SOURCES as single comma-string value `project`.
export const SETTING_SOURCES_ARGS: readonly string[] = Object.freeze([
  "--setting-sources",
  "project",
]);

export interface BuildSpawnSettingsArgs {
  agentName: string;
  scopes: { readPaths: string[]; writePaths: string[] };
  systemDeny: string[];
  vaultRoot: string;
  daemonBase: string;
  runId: string;
  // VOS-112: per-spawn runtime ids consumed by stdio bridge via env.
  taskId: string;
  contextId: string;
  settingsDir: string;
  hookScriptPath: string;
}

export interface SpawnSettings {
  settingsPath: string;
  mcpConfigPath: string;
  env: Record<string, string>;
}

function pathHeadIsUnderRoot(pattern: string, root: string): boolean {
  // Treat the pattern's literal prefix as the head. If the head is the root
  // itself or a path under it, the pattern lives under vaultRoot.
  const metaIdx = pattern.search(/[*?[{]/);
  const head = metaIdx === -1 ? pattern : pattern.slice(0, metaIdx);
  return head === root || head.startsWith(root + "/");
}

export function buildSpawnSettings(args: BuildSpawnSettingsArgs): SpawnSettings {
  const additionalDirectories = args.scopes.readPaths.filter(
    (p) => !pathHeadIsUnderRoot(p, args.vaultRoot),
  );

  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Read|Glob|Grep|Bash|Edit|Write|MultiEdit",
          hooks: [{ type: "command", command: `bun ${args.hookScriptPath}` }],
        },
      ],
    },
    additionalDirectories,
    // Block the built-in AskUserQuestion tool so agents reach the user via
    // the MCP vos_ask_user surface (which the void-os plugin renders as
    // option buttons). Without this, the model prefers the trained-in name
    // and the plugin shows the raw tool input as JSON.
    permissions: {
      deny: ["AskUserQuestion"],
    },
  };

  // VOS-112: stdio MCP transport. Per-spawn env carries runtime ids that
  // the daemon-side handlers read off `extra._meta` (ADR-0002). Stable
  // command+args across runs keeps CC's prompt-cache hot; only env varies.
  const mcp = {
    mcpServers: {
      "void-os": {
        type: "stdio",
        command: BUN_PATH,
        args: [BRIDGE_PATH],
        env: {
          VOS_DAEMON_BASE: args.daemonBase,
          VOS_AGENT:       args.agentName,
          VOS_TASK_ID:     args.taskId,
          VOS_CONTEXT_ID:  args.contextId,
          ...(args.runId ? { VOS_RUN_ID: args.runId } : {}),
        },
      },
    },
  };

  const settingsPath = join(args.settingsDir, `${args.runId}.settings.json`);
  const mcpConfigPath = join(args.settingsDir, `${args.runId}.mcp.json`);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  writeFileSync(mcpConfigPath, JSON.stringify(mcp, null, 2));

  // VOS-106 T10.C: bypass any inherited HTTP(S)_PROXY for loopback so CC's
  // MCP client can reach the daemon's /mcp endpoint directly. claudev
  // exports HTTPS_PROXY=http://127.0.0.1:<port> (its usage-tracking CONNECT
  // proxy), and CC's MCP HTTP transport otherwise routes our plain-HTTP
  // loopback URL through that proxy — which rejects HTTP forwarding with
  // "This is a CONNECT proxy", surfacing as `mcp_servers[void-os].status="failed"`
  // in system.init. Merging NO_PROXY here keeps any operator-set NO_PROXY
  // suffixed onto loopback rather than clobbered.
  const inheritedNoProxy = (process.env.NO_PROXY ?? "").trim();
  const noProxyEntries = ["127.0.0.1", "localhost", "::1"];
  if (inheritedNoProxy) noProxyEntries.push(inheritedNoProxy);
  const env: Record<string, string> = {
    VOS_READ_PATHS: JSON.stringify(args.scopes.readPaths),
    VOS_WRITE_PATHS: JSON.stringify(args.scopes.writePaths),
    VOS_SYSTEM_DENY: JSON.stringify(args.systemDeny),
    VOS_VAULT_ROOT: args.vaultRoot,
    NO_PROXY: noProxyEntries.join(","),
  };

  return { settingsPath, mcpConfigPath, env };
}
