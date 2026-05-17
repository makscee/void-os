// VOS-111: when --setting-sources project is set, CC still loads
// <vaultRoot>/.claude/settings.json if present. Log at boot so operators
// see what's effectively trusted; do not block (vault-authored project
// settings are intentional).

import { existsSync } from "node:fs";
import { join } from "node:path";

export function auditVaultProjectSettings(
  vaultRoot: string,
  log: (msg: string) => void = console.warn,
): void {
  const p = join(vaultRoot, ".claude", "settings.json");
  if (existsSync(p)) {
    log(
      `[VOS-111] vault project settings present at ${p} — loaded by --setting-sources project. ` +
      `Audit this file: any hooks, permissions, or enabledMcpjsonServers entries influence every spawned agent.`,
    );
  }
}
