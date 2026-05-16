// daemon/src/adapters/mcp/tools/ask-user.ts
//
// VOS-97 T3: canonical factory shape — Zod input + `make*(deps)` returning a
// curried handler. Runtime ids (task_id, context_id, run_id) and the test-only
// `_vos_tool_use_id` correlation hint come from `extra._meta` (per MCP spec),
// not from tool arguments. Replaces the previous ASK_USER_TOOL_DEF JSON Schema
// literal and the ctx-passing runAskUser function.
import { randomUUID } from "node:crypto";
// VOS-97 T5 fix: import zod from the v3 subpath — see vault-read.ts header
// for the rationale (SDK uses zod@3 internally; project ships zod@4).
import { z } from "zod/v3";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Database } from "bun:sqlite";
import type { EventBus } from "../../../events";
import type { PendingRegistry } from "../pending-questions";
import {
  setTaskInputRequired,
  appendToolUseMessage,
  clearTaskPending,
} from "../../../chat/ask-user-repo";

export const ASK_USER_DEADLINE_MS = 30 * 60 * 1000;

export const askUserInput = {
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(80)).max(6).optional(),
} satisfies z.ZodRawShape;

export const askUserDef = {
  description:
    "Pause the current Task and ask the user a question inline in chat. " +
    "Returns the user's answer as the tool result. " +
    "If `options` is provided, the UI shows buttons; the returned text is either the clicked option or free-text reply.",
  inputSchema: askUserInput,
};

export interface AskUserDeps {
  db: Database;
  bus: EventBus;
  pending: PendingRegistry;
  now: () => number;
  deadlineMs: number;
}

function errResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export function makeAskUser(deps: AskUserDeps) {
  return async (
    args: z.objectOutputType<typeof askUserInput, z.ZodTypeAny>,
    extra: RequestHandlerExtra<any, any>,
  ): Promise<CallToolResult> => {
    const meta = (extra._meta ?? {}) as Record<string, unknown>;
    const taskId = typeof meta.task_id === "string" ? meta.task_id : undefined;
    if (!taskId) return errResult("ASK_USER_MISSING_TASK_ID");
    const contextId =
      typeof meta.context_id === "string" ? meta.context_id : taskId;
    const runId = typeof meta.run_id === "string" ? meta.run_id : null;
    // VOS-90 T1 (preserved): the fake provider yields its own synthesized
    // assistant `tool_use` block BEFORE calling MCP ask_user, then drives the
    // test by POSTing /chat/:id/answer with that same id. For the answer
    // route's CAS correlation to succeed, the handler must persist the same
    // id rather than minting a fresh one. Production agents never set this
    // hint — they only emit standard MCP tool calls — so they keep getting a
    // fresh UUID. Hint now lives in _meta._vos_tool_use_id (was on args).
    const toolUseId =
      typeof meta._vos_tool_use_id === "string" && meta._vos_tool_use_id.length > 0
        ? meta._vos_tool_use_id
        : randomUUID();

    // Transaction: write tool_use message + CAS state flip together.
    const tx = deps.db.transaction(() => {
      const ok = setTaskInputRequired(
        deps.db,
        taskId,
        toolUseId,
        args.question,
        args.options,
      );
      if (!ok) {
        const row = deps.db
          .query(
            "SELECT state, json_extract(metadata, '$.pending_tool_use_id') AS pending FROM tasks WHERE id=?",
          )
          .get(taskId) as { state?: string; pending?: string } | null;
        if (!row) throw new Error("TASK_NOT_FOUND");
        if (row.pending) throw new Error("ASK_USER_ALREADY_OPEN");
        throw new Error("TASK_NOT_WORKING");
      }
      const messageId = appendToolUseMessage(deps.db, {
        taskId,
        contextId,
        runId,
        toolUseId,
        question: args.question,
        options: args.options,
      });
      return messageId;
    });

    let messageId: number;
    try {
      messageId = tx();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: msg }], isError: true };
    }

    deps.bus.emit({
      type: "task.state_changed",
      chatId: contextId,
      payload: { taskId, state: "TASK_STATE_INPUT_REQUIRED" },
    });
    deps.bus.emit({
      type: "message.appended",
      chatId: contextId,
      payload: { taskId, messageId },
    });

    try {
      const answer = await deps.pending.register(toolUseId, deps.deadlineMs);
      return { content: [{ type: "text", text: answer }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "ASK_USER_TIMEOUT") {
        const cleared = clearTaskPending(deps.db, taskId, toolUseId);
        if (cleared) {
          deps.bus.emit({
            type: "task.state_changed",
            chatId: contextId,
            payload: { taskId, state: "TASK_STATE_WORKING" },
          });
        }
      }
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  };
}
