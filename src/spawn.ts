// spawn.ts — argv builders (Task 6) + spawnTurn fire-and-forget integration (Task 8)
import { openSync, closeSync, existsSync, statSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { sessionDir, errorPath, bodyPath, runLogPath, pidPath, stopPath } from "./paths.ts";

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
