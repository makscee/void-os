import type { Database } from "bun:sqlite";
import type { EventBus } from "../events/index.ts";
import {
  setTaskInputRequired,
  clearTaskPending,
  appendToolUseMessage,
  appendToolResultMessage,
} from "./ask-user-repo.ts";

export interface OpenArgs {
  taskId: string;
  contextId: string;
  runId: string | null;
  toolUseId: string;
  question: string;
  options?: string[];
}

export type OpenResult =
  | { answer: string }
  | { canceled: true }
  | { timeout: true }
  | { raceLost: true };

export interface ResolveArgs {
  taskId: string;
  toolUseId: string;
  answer: string;
}

export type ResolveResult =
  | { ok: true }
  | { ok: false; reason: "unknown" | "not_pending" };

export interface CancelArgs {
  taskId: string;
  toolUseId: string;
  reason: "terminal" | "canceled";
}

export interface AskUserBridge {
  open(args: OpenArgs): Promise<OpenResult>;
  resolve(args: ResolveArgs): Promise<ResolveResult>;
  cancel(args: CancelArgs): Promise<void>;
  size(): number;
}

interface Awaiter {
  resolveFn: (r: OpenResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;          // first-writer-wins flag — guards timer vs resolve vs cancel race
  contextId: string;
  taskId: string;
}

export interface CreateAskUserBridgeDeps {
  db: Database;
  bus: EventBus;
  deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 30 * 60 * 1000; // 30 min — matches today's makeAskUser deadline

export function createAskUserBridge(deps: CreateAskUserBridgeDeps): AskUserBridge {
  const { db, bus } = deps;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const pending = new Map<string, Awaiter>();

  function emitStateChanged(contextId: string, taskId: string, state: string): void {
    bus.emit({ type: "task.state_changed", chatId: contextId, payload: { taskId, state } });
  }

  function emitMessageAppended(contextId: string, taskId: string, messageId: number): void {
    bus.emit({ type: "message.appended", chatId: contextId, payload: { taskId, messageId } });
  }

  function open(args: OpenArgs): Promise<OpenResult> {
    return new Promise<OpenResult>((resolveFn) => {
      // CAS + history-write in one tx — delegates to ask-user-repo helpers (real SQL lives there).
      let messageId: number | null = null;
      try {
        const tx = db.transaction(() => {
          if (!setTaskInputRequired(db, args.taskId, args.toolUseId, args.question, args.options)) {
            throw new Error("CAS_LOST");
          }
          messageId = appendToolUseMessage(db, {
            taskId: args.taskId,
            contextId: args.contextId,
            runId: args.runId,
            toolUseId: args.toolUseId,
            question: args.question,
            options: args.options,
          });
        });
        tx();
      } catch (err) {
        // Task not in WORKING (or already pending another question). Distinct from user-cancel.
        resolveFn({ raceLost: true });
        return;
      }

      emitStateChanged(args.contextId, args.taskId, "TASK_STATE_INPUT_REQUIRED");
      if (messageId !== null) emitMessageAppended(args.contextId, args.taskId, messageId);

      const awaiter: Awaiter = {
        resolveFn,
        timer: null,
        settled: false,
        contextId: args.contextId,
        taskId: args.taskId,
      };

      awaiter.timer = setTimeout(() => {
        // Settled check first — resolve() or cancel() may have won the race already.
        if (awaiter.settled) return;
        awaiter.settled = true;
        pending.delete(args.toolUseId);
        const cleared = clearTaskPending(db, args.taskId, args.toolUseId);
        if (cleared) emitStateChanged(args.contextId, args.taskId, "TASK_STATE_WORKING");
        resolveFn({ timeout: true });
      }, deadlineMs);

      pending.set(args.toolUseId, awaiter);
    });
  }

  async function resolveAction(args: ResolveArgs): Promise<ResolveResult> {
    const awaiter = pending.get(args.toolUseId);
    if (!awaiter || awaiter.settled) return { ok: false, reason: "unknown" };

    // Look up contextId + active runId for the tool_result message append.
    const ctxRow = db.query("SELECT context_id FROM tasks WHERE id = ?").get(args.taskId) as
      | { context_id: string }
      | null;
    if (!ctxRow) return { ok: false, reason: "unknown" };
    const contextId = ctxRow.context_id;
    const runRow = db
      .query(
        "SELECT id FROM runs WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      )
      .get(args.taskId) as { id: string } | null;
    const runId = runRow?.id ?? null;

    let messageId: number | null = null;
    try {
      const tx = db.transaction(() => {
        if (!clearTaskPending(db, args.taskId, args.toolUseId)) throw new Error("PENDING_MISMATCH");
        messageId = appendToolResultMessage(db, {
          taskId: args.taskId,
          contextId,
          runId,
          toolUseId: args.toolUseId,
          answer: args.answer,
        });
      });
      tx();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "PENDING_MISMATCH") return { ok: false, reason: "not_pending" };
      throw err;
    }

    // Win the local race against the timer; only then clear + emit.
    awaiter.settled = true;
    if (awaiter.timer) clearTimeout(awaiter.timer);
    pending.delete(args.toolUseId);

    emitStateChanged(contextId, args.taskId, "TASK_STATE_WORKING");
    if (messageId !== null) emitMessageAppended(contextId, args.taskId, messageId);

    awaiter.resolveFn({ answer: args.answer });
    return { ok: true };
  }

  async function cancel(args: CancelArgs): Promise<void> {
    const awaiter = pending.get(args.toolUseId);
    if (!awaiter || awaiter.settled) return;
    awaiter.settled = true;
    if (awaiter.timer) clearTimeout(awaiter.timer);
    pending.delete(args.toolUseId);

    const cleared = clearTaskPending(db, args.taskId, args.toolUseId);
    if (cleared) emitStateChanged(awaiter.contextId, args.taskId, "TASK_STATE_WORKING");

    awaiter.resolveFn({ canceled: true });
  }

  return { open, resolve: resolveAction, cancel, size: () => pending.size };
}
