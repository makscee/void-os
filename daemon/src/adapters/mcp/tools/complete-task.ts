// VOS-171: complete_task MCP tool — agent-declared terminal state.
//
// Today a Task's terminal state is *inferred* from the provider run ending
// (orchestrator's `tryCompleteTaskOnRunEnd` flips WORKING -> COMPLETED on
// run.end). This tool gives the Agent an *explicit* way to declare its job
// done — `completed` when the work succeeded, `failed` when it could not.
//
// The tool targets the CALLING Agent's OWN Task only: the Task id is read
// from `_meta.task_id` (the per-request runtime id the daemon injects), never
// from a tool argument. A parent therefore physically cannot force-complete a
// child through this tool — there is no taskId parameter to point at one. To
// terminate a child, a parent uses the cancel-cascade (`cancel` only).
//
// A terminal Task is frozen: a second `complete_task` is a harmless idempotent
// no-op (the CAS in `declareTaskTerminal` matches no row), and the orchestrator
// rejects any re-engaging user message.
//
// VOS-97 T5 fix: import zod from the v3 subpath — the SDK uses zod@3
// internally; the project ships zod@4. See vault-read.ts header.
import { z } from "zod/v3";
import type { Database } from "bun:sqlite";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { declareTaskTerminal } from "../../../chat/repo.ts";

export const completeTaskInput = {
  state: z.enum(["completed", "failed"]),
  summary: z.string().min(1).max(200),
} satisfies z.ZodRawShape;

export const completeTaskDef = {
  description:
    "Declare YOUR current Task terminal. Call this when your job is done: " +
    "`state: 'completed'` when the work succeeded, `state: 'failed'` when it " +
    "could not be completed. `summary` is a one-line outcome blurb. After this " +
    "the Task is frozen — it accepts no further messages; a follow-up job is a " +
    "new Task. You can only complete your own Task, never another agent's.",
  inputSchema: completeTaskInput,
};

export interface CompleteTaskDeps {
  db: Database;
  /** Optional WS fan-out. Production buildApp passes broadcast(); MCP-only
   *  tests inject a spy or omit it. Mirrors ask_agent's `emit` dep. */
  emit?: (type: string, payload: Record<string, unknown>) => void;
}

function errResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

const STATE_MAP = {
  completed: "TASK_STATE_COMPLETED",
  failed: "TASK_STATE_FAILED",
} as const;

export function makeCompleteTask(deps: CompleteTaskDeps) {
  return async (
    args: z.objectOutputType<typeof completeTaskInput, z.ZodTypeAny>,
    extra: RequestHandlerExtra<any, any>,
  ): Promise<CallToolResult> => {
    const meta = (extra._meta ?? {}) as Record<string, unknown>;
    const taskId = typeof meta.task_id === "string" ? meta.task_id : undefined;
    if (!taskId) return errResult("COMPLETE_TASK_MISSING_TASK_ID");

    const terminal = STATE_MAP[args.state];
    const result = declareTaskTerminal(deps.db, taskId, terminal, args.summary);

    if (!result.flipped) {
      // CAS no-op: the Task is already terminal (frozen) or its row is gone.
      if (result.state === null) {
        return errResult(`COMPLETE_TASK_UNKNOWN_TASK: ${taskId}`);
      }
      return errResult(
        `COMPLETE_TASK_ALREADY_TERMINAL: task ${taskId} is already ` +
          `${result.state} — it is frozen and cannot be re-declared`,
      );
    }

    deps.emit?.("task.state_changed", { taskId, state: terminal });

    return {
      content: [
        {
          type: "text",
          text: `Task ${taskId} declared ${args.state}. It is now frozen.`,
        },
      ],
    };
  };
}
