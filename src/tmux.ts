// tmux.ts — thin tmux wrapper: newRunSession / killSession / hasSession / attachCommand.
// One responsibility: tmux substrate. Unit-testable against real tmux.
import { spawnSync } from "node:child_process";

const TMUX = "tmux";

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(TMUX, args, { encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Start a detached tmux session named `name` running `command` in `cwd`.
 * Returns the tmux pane PID (the process inside the session).
 * Throws if the session fails to start.
 *
 * env vars are injected by prefixing the command with `env K=V ...` rather than
 * using `tmux -e` (the -e flag requires tmux ≥3.2; prefix works everywhere).
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
  return `tmux attach -t ${name}`;
}
