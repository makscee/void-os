// VOS-89 T6: bus-await helper.
//
// Subscribe to `task.state_changed` BEFORE doing a DB recheck, so we cannot
// miss an emit fired between "DB says not-terminal" and "subscribe completes".
// The EventBus surface (daemon/src/events/index.ts) returns an unsubscribe
// function from .subscribe(), and dispatch is synchronous in-process, so the
// subscribe-before-recheck ordering is sufficient — no extra locking needed.

import type { Database } from "bun:sqlite";
import type { EventBus, DaemonEvent } from "../../../events";

export type TerminalState =
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_CANCELED";

const TERMINALS: ReadonlySet<string> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
]);

export interface WaitArgs {
  db: Database;
  bus: EventBus;
  childTaskId: string;
}

export function waitForChildTerminal({
  db,
  bus,
  childTaskId,
}: WaitArgs): Promise<TerminalState> {
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

    // Race-guard: if the child already reached a terminal state before we
    // subscribed, no future emit will arrive. Resolve from the DB.
    const row = db
      .query("SELECT state FROM tasks WHERE id = ?")
      .get(childTaskId) as { state: string } | undefined;
    if (row && TERMINALS.has(row.state)) {
      settle(row.state as TerminalState);
    }
  });
}
