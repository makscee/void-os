// hooks-endpoint.ts — pure hook handler + per-Run CC settings writer.
// One responsibility: hook→registry mapping + settings.json generation.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { setRunState, setResumeToken, getRun, getSession } from "./registry.ts";

// --- Hook payload types (CC lifecycle events) ---

export interface HookPayload {
  hook_event_name: string;
  session_id: string;
  source?: string;         // SessionStart: "startup" | "resume"
  stop_hook_active?: boolean; // Stop hook field
  reason?: string;         // SessionEnd reason
  error?: string;          // StopFailure error
  [key: string]: unknown;
}

/**
 * Map a CC hook payload to a registry state transition.
 * The run is attributed by `runId` (embedded in the hook URL: /hook?run=<id>).
 * `session_id` in the payload is used only to fill sessions.resume_token.
 *
 * State machine:
 *   SessionStart → run.state = running; fill session.resume_token if null
 *   Stop         → run.state = idle
 *   SessionEnd   → run.state = exited_ok
 *   StopFailure  → run.state = exited_fail
 */
export function handleHookEvent(
  db: Database,
  runId: string,
  payload: HookPayload,
  now: number,
): void {
  const run = getRun(db, runId);
  if (!run) return; // unknown run — no-op

  switch (payload.hook_event_name) {
    case "SessionStart": {
      setRunState(db, runId, "running", now);
      // Fill the resume_token from CC's session_id (only first SessionStart wins — NULL guard).
      setResumeToken(db, run.session_id, payload.session_id, now);
      break;
    }
    case "Stop": {
      setRunState(db, runId, "idle", now);
      break;
    }
    case "SessionEnd": {
      setRunState(db, runId, "exited_ok", now);
      break;
    }
    case "StopFailure": {
      setRunState(db, runId, "exited_fail", now);
      break;
    }
    default:
      // Unknown event — no-op; hooks must never cause a 5xx
      break;
  }
}

// --- Per-Run CC settings writer ---

const LIFECYCLE_EVENTS = ["SessionStart", "Stop", "SessionEnd", "StopFailure"] as const;

export interface CcHookEntry {
  type: "http";
  url: string;
}

export interface CcHookSettings {
  hooks: Record<string, { hooks: CcHookEntry[] }[]>;
}

/**
 * Build a CC settings.json `hooks` block: every lifecycle event POSTs to /hook?run=<runId>.
 */
export function buildHookSettings(daemonUrl: string, runId: string): CcHookSettings {
  const url = `${daemonUrl}/hook?run=${runId}`;
  const hooks: CcHookSettings["hooks"] = {};
  for (const ev of LIFECYCLE_EVENTS) {
    hooks[ev] = [{ hooks: [{ type: "http", url }] }];
  }
  return { hooks };
}

/**
 * Write a per-Run settings.json into `dir` and return its path.
 * The Run is launched with `claude --settings <path>` so hooks are scoped to this Run.
 */
export function writeHookSettings(dir: string, daemonUrl: string, runId: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.settings.json`);
  writeFileSync(path, JSON.stringify(buildHookSettings(daemonUrl, runId), null, 2));
  return path;
}
