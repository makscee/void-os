/**
 * list_children MCP tool (VOS-169).
 *
 * Walk one level of the Task tree: the direct children of a Task (rows whose
 * `parent_task_id` equals the given id), oldest-first. Read-only.
 *
 * Input:  { task_id: string }
 * Output: { content: [{type:'text', text}], structuredContent: { children: TaskListItem[] } }
 */
import { z } from "zod/v3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "bun:sqlite";
import { makeNavRepo } from "../../../chat/nav-repo.ts";

export const listChildrenInput = {
  task_id: z.string().min(1),
} satisfies z.ZodRawShape;

export const listChildrenDef = {
  description:
    "List the direct children of a Task (one level of the Task tree), " +
    "oldest-first. Returns an empty array if the Task has no children or " +
    "does not exist.",
  inputSchema: listChildrenInput,
};

export interface ListChildrenDeps {
  db: Database;
}

export function makeListChildren(deps: ListChildrenDeps) {
  const nav = makeNavRepo(deps.db);
  return async (
    args: z.objectOutputType<typeof listChildrenInput, z.ZodTypeAny>,
  ): Promise<CallToolResult> => {
    const children = nav.listChildren(args.task_id);
    return {
      content: [{ type: "text", text: JSON.stringify(children, null, 2) }],
      structuredContent: { children },
    };
  };
}
