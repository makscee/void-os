// resume.ts — on-demand session resume via CC-native --resume.
// VOS-205: ADR-0003 amendment — resume allowed as CC-native `--resume <ccId>` of own
// transcript file. NO warm-keep-alive / sessions-runs tables / resume_token.
// Resume = spawn a NEW tmux session with `vc --raw -- --resume <ccId>`.
import type { Database } from "bun:sqlite";
import { readCcSessionId, buildWrapperCommand, runWrapperScriptPath } from "./spawn.ts";
import { newRunSession, hasSession } from "./tmux.ts";
import { getExecution } from "./registry.ts";
import { sessionDir } from "./paths.ts";

/**
 * Build the argv array for an interactive --resume launch.
 * No -p flag: resumes the interactive REPL, prior transcript visible.
 * VCD-75 proved that `vc --raw -- --resume <ccId>` launches the REPL (no -p needed).
 */
export function buildResumeArgv(
  ccId: string,
  vault: string,
  o: { addDirs?: string[] },
): string[] {
  const argv = ["--resume", ccId, "--add-dir", vault, "--permission-mode", "bypassPermissions"];
  for (const d of o.addDirs ?? []) argv.push("--add-dir", d);
  return argv;
}

/**
 * Tokenise runnerCommand and inject `--raw` before the `--` separator if absent.
 * Resume is always interactive: `--raw` makes vc open the REPL instead of its
 * bubbletea TUI menu, so subsequent tmux send-keys reaches claude directly.
 *
 * Examples:
 *   "vc --"        → ["vc", "--raw", "--"]
 *   "vc --raw --"  → ["vc", "--raw", "--"]   (idempotent)
 *   "vc"           → ["vc"]                  (no separator: pass through unchanged)
 */
export function ensureRawRunner(runnerCommand: string): string[] {
  const toks = runnerCommand.trim().split(/\s+/).filter(Boolean);
  const sepIdx = toks.indexOf("--");
  if (sepIdx !== -1 && !toks.includes("--raw")) {
    toks.splice(sepIdx, 0, "--raw");
  }
  return toks;
}

/**
 * Respawn a reaped session's tmux with `vc --raw -- --resume <ccId>`.
 * Returns the tmux session name (stable across reap+resume), or null if no ccId.
 *
 * The tmux session NAME is reused (same as the original spawn) so that
 * attach/switch-client targets remain stable across the reap→resume cycle.
 *
 * runnerCommand: e.g. "vc --" or "vc --raw --"; passed from server config.
 * daemonUrl: for the wrapper ProcessExit notification.
 */
export function respawnSession(
  db: Database,
  vault: string,
  execId: string,
  runnerCommand: string,
  daemonUrl: string,
): string | null {
  const exec = getExecution(db, execId);
  if (!exec) return null;

  // If the tmux session is still live, nothing to respawn.
  if (hasSession(exec.tmux_session)) return exec.tmux_session;

  // Resolve the CC session ID to resume (cc-actual-session.txt is the primary source).
  const ccId = readCcSessionId(vault, execId);
  if (!ccId) return null;

  const argv = buildResumeArgv(ccId, vault, { addDirs: [] });

  // Assemble the command string the same way spawnRun does (shared buildWrapperCommand).
  const ccCommand = [...ensureRawRunner(runnerCommand), ...argv].map((a) => {
    if (!a.includes(" ") && !a.includes("`")) return a;
    const escaped = a.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }).join(" ");

  const fullCommand = buildWrapperCommand(runWrapperScriptPath, daemonUrl, execId, "interactive", ccCommand);

  // Reuse the original tmux session name (stable target for attach/switch-client).
  newRunSession(exec.tmux_session, vault, fullCommand, {
    VOID_OS_SESSION: execId,
    VOS_RUN_ID: execId,
    VOID_OS_REPO: sessionDir(vault, execId), // non-critical: for context only
  });

  return exec.tmux_session;
}
