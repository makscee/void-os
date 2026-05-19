// VOS-106 T5: per-spawn settings builder. Pure function (modulo
// the two JSON files it writes). Inputs are deterministic; outputs are
// the two paths CC needs (--settings, --mcp-config) plus the env vars
// the PreToolUse hook script consumes.

import { writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentPermissionIntent } from "../../permissions/intent";

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

// VOS-111: built-in CC tools. Not agent-scoped — every spawn gets these
// regardless of the agent.md frontmatter. They are filesystem-level surfaces
// that the PreToolUse hook already gates per-path.
export const ALLOWED_BUILTIN_TOOLS: readonly string[] = Object.freeze([
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
]);

// VOS-122 F7: maximal MCP tool set exposed by the void-os server. The
// agent's frontmatter `tools:` field is the authoritative gate — this
// constant is the maximal set the spawner intersects with. Names use the
// registered (dotted) form; intersection happens BEFORE conversion to the
// CC-emitted `mcp__void-os__*` form via `mcpToolNameFor`.
export const ALLOWED_MCP_TOOLS_VOID_OS: readonly string[] = Object.freeze([
  "vault.read",
  "vault.create",
  "vault.append",
  "vault.replace_section",
  "vault.set_property",
  "vault.patch",
  "vault.delete",
  "vault.move",
  "vault.load_template",
  "ask_user",
  "ask_agent",
]);

// Back-compat: pre-F7 callers (tests, hook scripts, runbook docs) imported
// `ALLOWED_TOOLS` as the full superset. Keep it as the union of the two
// split constants so those imports keep working. The CC spawner no longer
// hands this list directly to `--tools` — it now passes a per-spawn
// effective list computed in `buildSpawnSettings`.
export const ALLOWED_TOOLS: readonly string[] = Object.freeze([
  ...ALLOWED_BUILTIN_TOOLS,
  ...ALLOWED_MCP_TOOLS_VOID_OS.map((t) => mcpToolNameFor("void-os", t)),
]);

export const ALLOWED_MCP_SERVERS: readonly string[] = Object.freeze(["void-os"]);

// Pinned by T0 — runbook records SETTING_SOURCES as single comma-string value `project`.
export const SETTING_SOURCES_ARGS: readonly string[] = Object.freeze([
  "--setting-sources",
  "project",
]);

export interface BuildSpawnSettingsArgs {
  agentName: string;
  /**
   * VOS-145: provider-neutral permission intent. Carries scopes
   * (`readPaths`/`writePaths`), declared tools (tri-state), `denyTools` (CC
   * `permissions.deny`), and `systemDenyPaths` (F7 filesystem write-blocker,
   * → `VOS_SYSTEM_DENY` env). The caller builds this via `toIntent(defn,
   * scopes, systemDenyPaths)`; `network` + `posture` fields are carried
   * through but not consumed by the CC adapter today (Codex adapter will
   * use them).
   *
   * **`denyTools` and `systemDenyPaths` are distinct.** Wiring one into the
   * other silently breaks F7's write blocklist or VOS-107's AskUserQuestion
   * gate — see `permissions/intent.ts` doc comments.
   */
  intent: AgentPermissionIntent;
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
  /**
   * VOS-122 F7: effective `--tools` argument list (CC-emitted names) for
   * this spawn — built-ins + intersected MCP tools. Caller is expected to
   * pass this verbatim to CC instead of the global {@link ALLOWED_TOOLS}.
   */
  toolsArg: string[];
}

// VOS-122 F7: one-shot deprecation warning per agent. Prevents log spam when
// a legacy agent is spawned many times. Module-scoped because the warning is
// about the agent's static frontmatter, not the per-run spawn.
const _legacyToolsWarned = new Set<string>();
export function _resetLegacyToolsWarnedForTests(): void {
  _legacyToolsWarned.clear();
}

/**
 * VOS-122 F7: compute the per-spawn `--tools` arg list.
 *
 * - Built-ins are always granted.
 * - `declaredTools === undefined` => legacy: grant the maximal MCP set and
 *   warn once per agent name (operator hasn't migrated the agent.md yet).
 * - Otherwise intersect `declaredTools` with `ALLOWED_MCP_TOOLS_VOID_OS`.
 *   Declared names not in the maximal set are silently dropped — the
 *   maximal set is the source of truth for what MCP tools actually exist.
 */
export function computeEffectiveTools(
  agentName: string,
  declaredTools: string[] | undefined,
): string[] {
  const builtins = [...ALLOWED_BUILTIN_TOOLS];
  let mcpTools: string[];
  if (declaredTools === undefined) {
    if (!_legacyToolsWarned.has(agentName)) {
      _legacyToolsWarned.add(agentName);
      console.warn(
        `spawn-settings: agent "${agentName}" has no \`tools:\` frontmatter — ` +
          `granting maximal MCP set (DEPRECATED, will tighten in a future ` +
          `release; add a \`tools:\` array to agent.md to silence this warning)`,
      );
    }
    mcpTools = [...ALLOWED_MCP_TOOLS_VOID_OS];
  } else {
    const declared = new Set(declaredTools);
    mcpTools = ALLOWED_MCP_TOOLS_VOID_OS.filter((t) => declared.has(t));
  }
  return [
    ...builtins,
    ...mcpTools.map((t) => mcpToolNameFor("void-os", t)),
  ];
}

function pathHeadIsUnderRoot(pattern: string, root: string): boolean {
  // Treat the pattern's literal prefix as the head. If the head is the root
  // itself or a path under it, the pattern lives under vaultRoot.
  const metaIdx = pattern.search(/[*?[{]/);
  const head = metaIdx === -1 ? pattern : pattern.slice(0, metaIdx);
  return head === root || head.startsWith(root + "/");
}

export function buildSpawnSettings(args: BuildSpawnSettingsArgs): SpawnSettings {
  const additionalDirectories = args.intent.readPaths.filter(
    (p) => !pathHeadIsUnderRoot(p, args.vaultRoot),
  );

  const toolsArg = computeEffectiveTools(args.agentName, args.intent.tools);

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
    // VOS-142: pre-approve every tool we hand to --tools so CC stops gating
    // mcp__void-os__* calls. Hooks still fire BEFORE rule evaluation
    // (docs.claude.com/en/docs/claude-code/sdk/sdk-permissions), so the
    // PreToolUse path gate remains authoritative for filesystem scope.
    // MAINTAINER: do NOT add --bare or --dangerously-skip-permissions to
    // the spawn flags — both skip the PreToolUse layer that enforces F7.
    permissions: {
      allow: toolsArg,
      // VOS-107: AskUserQuestion denied so agents reach the user via the MCP
      // vos_ask_user surface (plugin renders option buttons). Without this,
      // the model prefers the trained-in name and the plugin shows raw JSON.
      // VOS-145: `toIntent` always emits `denyTools = ['AskUserQuestion']`,
      // preserving this invariant byte-for-byte under the new intent shape.
      deny: args.intent.denyTools,
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
    VOS_READ_PATHS: JSON.stringify(args.intent.readPaths),
    VOS_WRITE_PATHS: JSON.stringify(args.intent.writePaths),
    // VOS-145: F7 filesystem write blocklist (homeRoot, ~/.ssh, etc) flows
    // through `intent.systemDenyPaths`. NOT `intent.denyTools` — that is the
    // logical tool-name deny list (→ permissions.deny above). Collapsing the
    // two silently disables one of the two gates.
    VOS_SYSTEM_DENY: JSON.stringify(args.intent.systemDenyPaths),
    VOS_VAULT_ROOT: args.vaultRoot,
    NO_PROXY: noProxyEntries.join(","),
  };

  return { settingsPath, mcpConfigPath, env, toolsArg };
}
