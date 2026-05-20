/**
 * list_tasks MCP tool (VOS-169).
 *
 * Global navigation query: every Task across every Context, sorted by last
 * activity. Active + recently-updated Tasks by default; terminal Tasks
 * (completed/failed/canceled/rejected) age out unless `include_terminal` is
 * set. Read-only — no scope gate, the agent-tree metadata is world-readable.
 *
 * Input:  { include_terminal?: boolean, recency_hours?: number, limit?: number }
 * Output: { content: [{type:'text', text}], structuredContent: { tasks: TaskListItem[] } }
 */
import { z } from "zod/v3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "bun:sqlite";
import { makeNavRepo } from "../../../chat/nav-repo.ts";

export const listTasksInput = {
  include_terminal: z.boolean().optional(),
  recency_hours: z.number().positive().optional(),
  limit: z.number().int().positive().optional(),
} satisfies z.ZodRawShape;

export const listTasksDef = {
  description:
    "List all Tasks across all Contexts, sorted by last activity (most recent " +
    "first). By default terminal Tasks (completed/failed/canceled/rejected) " +
    "older than 24h are excluded; pass include_terminal to keep them.",
  inputSchema: listTasksInput,
};

export interface ListTasksDeps {
  db: Database;
}

export function makeListTasks(deps: ListTasksDeps) {
  const nav = makeNavRepo(deps.db);
  return async (
    args: z.objectOutputType<typeof listTasksInput, z.ZodTypeAny>,
  ): Promise<CallToolResult> => {
    const tasks = nav.listTasks({
      includeTerminal: args.include_terminal,
      recencyMs:
        typeof args.recency_hours === "number"
          ? args.recency_hours * 60 * 60 * 1000
          : undefined,
      limit: args.limit,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
      structuredContent: { tasks },
    };
  };
}
