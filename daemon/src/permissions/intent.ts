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

  return {
    tools,
    readPaths: scopes.readPaths,
    writePaths: scopes.writePaths,
    network,
    posture,
    denyTools,
    systemDenyPaths,
  };
}
