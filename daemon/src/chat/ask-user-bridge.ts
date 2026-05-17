import type { Database } from "bun:sqlite";
import type { EventBus } from "../events/index.ts";
import type { DataPart } from "../types/a2a";
import { makeMessagesRepo } from "./messages-repo";

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

// VOS-88 T4: SQLite CAS helpers for the ask_user tool.
//
// Four helpers feed Tasks T6 (ask_user handler), T8 (answer route), and
// T10 (timeout rollback). They keep all `tasks` / `messages` writes in one
// place so the orchestrator can drive the input-required state-machine
// without duplicating SQL.
//
// CAS contract (state-plane):
//   - setTaskInputRequired: WORKING + pending=null -> INPUT_REQUIRED + pending stash
//   - clearTaskPending:     INPUT_REQUIRED + pending=this -> WORKING + pending cleared
// Both return true only when the UPDATE actually changed a row, so callers
// can detect lost-races without an extra SELECT.
//
// Message writes (history-plane) delegate to the existing
// `makeMessagesRepo(db).appendMessage` so the v1.0 Part schema, the
// ROLE_AGENT UPSERT-on-run_id contract, and the per-context `ord` counter
// stay funneled through one writer (T2 spike, spec §12). Tool blocks are
// encoded as DataPart so `walk()` round-trips them as tool_use / tool_result
// ReplayEntries.

function setTaskInputRequired(
  db: Database,
  taskId: string,
  toolUseId: string,
  question: string,
  options: string[] | undefined,
): boolean {
  const now = Date.now();
  const optionsJson = options === undefined ? "null" : JSON.stringify(options);
  const res = db.run(
    `UPDATE tasks
       SET state = 'TASK_STATE_INPUT_REQUIRED',
           metadata = json_set(
             json_set(
               json_set(
                 COALESCE(metadata, '{}'),
                 '$.pending_tool_use_id', ?
               ),
               '$.question', ?
             ),
             '$.options', json(?)
           ),
           updated_at = ?
     WHERE id = ?
       AND state = 'TASK_STATE_WORKING'
       AND (json_extract(metadata, '$.pending_tool_use_id') IS NULL)`,
    [toolUseId, question, optionsJson, now, taskId],
  );
  return res.changes > 0;
}

function clearTaskPending(
  db: Database,
  taskId: string,
  toolUseId: string,
): boolean {
  const now = Date.now();
  const res = db.run(
    `UPDATE tasks
       SET state = 'TASK_STATE_WORKING',
           metadata = json_remove(
             metadata,
             '$.pending_tool_use_id',
             '$.question',
             '$.options'
           ),
           updated_at = ?
     WHERE id = ?
       AND state = 'TASK_STATE_INPUT_REQUIRED'
       AND json_extract(metadata, '$.pending_tool_use_id') = ?`,
    [now, taskId, toolUseId],
  );
  return res.changes > 0;
}

interface AppendToolUseArgs {
  taskId: string;
  contextId: string;
  runId: string | null;
  toolUseId: string;
  question: string;
  options: string[] | undefined;
}

function appendToolUseMessage(db: Database, a: AppendToolUseArgs): number {
  const input: Record<string, unknown> =
    a.options === undefined
      ? { question: a.question }
      : { question: a.question, options: a.options };
  const part: DataPart = {
    data: {
      kind: "tool_use",
      tool_call_id: a.toolUseId,
      tool_name: "ask_user",
      input,
    },
  };
  // VOS-104 T8b: surface the question text in `parts_text` so this row
  // contributes to ChatList previews while the run is paused at ask_user.
  // Without an override, flattenText returns "" (the row is just a tool_use
  // DataPart with no text Parts), the list subquery returns NULL/empty,
  // and the plugin's `isEmpty` predicate hides the chat row.
  return makeMessagesRepo(db).appendMessage(
    a.taskId,
    a.contextId,
    a.runId,
    "ROLE_AGENT",
    [part],
    undefined,
    a.question,
  );
}

interface AppendToolResultArgs {
  taskId: string;
  contextId: string;
  runId: string | null;
  toolUseId: string;
  answer: string;
}

function appendToolResultMessage(
  db: Database,
  a: AppendToolResultArgs,
): number {
  const part: DataPart = {
    data: {
      kind: "tool_result",
      tool_call_id: a.toolUseId,
      output: a.answer,
      is_error: false,
    },
  };
  return makeMessagesRepo(db).appendMessage(
    a.taskId,
    a.contextId,
    a.runId,
    "ROLE_USER",
    [part],
  );
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
      // CAS + history-write in one tx — helpers defined above this module.
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

      // VOS-118: surface the pending question to SSE subscribers (CLI chat
      // REPL). The CLI's stream-render Frame for ask_user expects
      // {tool_use_id, prompt, run_id?}; chat-stream.ts translates this bus
      // event into that frame shape. Routed on the same bus that carries
      // task.state_changed so SSE listeners can rely on a single source of
      // truth. chatId on the envelope is set to contextId so chat-stream's
      // per-chat filter matches; payload also carries chat_id for the
      // broadcast() consumer pattern.
      bus.emit({
        type: "chat.ask_user",
        chatId: args.contextId,
        runId: args.runId ?? undefined,
        payload: {
          chat_id: args.contextId,
          run_id: args.runId,
          tool_use_id: args.toolUseId,
          question: args.question,
          options: args.options ?? null,
        },
      });

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
