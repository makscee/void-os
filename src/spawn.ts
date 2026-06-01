// spawn.ts — argv builders (Task 6) + spawnTurn fire-and-forget integration (Task 8)
// + spawnRun: create Run row + tmux session + per-Run hook settings
import { openSync, closeSync, existsSync, statSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";
import { sessionDir, errorPath, bodyPath, runLogPath, pidPath, stopPath, hookSettingsDir } from "./paths.ts";
import { createExecution } from "./registry.ts";
import { appendEvent } from "./events.ts";
import { newRunSession } from "./tmux.ts";
import { writeHookSettings } from "./hooks-endpoint.ts";

// Absolute paths to the helper scripts shipped with void-os.
const _repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Path to the CC command hook relay script (reads stdin JSON, POSTs to daemon). */
export const hookRelayScriptPath = join(_repoRoot, "scripts", "vos-hook-relay.sh");
/** Path to the tmux Run wrapper script (runs CC, fires ProcessExit on exit). */
export const runWrapperScriptPath = join(_repoRoot, "scripts", "vos-run-wrapper.sh");

const PERM = ["--permission-mode", "bypassPermissions"] as const;
const RENDER_PREAMBLE = "[render contract: rewrite body.html, no terminal reply]";

/** R4: max ms a spawned vc turn may run before we surface an error.
 * deep-research is a fan-out skill that legitimately runs ~7min (measured 415s on a
 * cold start); 300s killed it mid-research. 12min covers research + cold-start headroom
 * while still catching a truly hung vc (e.g. relay auth hang). */
const SPAWN_TIMEOUT_MS = 720_000; // 12 minutes

/**
 * Build argv suffix for a new session launch (no leading --; the runner command owns that).
 *
 * Shape: --session-id <uuid> -p /<skill> [text] --permission-mode bypassPermissions
 */
export function buildLaunchArgv(uuid: string, skill: string, text: string): string[] {
  const prompt = text ? `/${skill} ${text}` : `/${skill}`;
  return ["--session-id", uuid, "-p", prompt, ...PERM];
}

/**
 * Build argv suffix for resuming a session and injecting an answer.
 * Prompt is the render-contract preamble + newline + the user-supplied text.
 *
 * Shape: --resume <uuid> -p <preamble\ntext> --permission-mode bypassPermissions
 */
export function buildAnswerArgv(uuid: string, text: string): string[] {
  const prompt = `${RENDER_PREAMBLE}\n${text}`;
  return ["--resume", uuid, "-p", prompt, ...PERM];
}

/** Split a runner command prefix into argv tokens (whitespace-separated). */
export function tokenizeCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/** Return the next run index (1-based) for this session's run-N.log files. */
export function nextRunIndex(vault: string, uuid: string): number {
  const dir = sessionDir(vault, uuid);
  if (!existsSync(dir)) return 1;
  const used = readdirSync(dir).filter((f) => /^run-\d+\.log$/.test(f)).length;
  return used + 1;
}

/**
 * Fire-and-forget: spawn `<command> <argv>` in the vault, pipe output to run-<n>.log,
 * and on exit write error.txt iff the process failed OR exited without advancing
 * body.html (R5: compare mtime BEFORE spawn, not after placeholder write).
 *
 * R4: a SPAWN_TIMEOUT_MS watchdog kills the process and writes an error if it hangs.
 *
 * Uses node:child_process spawn with detached:true so the child leads its own process
 * group (pgid == pid). This lets the stop route kill the whole tree (vc + claude
 * descendants) via process.kill(-pid, signal) — no orphan "finishes anyway".
 *
 * @param command - The runner command prefix (e.g. "vc --" or "claude_artem"), tokenized on whitespace.
 */
export function spawnTurn(vault: string, uuid: string, argv: string[], command: string): void {
  const n = nextRunIndex(vault, uuid);
  const logFd = openSync(runLogPath(vault, uuid, n), "a");
  const bp = bodyPath(vault, uuid);

  // R5: snapshot mtime BEFORE spawning — placeholder write already happened upstream
  // (server.ts writes placeholder before calling spawnTurn for launch).
  // For resume/answer turns body.html already exists with real content.
  const beforeMtime = existsSync(bp) ? statSync(bp).mtimeMs : 0;

  const toks = tokenizeCommand(command);
  // detached:true makes the child its own session/process-group leader (pgid == pid).
  // process.kill(-pid, sig) then signals the whole group (vc + claude descendants).
  const proc = spawn(toks[0], [...toks.slice(1), ...argv], {
    cwd: vault,
    env: { ...process.env, VOID_OS_SESSION: uuid },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  // Persist the child pid so the Stop route can kill the whole group.
  // proc.pid is defined when spawn succeeds; guard against spawn failure.
  if (proc.pid != null) {
    writeFileSync(pidPath(vault, uuid), String(proc.pid));
  }

  // R4: timeout watchdog — kills the whole group and surfaces error if vc hangs
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    try { process.kill(-(proc.pid!), "SIGKILL"); } catch { /* already gone */ }
    writeFileSync(
      errorPath(vault, uuid),
      `timeout after ${SPAWN_TIMEOUT_MS / 1000}s — vc process killed`,
    );
  }, SPAWN_TIMEOUT_MS);

  proc.on("exit", (code) => {
    clearTimeout(watchdog);
    try { closeSync(logFd); } catch { /* ignore */ }
    // Clear the pid file — process has exited.
    try { rmSync(pidPath(vault, uuid)); } catch { /* already gone */ }
    // If the watchdog already killed + recorded the timeout, keep that clearer message
    // rather than clobbering it with the generic SIGTERM exit below.
    if (timedOut) return;
    // Race guard: a Stop wrote stopped.txt — this is a LATE natural completion of an
    // already-killed turn. Do NOT write error.txt or touch body.html; stopped is terminal.
    if (existsSync(stopPath(vault, uuid))) return;
    const afterMtime = existsSync(bp) ? statSync(bp).mtimeMs : 0;
    // R5: advanced means body.html mtime strictly increased from the pre-spawn snapshot
    const advanced = afterMtime > beforeMtime;
    // Only surface an error when body.html was NOT advanced — a non-zero exit code with
    // an updated body.html means the skill finished work and the process exited non-cleanly
    // (e.g. CC SIGTERM after the turn), which is acceptable output.
    if (!advanced) {
      const logFile = runLogPath(vault, uuid, n);
      const tail = existsSync(logFile)
        ? readFileSync(logFile, "utf8").split("\n").slice(-15).join("\n")
        : "";
      writeFileSync(
        errorPath(vault, uuid),
        `exit ${code}; body.html NOT updated\n---\n${tail}`,
      );
    }
  });
}

export interface SpawnRunOpts {
  db: Database;
  vault: string;
  daemonUrl: string;    // e.g. "http://127.0.0.1:4317"
  skill: string | null; // slash-command to pass (omit for raw interactive)
  agent: string | null; // agent label
  runnerCommand: string;
  now?: number;
  inputRef?: string | null;    // file-level input reference (inbox line ref for trigger-fired)
  triggerId?: string | null;   // set for trigger-fired executions
  stepCeiling?: number | null; // set for trigger-fired executions
}

export interface SpawnRunResult {
  runId: string;
  tmuxSession: string;
}

/**
 * Create an executions row + a named tmux session containing a live CC/vc subprocess.
 * Stateless (ADR-0003): always fresh --session-id, never --resume.
 * Writes per-execution hook settings so CC fires `type:"command"` hooks to the relay
 * script, which POSTs lifecycle events to /hook?run=<runId>.
 *
 * Also appends the `start` event to the file-level event log so the executions
 * table is rebuildable from files (files-first requirement).
 *
 * The tmux session name is `vos-run-<runId>`.
 */
export function spawnRun(opts: SpawnRunOpts): SpawnRunResult {
  const now = opts.now ?? Date.now();
  const runId = `exec-${randomUUID()}`;
  const ccSeed = randomUUID(); // fresh CC thread every time — NO --resume (ADR-0003 §1)

  // Write per-execution hook settings file (type:"command" hooks → relay script → daemon).
  const settingsPath = writeHookSettings(
    hookSettingsDir(opts.vault),
    hookRelayScriptPath,
    opts.daemonUrl,
    runId,
  );

  // Trigger-fired executions use print mode (-p): CC runs the skill as a headless turn and exits.
  // Print mode skips the workspace trust dialog, fires all hooks, and exits cleanly.
  // --settings scopes hooks to this execution. --add-dir vault: pre-authorize the vault directory.
  const skillArg = opts.skill ? (opts.skill.startsWith("/") ? opts.skill : `/${opts.skill}`) : null;
  const isPrint = !!(opts.triggerId && skillArg); // trigger-fired executions with a skill → print mode
  const argv: string[] = [
    "--session-id", ccSeed,
    "--settings", settingsPath,
    "--permission-mode", "bypassPermissions",
    "--add-dir", opts.vault,
    ...(isPrint ? ["-p", skillArg!] : skillArg ? [skillArg] : []),
  ];
  const toks = tokenizeCommand(opts.runnerCommand);
  const ccCommand = [...toks, ...argv].map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ");

  // Wrap in vos-run-wrapper.sh so ProcessExit fires after CC exits.
  const fullCommand = [
    `"${runWrapperScriptPath}"`,
    `"${opts.daemonUrl}"`,
    `"${runId}"`,
    ccCommand,
  ].join(" ");

  const tmuxSession = `vos-run-${runId}`;
  const pid = newRunSession(tmuxSession, opts.vault, fullCommand, {
    VOID_OS_SESSION: runId,
    VOS_RUN_ID: runId,
  });

  // Write to executions table (runtime read-model)
  createExecution(opts.db, {
    id: runId, agent: opts.agent, skill: opts.skill, inputRef: opts.inputRef ?? null,
    tmuxSession, now, triggerId: opts.triggerId ?? null, stepCeiling: opts.stepCeiling ?? null,
  });

  // Append start event to file log (files-first source of truth — makes table rebuildable)
  appendEvent(opts.vault, runId, {
    type: "start", agent: opts.agent, skill: opts.skill,
    input_ref: opts.inputRef ?? null, tmux_session: tmuxSession, at: now,
    trigger_id: opts.triggerId ?? null, step_ceiling: opts.stepCeiling ?? null,
  });

  return { runId, tmuxSession };
}

/**
 * Awaitable spawn of one runner turn. Returns the exit code. Unlike spawnTurn
 * (fire-and-forget, cwd=vault), this lets the drain runner await each iteration
 * and run it in an arbitrary cwd (the worktree). State I/O still resolves under
 * the vault via sessionDir — cwd and vault are independent.
 *
 * Also uses detached:true + persists pid so the Stop route can kill drain turns.
 * @param cwd - working dir for the spawned vc (the worktree for drains).
 */
export async function runTurn(
  cwd: string,
  vault: string,
  uuid: string,
  argv: string[],
  command: string,
): Promise<number> {
  const n = nextRunIndex(vault, uuid);
  const logFd = openSync(runLogPath(vault, uuid, n), "a");
  const toks = tokenizeCommand(command);
  const proc = spawn(toks[0], [...toks.slice(1), ...argv], {
    cwd,
    env: { ...process.env, VOID_OS_SESSION: uuid },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  if (proc.pid != null) {
    writeFileSync(pidPath(vault, uuid), String(proc.pid));
  }
  const watchdog = setTimeout(() => {
    try { process.kill(-(proc.pid!), "SIGKILL"); } catch { /* already gone */ }
  }, SPAWN_TIMEOUT_MS);
  const code: number = await new Promise((res) => proc.on("exit", (c) => res(c ?? -1)));
  clearTimeout(watchdog);
  try { closeSync(logFd); } catch { /* ignore */ }
  try { rmSync(pidPath(vault, uuid)); } catch { /* already gone */ }
  return code;
}
