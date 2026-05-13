/**
 * Record MCP tool-call events into the existing `events` table.
 *
 * Schema: events(ts, chat_id, run_id, agent, type, data) — same table the
 * vault writer uses via recordVaultEvent. MCP rows are distinguished by
 * `agent='mcp'` and `type='mcp.<tool>'`. The JSON `data` payload carries
 * tool-specific fields (input args, ok flag, error_code, result_sha).
 */

import type { Database } from "bun:sqlite";

export interface McpEvent {
  tool: string;                       // 'vault.read'
  input: Record<string, unknown>;     // tool arguments
  ok: boolean;
  error_code?: string;
  result_sha?: string;
  run_id?: string | null;
}

export function recordMcpEvent(db: Database, e: McpEvent): void {
  // ts is epoch ms (INTEGER per 0001_init.sql). Note: vault/events.ts currently
  // writes unixepoch('subsec') which coerces to seconds; we deliberately do
  // not propagate that bug — MCP rows store ms. Mixed units in events.ts is
  // a pre-existing issue tracked separately.
  db.prepare(
    `INSERT INTO events (ts, chat_id, run_id, agent, type, data)
     VALUES (?, NULL, ?, 'mcp', ?, ?)`,
  ).run(
    Date.now(),
    e.run_id ?? null,
    `mcp.${e.tool}`,
    JSON.stringify({
      input: e.input,
      ok: e.ok,
      error_code: e.error_code ?? null,
      result_sha: e.result_sha ?? null,
    }),
  );
}
