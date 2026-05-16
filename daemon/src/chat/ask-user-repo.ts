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

import type { Database } from "bun:sqlite";
import type { DataPart } from "../types/a2a";
import { makeMessagesRepo } from "./messages-repo";

export function setTaskInputRequired(
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

export function clearTaskPending(
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

export interface AppendToolUseArgs {
  taskId: string;
  contextId: string;
  runId: string | null;
  toolUseId: string;
  question: string;
  options: string[] | undefined;
}

export function appendToolUseMessage(db: Database, a: AppendToolUseArgs): number {
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
  return makeMessagesRepo(db).appendMessage(
    a.taskId,
    a.contextId,
    a.runId,
    "ROLE_AGENT",
    [part],
  );
}

export interface AppendToolResultArgs {
  taskId: string;
  contextId: string;
  runId: string | null;
  toolUseId: string;
  answer: string;
}

export function appendToolResultMessage(
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
