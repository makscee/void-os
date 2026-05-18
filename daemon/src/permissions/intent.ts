// daemon/src/permissions/intent.ts
import type { AgentDefn } from "./engine";

export type AgentPermissionPosture = "read-only" | "workspace-write" | "open";

export interface AgentPermissionIntent {
  /**
   * Tri-state logical tool grants:
   * - `undefined` ⇒ legacy ("author said nothing") ⇒ adapter grants maximal set.
   * - `[]` ⇒ explicit "no tools" ⇒ adapter grants built-ins only, zero MCP.
   * - non-empty ⇒ intersected against allowlist.
   * Names are dotted registered form (e.g. `ask_user`), NOT CC-emitted `mcp__void-os__ask_user`.
   */
  tools?: string[];
  readPaths: string[];
  writePaths: string[];
  network: "none" | "allow";
  posture: AgentPermissionPosture;
  /** Logical tool denies — always ['AskUserQuestion']. → CC permissions.deny. */
  denyTools: string[];
  /** Filesystem write blocklist (homeRoot, ~/.ssh, etc). → CC VOS_SYSTEM_DENY env. */
  systemDenyPaths: string[];
}

function isCoveredBy(writePath: string, readPaths: string[]): boolean {
  // Coverage = string-prefix containment on normalized paths. This matches the
  // existing additionalDirectories semantics in spawn-settings.ts (CC treats
  // a directory grant as recursive). Glob authoring is out of scope here; if
  // future agents use globs, this check tightens with minimatch.
  const norm = (p: string) => p.endsWith("/") ? p : p + "/";
  const wp = norm(writePath);
  return readPaths.some((rp) => {
    const r = norm(rp);
    return wp === r || wp.startsWith(r);
  });
}

export function toIntent(
  defn: AgentDefn,
  scopes: { readPaths: string[]; writePaths: string[] },
  systemDenyPaths: string[],
): AgentPermissionIntent {
  const defaultPosture: AgentPermissionPosture = scopes.writePaths.length > 0 ? "workspace-write" : "read-only";
  const posture: AgentPermissionPosture = defn.posture ?? defaultPosture;
  // Coupled defaults: read-only posture defaults network to 'none' (least-privilege).
  // Write-capable posture defaults network to 'allow' (preserves today's behavior).
  const defaultNetwork: "none" | "allow" = posture === "read-only" ? "none" : "allow";
  const network: "none" | "allow" = defn.network ?? defaultNetwork;

  const denyTools = ["AskUserQuestion"];
  const tools = defn.tools === undefined ? undefined : defn.tools.filter((t) => !denyTools.includes(t));

  const readPaths = scopes.readPaths;
  const writePaths = scopes.writePaths;
  for (const wp of writePaths) {
    if (!isCoveredBy(wp, readPaths)) {
      throw new Error(`writePath ${wp} not covered by any readPath`);
    }
  }

  return {
    tools,
    readPaths,
    writePaths,
    network,
    posture,
    denyTools,
    systemDenyPaths,
  };
}
