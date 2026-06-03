// audit.ts — vault-MCP v1 audit-line JSONL writer (VOS-226 / contract §4).
// Append-only trace of every vault write (native fs Write/Edit/MultiEdit via the
// PreToolUse hook, source:"native"; MCP vault.write/append, source:"mcp"). AUDIT-ONLY
// in v1: no enforcement / scope-DENY — the `denied` flag is the v2 seam.
// THE single cross-phase import: P1 (daemon-hosted MCP) imports appendAudit() / auditPath().
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One audit line (frozen shape — contract §4.1). */
export interface AuditLine {
  ts: number;                 // epoch ms
  exec: string | null;        // self-reported caller id (mcp) / runId attribution (native), or null
  agent: string | null;       // agent name, or null
  tool: "vault.write" | "vault.append" | "Write" | "Edit" | "MultiEdit";
  path: string;               // vault-relative
  bytes: number;              // content byte length (mcp) or best-effort from tool_input (native)
  source: "mcp" | "native";
  denied?: boolean;           // true iff SYSTEM_DENY matched (v1: mcp blocks; native logs-only)
}

/** Absolute path to the append-only audit log: <vault>/.void-os/audit.jsonl (contract §4, R-1). */
export function auditPath(vault: string): string {
  return join(vault, ".void-os", "audit.jsonl");
}

/**
 * SYSTEM_DENY path prefixes (contract §1.5 / §4, frozen set, resolved to disk reality R-1).
 * A vault-relative path under any of these is system-protected. In v1 the MCP path HARD-BLOCKS;
 * the native path is AUDIT-ONLY (logs `denied:true`, never blocks). This is the v2-enforcement seam.
 * Note `~/.claude/**` is outside the vault, so it can never be a vault-relative match here —
 * it is enforced by the vault-escape check in the MCP path, not this matcher.
 */
const SYSTEM_DENY_PREFIXES = ["agents/", ".void-os/"] as const;

/**
 * True iff `vaultRelPath` (vault-relative, forward-slash, no leading "./" or "/") lands under a
 * SYSTEM_DENY prefix. Matches the dir itself and anything beneath it.
 */
export function isSystemDeny(vaultRelPath: string): boolean {
  const norm = vaultRelPath.replace(/^\.?\/+/, "");
  return SYSTEM_DENY_PREFIXES.some(
    (pre) => norm === pre.replace(/\/$/, "") || norm.startsWith(pre),
  );
}

/**
 * Append exactly one JSON line + "\n" to the audit log (O_APPEND — concurrent-safe on POSIX).
 * `ts` defaults to Date.now() when omitted/zero so callers may pass a partial line.
 * `denied` is serialized only when true (default false stays implicit per §4.1).
 * Creates the .void-os dir on first write. Never throws across the hook boundary —
 * a failed audit append must not stall a CC Run; callers may wrap, but the write itself
 * is best-effort idempotent (one line per call).
 */
export function appendAudit(vault: string, line: AuditLine): void {
  const out: AuditLine = { ...line, ts: line.ts || Date.now() };
  if (out.denied !== true) delete out.denied;
  const p = auditPath(vault);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(out) + "\n");
}

/** Filters for {@link readAudit} (contract §4.4). All present filters are AND-ed. */
export interface AuditQuery {
  path?: string;    // exact vault-relative path match
  agent?: string;   // exact agent-name match
  since?: number;   // epoch-ms lower bound (inclusive): keep lines with ts >= since
}

/**
 * Read the audit log and return lines matching the (AND-ed) filters, in file (append) order.
 * Missing log → empty array. Malformed lines are skipped (the log must never 500 a reader).
 */
export function readAudit(vault: string, q: AuditQuery = {}): AuditLine[] {
  const p = auditPath(vault);
  if (!existsSync(p)) return [];
  const out: AuditLine[] = [];
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    if (!raw) continue;
    let line: AuditLine;
    try { line = JSON.parse(raw) as AuditLine; } catch { continue; }
    if (q.path !== undefined && line.path !== q.path) continue;
    if (q.agent !== undefined && line.agent !== q.agent) continue;
    if (q.since !== undefined && !(line.ts >= q.since)) continue;
    out.push(line);
  }
  return out;
}
