/**
 * get_task MCP tool (VOS-169).
 *
 * Fetch one Task with its full message history. Per ADR-0010 a Task's output
 * is its final message, and history must be individually addressable — this
 * tool is the read primitive for that. Read-only.
 *
 * Input:  { task_id: string }
 * Output: { content: [{type:'text', text}], structuredContent: { task: TaskDetail } }
 *         or { isError: true, ... } with TASK_NOT_FOUND.
 */
import { z } from "zod/v3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "bun:sqlite";
import { makeNavRepo } from "../../../chat/nav-repo.ts";

export const getTaskInput = {
  task_id: z.string().min(1),
} satisfies z.ZodRawShape;

export const getTaskDef = {
  description:
    "Get a single Task by id, including its message history. Fails with " +
    "TASK_NOT_FOUND if no Task with that id exists.",
  inputSchema: getTaskInput,
};

export interface GetTaskDeps {
  db: Database;
}

function errResult(code: string, msg: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `${code}: ${msg}` }] };
}

export function makeGetTask(deps: GetTaskDeps) {
  const nav = makeNavRepo(deps.db);
  return async (
    args: z.objectOutputType<typeof getTaskInput, z.ZodTypeAny>,
  ): Promise<CallToolResult> => {
    const task = nav.getTask(args.task_id);
    if (!task) {
      return errResult("TASK_NOT_FOUND", `no Task with id ${args.task_id}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
      structuredContent: { task },
    };
  };
}
