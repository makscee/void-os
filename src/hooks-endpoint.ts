// hooks-endpoint.ts — pure hook handler + per-execution CC settings writer.
// One responsibility: hook→executions mapping + settings.json generation.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { getExecution, setExecutionEnded, setExecutionFail, incrementStep, setOutputResult } from "./registry.ts";
import { appendEvent, readStartEvent } from "./events.ts";
import { wasMutatedSince } from "./output-target.ts";

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

/** A CC Stop-hook block decision relayed back to CC via the hook's stdout. */
export interface HookDecision { decision: "block"; reason: string; }

/**
 * Map a hook payload to an executions state transition + append to event log.
 * The execution is attributed by `runId` (embedded in the hook URL: /hook?run=<id>).
 *
 * Stateless model (ADR-0003): no resume_token, no idle state.
 *   SessionStart  → no state mutation (stateless; start event written at spawn); log-only
 *   Stop          → output-target mutation check (VOS-191); may return a block decision
 *   SessionEnd    → setExecutionEnded
 *   ProcessExit   → setExecutionEnded (exit_code=0) or setExecutionFail (exit_code≠0)
 *   PreToolUse    → incrementStep; if step_count ≥ step_ceiling → killSession + setExecutionFail
 *
 * Returns a HookDecision when the Stop hook should block the stop (nudge the agent).
 * Returns undefined to allow the stop/continue normally.
 */
export function handleHookEvent(
  db: Database,
  vault: string,
  runId: string,
  payload: HookPayload,
  now: number,
  killSession: (tmuxSession: string) => void = () => {},
): HookDecision | undefined {
  const exec = getExecution(db, runId);
  if (!exec) return undefined; // unknown execution — no-op
  if (exec.ended_at != null) return undefined; // already terminal — no-op

  switch (payload.hook_event_name) {
    case "SessionStart":
      // No state mutation (stateless); SessionStart is implicit in the 'start' event written at spawn.
      // SessionStart carries no lifecycle meaning in the stateless model — no-op.
      break;
    case "Stop": {
      const start = readStartEvent(vault, runId);
      const target = start?.output_target ?? null;
      if (!target) break; // no declared output → nothing to enforce; allow stop
      const startedAt = start!.at;
      const mutated = wasMutatedSince(vault, target, startedAt);
      const alreadyNudged = exec.nudged === 1 || payload.stop_hook_active === true;
      if (mutated) {
        setOutputResult(db, runId, { producedChange: true, nudged: exec.nudged === 1 });
        appendEvent(vault, runId, { type: "output-check", produced_change: true, nudged: exec.nudged === 1, at: now });
        break; // produced output → allow stop
      }
      // clean target
      if (alreadyNudged) {
        setOutputResult(db, runId, { producedChange: false, nudged: true });
        appendEvent(vault, runId, { type: "output-check", produced_change: false, nudged: true, at: now });
        break; // give up after one nudge → allow stop
      }
      // first clean Stop → nudge once
      setOutputResult(db, runId, { producedChange: false, nudged: true });
      appendEvent(vault, runId, { type: "output-check", produced_change: false, nudged: true, at: now });
      return {
        decision: "block",
        reason: `You have not yet written your declared output target (${target}). ` +
          `Your output is the FILE, not this message. Write/modify ${target} now, then stop.`,
      };
    }
    case "SessionEnd":
      setExecutionEnded(db, runId, now);
      appendEvent(vault, runId, { type: "end", at: now });
      break;
    case "ProcessExit": {
      const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : 0;
      if (exitCode !== 0) {
        setExecutionFail(db, runId, "process-exit-nonzero", now);
        appendEvent(vault, runId, { type: "fail", reason: "process-exit-nonzero", at: now });
      } else {
        setExecutionEnded(db, runId, now);
        appendEvent(vault, runId, { type: "end", at: now });
      }
      break;
    }
    case "PreToolUse": {
      if (exec.step_ceiling == null) break;       // interactive runs exempt
      const count = incrementStep(db, runId);
      appendEvent(vault, runId, { type: "step", at: now });
      if (count >= exec.step_ceiling) {
        killSession(exec.tmux_session);
        setExecutionFail(db, runId, "runaway-ceiling", now);
        appendEvent(vault, runId, { type: "fail", reason: "runaway-ceiling", at: now });
      }
      break;
    }
    default:
      // Unknown event — no-op; hooks must never cause a 5xx
      break;
  }
}

// --- Per-execution CC settings writer ---

// Real CC lifecycle hook event names used for the execution state machine.
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
 * @param runId       - the execution ID to embed in the hook URL
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
 * Write a per-execution settings.json into `dir` and return its path.
 * The execution is launched with `claude --settings <path>` so hooks are scoped to it.
 *
 * @param dir          - directory to write the settings file (hookSettingsDir)
 * @param relayScript  - absolute path to vos-hook-relay.sh
 * @param daemonUrl    - daemon base URL, e.g. "http://127.0.0.1:4317"
 * @param runId        - unique execution ID
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
