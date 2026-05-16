// VOS-97 T4: ask_agent MCP tool — factory + Zod input shape + ids from _meta.
//
// Replaces the prior ASK_AGENT_TOOL_DEF (JSON Schema literal) + runAskAgent(ctx, args)
// surface. Runtime ids (task_id, context_id) now arrive via MCP `params._meta`
// per ADR-0002; the input schema carries only domain args.
//
// Module-local helpers (mintChildAndFlipParent, waitForChildTerminal,
// translateChildResult, askAgentChainDepth, MAX_ASK_AGENT_DEPTH) are unchanged
// from VOS-95; only the public surface (tool def + handler) was rewritten.

// VOS-97 T5 fix: import zod from the v3 subpath — see vault-read.ts header
// for the rationale (SDK uses zod@3 internally; project ships zod@4).
import { z } from "zod/v3";
import type { Database } from "bun:sqlite";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { EventBus, DaemonEvent } from "../../../events";
import type { AgentDefn } from "../../../permissions/engine";

// -----------------------------------------------------------------------------
// Tool def (Zod raw shape).
// -----------------------------------------------------------------------------

export const askAgentInput = {
  target_agent_id: z.string().min(1),
  message: z.string().min(1),
  system_message: z.string().optional(),
} satisfies z.ZodRawShape;

export const askAgentDef = {
  description:
    "Ask another agent (in the same Context). The daemon mints a child A2A Task; " +
    "this call suspends until the child reaches a terminal state and returns its " +
    "final assistant text.",
  inputSchema: askAgentInput,
};

// -----------------------------------------------------------------------------
// Errors.
// -----------------------------------------------------------------------------

export class AskAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskAgentError";
  }
}

export interface McpErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
}

function toMcpError(err: unknown): McpErrorResult {
  const text =
    err instanceof AskAgentError ? err.message :
    err instanceof Error ? `internal: ${err.message}` :
    "internal error";
  return { isError: true, content: [{ type: "text", text }] };
}

function errResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

// -----------------------------------------------------------------------------
// Depth probe.
// -----------------------------------------------------------------------------

const MAX_ASK_AGENT_DEPTH = 5;

function askAgentChainDepth(db: Database, taskId: string): number {
  const row = db
    .query(
      `
    WITH RECURSIVE chain(id, parent, n) AS (
      SELECT id, parent_task_id, 0 FROM tasks WHERE id = ?
      UNION ALL
      SELECT t.id, t.parent_task_id, c.n + 1
      FROM tasks t JOIN chain c ON t.id = c.parent
    )
    SELECT MAX(n) AS depth FROM chain
  `,
    )
    .get(taskId) as { depth: number | null } | undefined;
  return row?.depth ?? 0;
}

// -----------------------------------------------------------------------------
// Mint + flip.
// -----------------------------------------------------------------------------

export interface MintArgs {
  childId: string;
  contextId: string;
  parentId: string;
  targetAgent: string;
  parentToolCallId: string;
}

// Atomically mint a SUBMITTED child task and flip the parent
// WORKING -> WAITING_ON_AGENT. Single SQLite transaction; CAS failure on
// the parent flip rolls back the child INSERT so no orphan row is left.
export function mintChildAndFlipParent(db: Database, a: MintArgs): void {
  if (!a.parentToolCallId) throw new Error("parentToolCallId required");
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    db.run(
      `INSERT INTO tasks
         (id, context_id, parent_task_id, parent_tool_call_id, state,
          cost_usd, tokens_in, tokens_out, metadata,
          created_at, updated_at, target_agent)
       VALUES (?, ?, ?, ?, 'TASK_STATE_SUBMITTED',
               0, 0, 0, '{}', ?, ?, ?)`,
      [a.childId, a.contextId, a.parentId, a.parentToolCallId, now, now, a.targetAgent],
    );
    const res = db.run(
      `UPDATE tasks
         SET state = 'TASK_STATE_WAITING_ON_AGENT', updated_at = ?
       WHERE id = ? AND state = 'TASK_STATE_WORKING'`,
      [now, a.parentId],
    );
    if (res.changes === 0) {
      throw new AskAgentError("parent task not in WORKING state");
    }
  });
  tx();
}

// -----------------------------------------------------------------------------
// Bus-await helper.
// -----------------------------------------------------------------------------

type TerminalState =
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED";

const TERMINALS: ReadonlySet<string> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
]);

function waitForChildTerminal(args: {
  db: Database;
  bus: EventBus;
  childTaskId: string;
}): Promise<TerminalState> {
  const { db, bus, childTaskId } = args;
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    const settle = (s: TerminalState): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(s);
    };
    // Subscribe FIRST so any emit between this point and the DB recheck below
    // is captured by the handler.
    unsubscribe = bus.subscribe("task.state_changed", (ev: DaemonEvent) => {
      const p = ev.payload as { taskId?: string; state?: string } | undefined;
      if (!p || p.taskId !== childTaskId) return;
      if (p.state && TERMINALS.has(p.state)) {
        settle(p.state as TerminalState);
      }
    });
    // Race-guard: if the child already reached terminal before subscribe,
    // resolve from the DB.
    const row = db
      .query("SELECT state FROM tasks WHERE id = ?")
      .get(childTaskId) as { state: string } | undefined;
    if (row && TERMINALS.has(row.state)) {
      settle(row.state as TerminalState);
    }
  });
}

// -----------------------------------------------------------------------------
// Terminal translator.
// -----------------------------------------------------------------------------

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

function translateChildResult(
  db: Database,
  childTaskId: string,
  state: string,
): ToolResult {
  if (state === "TASK_STATE_COMPLETED") {
    const row = db
      .query(
        `SELECT parts_text FROM messages
         WHERE task_id = ? AND role = 'ROLE_AGENT' AND parts_text != ''
         ORDER BY ts DESC, ord DESC LIMIT 1`,
      )
      .get(childTaskId) as { parts_text: string | null } | undefined;
    const text =
      row && row.parts_text && row.parts_text.length > 0
        ? row.parts_text
        : "(no message)";
    return { content: [{ type: "text", text }] };
  }
  if (state === "TASK_STATE_FAILED") {
    // Look up persisted errorMessage from tasks.metadata (written by
    // dispatch-child on FAILED). Fall back to "unknown" on absence or
    // malformed JSON.
    let resolved: string | null = null;
    const metaRow = db
      .query("SELECT metadata FROM tasks WHERE id = ?")
      .get(childTaskId) as { metadata: string | null } | undefined;
    if (metaRow?.metadata) {
      try {
        const parsed = JSON.parse(metaRow.metadata) as Record<string, unknown>;
        if (typeof parsed.errorMessage === "string") {
          resolved = parsed.errorMessage;
        }
      } catch {
        // malformed metadata — fall through to "unknown"
      }
    }
    throw new AskAgentError(`child task failed: ${resolved ?? "unknown"}`);
  }
  if (state === "TASK_STATE_CANCELED") {
    throw new AskAgentError("child task cancelled");
  }
  throw new AskAgentError(`unexpected child state: ${state}`);
}

// -----------------------------------------------------------------------------
// Factory + handler.
// -----------------------------------------------------------------------------

export interface AskAgentDeps {
  db: Database;
  bus: EventBus;
  /** Resolve an AgentDefn by agent name. Throws if the name is unknown. */
  loadAgentDefn: (agentName: string) => AgentDefn;
  /** Dispatch the freshly-minted child onto the runner thread. */
  dispatchChildTask: (
    childTaskId: string,
    args: { agentName: string; message: string; systemMessage?: string },
  ) => Promise<void>;
  now: () => number;
}

export function makeAskAgent(deps: AskAgentDeps) {
  return async (
    args: z.objectOutputType<typeof askAgentInput, z.ZodTypeAny>,
    extra: RequestHandlerExtra<any, any>,
  ): Promise<CallToolResult> => {
    const meta = (extra._meta ?? {}) as Record<string, unknown>;
    const taskId = typeof meta.task_id === "string" ? meta.task_id : undefined;
    if (!taskId) return errResult("ASK_AGENT_MISSING_TASK_ID");
    const contextId =
      typeof meta.context_id === "string" ? meta.context_id : taskId;
    const toolCallId =
      typeof meta.tool_call_id === "string" && meta.tool_call_id !== ""
        ? meta.tool_call_id
        : undefined;
    if (!toolCallId) return errResult("ASK_AGENT_MISSING_TOOL_CALL_ID");

    try {
      // 1. Existence — agent_cards lookup (migration 0007).
      const exists = deps.db
        .query("SELECT 1 AS one FROM agent_cards WHERE agent_name = ?")
        .get(args.target_agent_id);
      if (!exists) {
        throw new AskAgentError(`unknown agent: ${args.target_agent_id}`);
      }

      // 2. Caller identity. tasks has no agent_name column; the caller agent is
      // the context's agent_name.
      const callerRow = deps.db
        .query(
          `SELECT c.agent_name AS agent_name
             FROM tasks t
             JOIN contexts c ON t.context_id = c.id
            WHERE t.id = ?`,
        )
        .get(taskId) as { agent_name: string } | undefined;
      if (!callerRow) {
        throw new AskAgentError("caller task missing");
      }
      const caller = deps.loadAgentDefn(callerRow.agent_name);

      // 3. Permission — empty/undefined ask_agent_allow is permissive at the
      // agent level; an explicit array is an allowlist.
      if (
        caller.ask_agent_allow !== undefined &&
        !caller.ask_agent_allow.includes(args.target_agent_id)
      ) {
        throw new AskAgentError("permission denied");
      }

      // 4. Depth guard. About-to-mint child lives one level deeper, so reject
      // when current depth >= MAX_ASK_AGENT_DEPTH - 1.
      if (askAgentChainDepth(deps.db, taskId) >= MAX_ASK_AGENT_DEPTH - 1) {
        throw new AskAgentError("ask_agent depth limit exceeded");
      }

      // 5. Allocate child task id.
      const childTaskId = crypto.randomUUID();

      // 6. Subscribe BEFORE mint so any state-changed emit fired between mint
      // commit and await is captured.
      const waitP = waitForChildTerminal({
        db: deps.db,
        bus: deps.bus,
        childTaskId,
      });

      // 7. Mint child + flip parent in single tx. Parent not WORKING -> rollback,
      // no child row remains.
      mintChildAndFlipParent(deps.db, {
        childId: childTaskId,
        parentId: taskId,
        contextId,
        targetAgent: args.target_agent_id,
        parentToolCallId: toolCallId,
      });

      // VOS-89 Finding 4: emit parent's WORKING -> WAITING_ON_AGENT flip. The
      // mint runs in a sibling tx without bus access, so emission lives here.
      deps.bus.emit({
        type: "task.state_changed",
        chatId: contextId,
        payload: {
          taskId,
          state: "TASK_STATE_WAITING_ON_AGENT",
        },
      });

      // 8. Dispatch child task.
      await deps.dispatchChildTask(childTaskId, {
        agentName: args.target_agent_id,
        message: args.message,
        systemMessage: args.system_message,
      });

      // 9/10. Await child terminal with post-dispatch DB recheck to close the
      // "dispatcher flipped state without emitting" window.
      const postRow = deps.db
        .query("SELECT state FROM tasks WHERE id = ?")
        .get(childTaskId) as { state: string } | undefined;
      const state =
        postRow && TERMINALS.has(postRow.state)
          ? (postRow.state as TerminalState)
          : await waitP;

      // 11. Translate terminal -> tool result (or throw -> mcp error).
      const result = translateChildResult(deps.db, childTaskId, state);
      return result as CallToolResult;
    } catch (e) {
      return toMcpError(e);
    }
  };
}
