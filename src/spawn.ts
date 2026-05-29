// spawn.ts — argv builders (Task 6) + spawnTurn fire-and-forget integration (Task 8)
import { openSync, existsSync, statSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { sessionDir, errorPath, bodyPath, runLogPath } from "./paths.ts";

const PERM = ["--permission-mode", "bypassPermissions"] as const;
const RENDER_PREAMBLE = "[render contract: rewrite body.html, no terminal reply]";

/** R4: max ms a spawned vc turn may run before we surface an error. */
const SPAWN_TIMEOUT_MS = 300_000; // 5 minutes — onboarding cold-start needs headroom

/**
 * Build argv for `vc -- ...` to launch a new session with a skill.
 * Callers prepend `vc` and pass this array as the full argv suffix.
 *
 * Shape: -- --session-id <uuid> -p /<skill> [text] --permission-mode bypassPermissions
 */
export function buildLaunchArgv(uuid: string, skill: string, text: string): string[] {
  const prompt = text ? `/${skill} ${text}` : `/${skill}`;
  return ["--", "--session-id", uuid, "-p", prompt, ...PERM];
}

/**
 * Build argv for `vc -- ...` to resume a session and inject an answer.
 * Prompt is the render-contract preamble + newline + the user-supplied text.
 * For form-field answers, callers should format text as "key: value\n..." lines.
 *
 * Shape: -- --resume <uuid> -p <preamble\ntext> --permission-mode bypassPermissions
 */
export function buildAnswerArgv(uuid: string, text: string): string[] {
  const prompt = `${RENDER_PREAMBLE}\n${text}`;
  return ["--", "--resume", uuid, "-p", prompt, ...PERM];
}

/** Return the next run index (1-based) for this session's run-N.log files. */
function nextRunIndex(vault: string, uuid: string): number {
  const dir = sessionDir(vault, uuid);
  if (!existsSync(dir)) return 1;
  const used = readdirSync(dir).filter((f) => /^run-\d+\.log$/.test(f)).length;
  return used + 1;
}

/**
 * Fire-and-forget: spawn `vc -- …` in the vault, pipe output to run-<n>.log,
 * and on exit write error.txt iff the process failed OR exited without advancing
 * body.html (R5: compare mtime BEFORE spawn, not after placeholder write).
 *
 * R4: a SPAWN_TIMEOUT_MS watchdog kills the process and writes an error if it hangs.
 */
export function spawnTurn(vault: string, uuid: string, argv: string[]): void {
  const n = nextRunIndex(vault, uuid);
  const logFd = openSync(runLogPath(vault, uuid, n), "a");
  const bp = bodyPath(vault, uuid);

  // R5: snapshot mtime BEFORE spawning — placeholder write already happened upstream
  // (server.ts writes placeholder before calling spawnTurn for launch).
  // For resume/answer turns body.html already exists with real content.
  const beforeMtime = existsSync(bp) ? statSync(bp).mtimeMs : 0;

  const proc = Bun.spawn(["vc", ...argv], {
    cwd: vault,
    env: { ...process.env, VOID_OS_SESSION: uuid },
    stdout: logFd,
    stderr: logFd,
  });

  // R4: timeout watchdog — kills and surfaces error if vc hangs
  const watchdog = setTimeout(() => {
    proc.kill();
    writeFileSync(
      errorPath(vault, uuid),
      `timeout after ${SPAWN_TIMEOUT_MS / 1000}s — vc process killed`,
    );
  }, SPAWN_TIMEOUT_MS);

  proc.exited.then((code) => {
    clearTimeout(watchdog);
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
