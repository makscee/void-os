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
  };

  const mcp = {
    mcpServers: {
      "void-os": {
        type: "http",
        url: `${args.daemonBase}/mcp?agent=${encodeURIComponent(args.agentName)}&run=${encodeURIComponent(args.runId)}`,
      },
    },
  };

  const settingsPath = join(args.settingsDir, `${args.runId}.settings.json`);
  const mcpConfigPath = join(args.settingsDir, `${args.runId}.mcp.json`);
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  writeFileSync(mcpConfigPath, JSON.stringify(mcp, null, 2));

  const env: Record<string, string> = {
    VOS_READ_PATHS: JSON.stringify(args.scopes.readPaths),
    VOS_WRITE_PATHS: JSON.stringify(args.scopes.writePaths),
    VOS_SYSTEM_DENY: JSON.stringify(args.systemDeny),
    VOS_VAULT_ROOT: args.vaultRoot,
  };

  return { settingsPath, mcpConfigPath, env };
}
