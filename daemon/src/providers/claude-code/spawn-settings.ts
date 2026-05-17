// VOS-106 T5: per-spawn settings builder. Pure function (modulo
// the two JSON files it writes). Inputs are deterministic; outputs are
// the two paths CC needs (--settings, --mcp-config) plus the env vars
// the PreToolUse hook script consumes.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildSpawnSettingsArgs {
  agentName: string;
  scopes: { readPaths: string[]; writePaths: string[] };
  systemDeny: string[];
  vaultRoot: string;
  daemonBase: string;
  runId: string;
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

  // MCP URL: only ?agent= is read by the daemon. Including &run=<runId>
  // (different per dispatch) caused CC's MCP client to treat each turn as
  // a fresh server, re-fetching tool definitions and busting the Anthropic
  // prompt cache — ~22k cache_create tokens per turn (~$0.42/turn on Opus).
  // Keep the URL stable across runs; runId is already in the trace/db.
  const mcp = {
    mcpServers: {
      "void-os": {
        type: "http",
        url: `${args.daemonBase}/mcp?agent=${encodeURIComponent(args.agentName)}`,
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
