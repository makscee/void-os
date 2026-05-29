// spawn.ts — pure argv builders (Task 6); spawnTurn is G3 (Task 8)
const PERM = ["--permission-mode", "bypassPermissions"] as const;
const RENDER_PREAMBLE = "[render contract: rewrite body.html, no terminal reply]";

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

// spawnTurn: G3 — will import buildLaunchArgv/buildAnswerArgv and invoke child_process
export async function spawnTurn(_argv: string[]): Promise<void> {
  throw new Error("spawnTurn not implemented — scheduled for G3 Task 8");
}
