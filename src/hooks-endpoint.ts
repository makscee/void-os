// hooks-endpoint.ts — pure hook handler + per-Run CC settings writer.
// One responsibility: hook→registry mapping + settings.json generation.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { setRunState, setResumeToken, getRun, getSession, incrementStep, setRunFail } from "./registry.ts";

// --- Hook payload types (CC lifecycle events + daemon-synthetic events) ---

export interface HookPayload {
  hook_event_name: string;
  session_id: string;
  source?: string;           // SessionStart: "startup" | "resume"
  stop_hook_active?: boolean; // Stop hook field
  reason?: string;           // SessionEnd reason
  exit_code?: number;        // ProcessExit (daemon-synthetic, not a CC event)
  [key: string]: unknown;
}

/**
 * Map a hook payload to a registry state transition.
 * The run is attributed by `runId` (embedded in the hook URL: /hook?run=<id>).
 * `session_id` in the payload is used only to fill sessions.resume_token.
 *
 * CC lifecycle events handled (real CC hook event names):
 *   SessionStart → run.state = running; fill session.resume_token if null
 *   Stop         → run.state = idle
 *   SessionEnd   → run.state = exited_ok
 *
 * Daemon-synthetic events (fired by vos-run-wrapper.sh, NOT CC):
 *   ProcessExit  → run.state = exited_fail when exit_code != 0 AND run is not
 *                  already in a terminal state (SessionEnd already fired → no-op).
 *
 * NOTE: StopFailure is NOT a real CC hook event. It was removed. The correct
 * way to detect non-zero CC exit is via the vos-run-wrapper.sh ProcessExit event.
 */
export function handleHookEvent(
  db: Database,
  runId: string,
  payload: HookPayload,
  now: number,
  killSession: (tmuxSession: string) => void = () => {},
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
    case "ProcessExit": {
      // Daemon-synthetic event fired by vos-run-wrapper.sh AFTER CC exits.
      // Only transition to exited_fail if exit_code != 0 AND the run has not
      // already been moved to a terminal state by SessionEnd (CC fires SessionEnd
      // before the process fully exits on normal exit paths).
      const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : 0;
      const alreadyTerminal = run.state === "exited_ok" || run.state === "exited_fail";
      if (exitCode !== 0 && !alreadyTerminal) {
        setRunState(db, runId, "exited_fail", now);
      }
      break;
    }
    case "PreToolUse": {
      // Step-ceiling applies ONLY to trigger-fired runs (step_ceiling non-null).
      // Interactive runs have null ceiling → never counted, never killed.
      if (run.step_ceiling == null) break;
      if (run.state === "exited_ok" || run.state === "exited_fail") break; // already terminal
      const count = incrementStep(db, runId);
      if (count >= run.step_ceiling) {
        killSession(run.tmux_session);         // tmux kill-session = stop the runaway
        setRunFail(db, runId, "runaway-ceiling", now);
      }
      break;
    }
    default:
      // Unknown event — no-op; hooks must never cause a 5xx
      break;
  }
}

// --- Per-Run CC settings writer ---

// Real CC lifecycle hook event names (subset used for state machine; others pass through).
// SessionStart, Stop, SessionEnd are the three we wire. SubagentStop, PreToolUse,
// PostToolUse, UserPromptSubmit, PreCompact, Notification are also valid CC events but
// are not needed for the run state machine.
// PreToolUse is included so the step counter fires for every tool invocation.
// The counter is a no-op for interactive runs (null step_ceiling guard in handleHookEvent).
const LIFECYCLE_EVENTS = ["SessionStart", "Stop", "SessionEnd", "PreToolUse"] as const;

export interface CcHookEntry {
  type: "command";
  command: string;
}

export interface CcHookSettings {
  hooks: Record<string, { hooks: CcHookEntry[] }[]>;
}

/**
 * Build a CC settings.json `hooks` block.
 * Each lifecycle event runs the vos-hook-relay.sh script, which reads the hook
 * JSON payload from stdin (as CC provides it) and POSTs it to /hook?run=<runId>.
 *
 * @param relayScript - absolute path to vos-hook-relay.sh
 * @param daemonUrl   - e.g. "http://127.0.0.1:4317"
 * @param runId       - the Run ID to embed in the hook URL
 */
export function buildHookSettings(
  relayScript: string,
  daemonUrl: string,
  runId: string,
): CcHookSettings {
  const command = `"${relayScript}" "${daemonUrl}" "${runId}"`;
  const hooks: CcHookSettings["hooks"] = {};
  for (const ev of LIFECYCLE_EVENTS) {
    hooks[ev] = [{ hooks: [{ type: "command", command }] }];
  }
  return { hooks };
}

/**
 * Write a per-Run settings.json into `dir` and return its path.
 * The Run is launched with `claude --settings <path>` so hooks are scoped to this Run.
 *
 * @param dir          - directory to write the settings file (hookSettingsDir)
 * @param relayScript  - absolute path to vos-hook-relay.sh
 * @param daemonUrl    - daemon base URL, e.g. "http://127.0.0.1:4317"
 * @param runId        - unique Run ID
 */
export function writeHookSettings(
  dir: string,
  relayScript: string,
  daemonUrl: string,
  runId: string,
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${runId}.settings.json`);
  writeFileSync(path, JSON.stringify(buildHookSettings(relayScript, daemonUrl, runId), null, 2));
  return path;
}
