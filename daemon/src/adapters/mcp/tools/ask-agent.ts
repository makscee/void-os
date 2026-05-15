// VOS-89 T8: runAskAgent handler — composition of T3–T7.
//
// This handler is composition-only: every concern (errors, depth, mint,
// bus-await, terminal-translation) lives in a sibling module. The handler's
// job is to orchestrate the 11-step contract from the plan:
//
//   1. existence       — agent_cards lookup
//   2. caller identity — derive from tasks.context_id → contexts.agent_name
//   3. permission      — ask_agent_allow allowlist
//   4. depth           — recursion guard via askAgentChainDepth
//   5. allocate childId
//   6. subscribe to bus BEFORE mint (race-guard)
//   7. mint child + flip parent (single tx)
//   8. dispatch child task (off-thread)
//   9/10. await child terminal
//   11. translate terminal -> MCP tool result (or error)
//
// On ANY throw, return a structured MCP error result instead of propagating.

import type { Database } from "bun:sqlite";
import type { EventBus } from "../../../events";
import type { AgentDefn } from "../../../permissions/engine";
import { AskAgentError, toMcpError, type McpErrorResult } from "./ask-agent-errors";
import { MAX_ASK_AGENT_DEPTH, askAgentChainDepth } from "./ask-agent-depth";
import { mintChildAndFlipParent } from "./ask-agent-mint";
import { waitForChildTerminal } from "./ask-agent-wait";
import { translateChildResult, type ToolResult } from "./ask-agent-result";

export interface AskAgentCtx {
  db: Database;
  bus: EventBus;
  taskId: string;
  contextId: string;
  /** Resolve an AgentDefn by agent name. Throws if the name is unknown. */
  loadAgentDefn: (agentName: string) => AgentDefn;
  /** Dispatch the freshly-minted child onto the runner thread. */
  dispatchChildTask: (
    childTaskId: string,
    args: { agentName: string; message: string; systemMessage?: string },
  ) => Promise<void>;
  now: () => number;
}

export interface AskAgentArgs {
  target_agent_id: string;
  message: string;
  system_message?: string;
}

export async function runAskAgent(
  ctx: AskAgentCtx,
  args: AskAgentArgs,
): Promise<ToolResult | McpErrorResult> {
  try {
    // 1. Existence — check agent_cards (migration 0007).
    const exists = ctx.db
      .query("SELECT 1 AS one FROM agent_cards WHERE agent_name = ?")
      .get(args.target_agent_id);
    if (!exists) {
      throw new AskAgentError(`unknown agent: ${args.target_agent_id}`);
    }

    // 2. Caller identity. `tasks` has no agent_name column; the caller agent
    // is the context's agent_name (a task is bound to one context, and a
    // context has exactly one agent).
    const callerRow = ctx.db
      .query(
        `SELECT c.agent_name AS agent_name
           FROM tasks t
           JOIN contexts c ON t.context_id = c.id
          WHERE t.id = ?`,
      )
      .get(ctx.taskId) as { agent_name: string } | undefined;
    if (!callerRow) {
      throw new AskAgentError("caller task missing");
    }
    const caller = ctx.loadAgentDefn(callerRow.agent_name);

    // 3. Permission — empty/undefined `ask_agent_allow` is permissive at the
    // agent level; an explicit array is an allowlist.
    if (
      caller.ask_agent_allow !== undefined &&
      !caller.ask_agent_allow.includes(args.target_agent_id)
    ) {
      throw new AskAgentError("permission denied");
    }

    // 4. Depth guard. askAgentChainDepth returns the deepest distance from
    // root (root = 0). About-to-mint child would live one level deeper, so we
    // reject when current depth >= MAX_ASK_AGENT_DEPTH - 1.
    if (askAgentChainDepth(ctx.db, ctx.taskId) >= MAX_ASK_AGENT_DEPTH - 1) {
      throw new AskAgentError("ask_agent depth limit exceeded");
    }

    // 5. Allocate child task id. Use crypto.randomUUID() for portability —
    // Bun's randomUUIDv7 is not relied upon anywhere else in the daemon.
    const childTaskId = crypto.randomUUID();

    // 6. Subscribe BEFORE mint so any state-changed emit fired between the
    // mint commit and the await is captured by the bus-await helper.
    const waitP = waitForChildTerminal({
      db: ctx.db,
      bus: ctx.bus,
      childTaskId,
    });

    // 7. Mint child + flip parent in a single transaction. If the parent is
    // not in WORKING the transaction rolls back and no child row remains.
    mintChildAndFlipParent(ctx.db, {
      childId: childTaskId,
      parentId: ctx.taskId,
      contextId: ctx.contextId,
      targetAgent: args.target_agent_id,
    });

    // 8. Dispatch child task.
    await ctx.dispatchChildTask(childTaskId, {
      agentName: args.target_agent_id,
      message: args.message,
      systemMessage: args.system_message,
    });

    // 9 + 10. Await child terminal. The race-guard recheck inside
    // waitForChildTerminal runs at subscribe-time (before mint), so if the
    // dispatcher flipped state to a terminal value WITHOUT emitting we'd
    // hang. Do an explicit post-dispatch DB recheck to close that window.
    const postRow = ctx.db
      .query("SELECT state FROM tasks WHERE id = ?")
      .get(childTaskId) as { state: string } | undefined;
    const TERMINAL = new Set([
      "TASK_STATE_COMPLETED",
      "TASK_STATE_FAILED",
      "TASK_STATE_CANCELED",
    ]);
    const state =
      postRow && TERMINAL.has(postRow.state)
        ? (postRow.state as "TASK_STATE_COMPLETED" | "TASK_STATE_FAILED" | "TASK_STATE_CANCELED")
        : await waitP;

    // 11. Translate terminal -> tool result (or throw -> mcp error).
    return translateChildResult(ctx.db, childTaskId, state, null);
  } catch (e) {
    return toMcpError(e);
  }
}
