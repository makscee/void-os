// daemon/src/adapters/mcp/tools/ask-user.ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { EventBus } from "../../../events";
import type { PendingRegistry } from "../pending-questions";
import {
  setTaskInputRequired,
  appendToolUseMessage,
  clearTaskPending,
} from "../../../chat/ask-user-repo";

export const AskUserInput = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(80)).max(6).optional(),
});

export type AskUserInputT = z.infer<typeof AskUserInput>;

export const ASK_USER_TOOL_DEF = {
  name: "ask_user",
  description:
    "Pause the current Task and ask the user a question inline in chat. " +
    "Returns the user's answer as the tool result. " +
    "If `options` is provided, the UI shows buttons; the returned text is either the clicked option or free-text reply.",
  inputSchema: {
    type: "object" as const,
    properties: {
      question: { type: "string", minLength: 1, maxLength: 500 },
      options: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 80 },
        maxItems: 6,
      },
      // VOS-88 T7: MCP is stateless; the caller's runtime injects these IDs
      // into the tool arguments so the daemon can route the question to the
      // correct task/chat. The zod AskUserInput schema below ignores them
      // (non-strict); the MCP handler reads them off `args` directly.
      task_id: { type: "string", minLength: 1 },
      context_id: { type: "string", minLength: 1 },
      run_id: { type: "string", minLength: 1 },
    },
    required: ["question", "task_id"],
  },
};

// VOS-88 T6: runAskUser handler — happy path.
//
// Reconciliation vs plan §T6:
//   - EventBus has NO typed event registry (src/events/index.ts). The string
//     event types "task.state_changed" / "message.appended" are kept as the
//     plan specified — they are internal bus events that drive plugin
//     invalidation. The WS frame names (chat.tool_use, chat.tool_result,
//     run.end) live in orchestrator.ts on a separate layer.
//   - DaemonEvent requires { type, payload }. We pass the task-id / state /
//     message-id under payload rather than as top-level fields to satisfy
//     the interface without `as any` casts.

export interface AskUserContext {
  db: Database;
  bus: EventBus;
  pending: PendingRegistry;
  taskId: string;
  contextId: string;
  runId: string | null;
  deadlineMs: number;
  now: () => number;
}

export interface AskUserResult {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
}

export async function runAskUser(
  ctx: AskUserContext,
  raw: unknown,
): Promise<AskUserResult> {
  const args = AskUserInput.parse(raw);
  // VOS-90 T1: the fake provider yields its own synthesized assistant
  // `tool_use` block BEFORE calling MCP ask_user, then drives the test by
  // POSTing /chat/:id/answer with that same id. For the answer route's CAS
  // correlation to succeed, runAskUser must persist the same id rather than
  // minting a fresh one. Production agents never set this hint — they only
  // emit standard MCP `arguments` — so they keep getting a fresh UUID.
  const rawAny = (raw ?? {}) as Record<string, unknown>;
  const injectedId =
    typeof rawAny._vos_tool_use_id === "string" && rawAny._vos_tool_use_id.length > 0
      ? rawAny._vos_tool_use_id
      : undefined;
  const toolUseId = injectedId ?? randomUUID();

  // Transaction: write tool_use message + CAS state flip together.
  const tx = ctx.db.transaction(() => {
    const ok = setTaskInputRequired(
      ctx.db,
      ctx.taskId,
      toolUseId,
      args.question,
      args.options,
    );
    if (!ok) {
      const row = ctx.db
        .query(
          "SELECT state, json_extract(metadata, '$.pending_tool_use_id') AS pending FROM tasks WHERE id=?",
        )
        .get(ctx.taskId) as { state?: string; pending?: string } | null;
      if (!row) throw new Error("TASK_NOT_FOUND");
      if (row.pending) throw new Error("ASK_USER_ALREADY_OPEN");
      throw new Error("TASK_NOT_WORKING");
    }
    const messageId = appendToolUseMessage(ctx.db, {
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      runId: ctx.runId,
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

  ctx.bus.emit({
    type: "task.state_changed",
    chatId: ctx.contextId,
    payload: { taskId: ctx.taskId, state: "TASK_STATE_INPUT_REQUIRED" },
  });
  ctx.bus.emit({
    type: "message.appended",
    chatId: ctx.contextId,
    payload: { taskId: ctx.taskId, messageId },
  });

  try {
    const answer = await ctx.pending.register(toolUseId, ctx.deadlineMs);
    return { content: [{ type: "text", text: answer }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "ASK_USER_TIMEOUT") {
      const cleared = clearTaskPending(ctx.db, ctx.taskId, toolUseId);
      if (cleared) {
        ctx.bus.emit({
          type: "task.state_changed",
          chatId: ctx.contextId,
          payload: { taskId: ctx.taskId, state: "TASK_STATE_WORKING" },
        });
      }
    }
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
