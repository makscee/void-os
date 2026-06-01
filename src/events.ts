// events.ts — file-level hook/event log (files-first source of truth, ADR-0003 §0).
// Every execution lifecycle event is appended as one JSONL line to
// <vault>/.void-os/events/<execId>.jsonl. The executions SQLite table is a read-model
// rebuildable from these files via rebuildExecutions — no info lives only in the DB.
import { mkdirSync, appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { eventsDir, eventLogPath } from "./paths.ts";
import { createExecution, setExecutionEnded, setExecutionFail, incrementStep } from "./registry.ts";

export type ExecEvent =
  | { type: "start"; agent: string | null; skill: string | null; input_ref: string | null;
      tmux_session: string; at: number; trigger_id: string | null; step_ceiling: number | null }
  | { type: "step"; at: number }
  | { type: "end"; at: number }
  | { type: "fail"; reason: string; at: number };

/** Append one event line to the per-execution JSONL log (the durable source of truth). */
export function appendEvent(vault: string, execId: string, ev: ExecEvent): void {
  mkdirSync(eventsDir(vault), { recursive: true });
  appendFileSync(eventLogPath(vault, execId), JSON.stringify(ev) + "\n");
}

/** Reconstruct the executions table purely from the event-log files. Idempotent on a fresh db. */
export function rebuildExecutions(db: Database, vault: string): void {
  const dir = eventsDir(vault);
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const execId = file.replace(/\.jsonl$/, "");
    const lines = readFileSync(join(dir, file), "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const ev = JSON.parse(line) as ExecEvent;
      switch (ev.type) {
        case "start":
          createExecution(db, { id: execId, agent: ev.agent, skill: ev.skill, inputRef: ev.input_ref,
            tmuxSession: ev.tmux_session, now: ev.at, triggerId: ev.trigger_id, stepCeiling: ev.step_ceiling });
          break;
        case "step": incrementStep(db, execId); break;
        case "end": setExecutionEnded(db, execId, ev.at); break;
        case "fail": setExecutionFail(db, execId, ev.reason, ev.at); break;
      }
    }
  }
}
