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
 * Send a text line to a live tmux session pane via the REPL.
 * First sends the literal text (-l flag avoids key-binding interpretation),
 * then sends Enter to submit it.
 */
export function sendKeys(target: string, line: string): void {
  // -l sends the literal text, then a separate Enter keystroke submits it.
  run(["send-keys", "-t", target, "-l", line]);
  run(["send-keys", "-t", target, "Enter"]);
}

/**
 * List all session names on the void-os socket.
 * Returns [] when the socket has no sessions yet (exit code non-zero).
 */
export function listVosSessions(): string[] {
  const r = run(["list-sessions", "-F", "#{session_name}"]);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}
