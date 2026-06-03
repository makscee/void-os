// tmux.ts — thin tmux wrapper: newRunSession / killSession / hasSession / attachCommand.
// One responsibility: tmux substrate. Unit-testable against real tmux.
// VOS-205: all sessions run on the dedicated -L vos socket for isolation.
import { spawnSync } from "node:child_process";

const TMUX = "tmux";

/** The dedicated void-os tmux socket name. All sessions live here, isolated from the operator's tmux. */
export const VOS_SOCKET = "vos";

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(TMUX, ["-L", VOS_SOCKET, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Start a detached tmux session named `name` running `command` in `cwd`.
 * Returns the tmux pane PID (the process inside the session).
 * Throws if the session fails to start.
 *
 * env vars are injected by prefixing the command with `env K=V ...` rather than
 * using `tmux -e` (the -e flag requires tmux ≥3.2; prefix works everywhere).
 * The command string must already have special shell chars escaped (backticks, $, etc.)
 * since tmux passes it to sh. See spawnRun in spawn.ts for the escaping contract.
 */
export function newRunSession(
  name: string,
  cwd: string,
  command: string,
  env: Record<string, string>,
): number {
  // Build `env K=V K2=V2 <command>` prefix so env vars are available in the pane shell.
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  const fullCommand = envPrefix ? `env ${envPrefix} ${command}` : command;
  // -d detached, -s name, -c cwd; command runs directly in the pane.
  const r = run(["new-session", "-d", "-s", name, "-c", cwd, fullCommand]);
  if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim()}`);
  // Pane PID = the process tree root inside the session.
  const p = run(["list-panes", "-t", name, "-F", "#{pane_pid}"]);
  const pid = parseInt(p.stdout.trim().split("\n")[0] ?? "", 10);
  return Number.isFinite(pid) ? pid : -1;
}

export function hasSession(name: string): boolean {
  return run(["has-session", "-t", name]).code === 0;
}

export function killSession(name: string): void {
  // No-op if absent (has-session guards so a missing session never errors).
  if (hasSession(name)) run(["kill-session", "-t", name]);
}

export function attachCommand(name: string): string {
  return `tmux -L ${VOS_SOCKET} attach -t ${name}`;
}

/**
 * Retarget the operator's attached terminal to a different session.
 * The operator's terminal must be attached via `void-os attach` (the vos-follow session)
 * for this to take effect.
 */
export function switchClient(target: string): { code: number; stderr: string } {
  const r = run(["switch-client", "-t", target]);
  return { code: r.code, stderr: r.stderr };
}

/**
 * Pure-function seam for sendKeys — injectable runner for unit testing.
 * A multi-line payload (e.g. serialized form fields "k: v\nk2: v2") is collapsed
 * into a single line so the REPL sees ONE submission, not one per newline.
 * `send-keys -l` delivers an embedded \n as a literal newline keystroke which
 * causes the REPL to submit on the first line and then re-submit on the trailing
 * Enter — double-kickoff. We replace interior newlines with " | " (one-liner join)
 * and emit a single Enter at the end.
 */
export function sendKeysWith(
  runner: (args: string[]) => unknown,
  target: string,
  line: string,
): void {
  const oneLine = line.replace(/\r?\n/g, " | ");
  runner(["send-keys", "-t", target, "-l", oneLine]);
  runner(["send-keys", "-t", target, "Enter"]);
}

/**
 * Send a text line to a live tmux session pane via the REPL.
 * First sends the literal text (-l flag avoids key-binding interpretation),
 * then sends Enter to submit it.
 * Multi-line payloads are collapsed to a single line (see sendKeysWith).
 */
export function sendKeys(target: string, line: string): void {
  sendKeysWith(run, target, line);
}

/**
 * Capture visible pane content of a tmux session as a string.
 * Returns "" if the session does not exist or tmux errors.
 */
export function capturePaneContent(target: string): string {
  const r = run(["capture-pane", "-p", "-t", target]);
  return r.code === 0 ? r.stdout : "";
}

/**
 * Poll a tmux pane until its visible content contains `marker`.
 * Returns true when marker is found, false when maxMs elapses without it.
 *
 * Used by spawnRun to wait for the claude REPL prompt (❯) before sending the
 * skill kickoff via send-keys. A 3-second fixed delay fired before the REPL
 * was ready, silently dropping the keystroke.
 *
 * intervalMs: how often to poll (default 1000ms).
 * maxMs: hard wall-clock cap (default 60000ms = 60s).
 */
export async function waitForPrompt(
  target: string,
  marker: string = "❯",
  maxMs: number = 60_000,
  intervalMs: number = 1_000,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (capturePaneContent(target).includes(marker)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * List all session names on the void-os socket.
 * Returns [] when the socket has no sessions yet (exit code non-zero).
 */
export function listVosSessions(): string[] {
  const r = run(["list-sessions", "-F", "#{session_name}"]);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}
