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
 * READY-MARKERS: strings that only appear in the claude REPL footer once
 * the REPL is fully interactive and accepting input (~20s post-start).
 * The bare ❯ prompt appears at ~1s (boot frame) so is NOT a reliable signal.
 * These strings come from the status-bar / footer row rendered when the REPL
 * is attached and past the model-selection phase:
 *   "bypass permissions on (shift+tab to cycle) · ← for agents"
 *   "← for agents"
 *   "Relay:" (appears in the token/cost status line)
 * Any one of them is sufficient — OR-match for forward-compatibility.
 */
const READY_MARKERS = ["bypass permissions", "for agents", "Relay:"];

/**
 * Poll a tmux pane until the claude REPL is genuinely input-ready.
 *
 * Stronger than waitForPrompt("❯"): requires both the ❯ cursor AND one of the
 * interactive footer/statusline markers that only render when the REPL has
 * finished its startup phase and is accepting keystrokes (~20s after launch).
 *
 * Returns true when ready, false when maxMs elapses.
 * intervalMs: poll cadence (default 1000ms).
 * maxMs: hard cap (default 180_000ms).
 */
export async function waitForReady(
  target: string,
  maxMs: number = 180_000,
  intervalMs: number = 1_000,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const pane = capturePaneContent(target);
    if (pane.includes("❯") && READY_MARKERS.some((m) => pane.includes(m))) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * ACCEPTANCE-MARKERS: strings that appear in the claude REPL pane once it has
 * started processing a turn (i.e. the keystroke was delivered and accepted).
 * "Esc to interrupt" / "esc to interrupt" appears while a turn is running.
 * The spinner / working indicator also uses these strings.
 * We also treat any non-empty token cost delta as acceptance, but the Esc string
 * is the most reliable pane-level signal.
 */
const ACCEPTANCE_MARKERS = ["Esc to interrupt", "esc to interrupt", "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Pure-function seam for kickoff delivery + retry — injectable runner for unit testing.
 *
 * Algorithm:
 *   1. Send the skill line via sendFn.
 *   2. Poll captureFn every acceptPollMs for up to acceptWaitMs for an acceptance signal.
 *   3. If NOT accepted: re-send (belt-and-suspenders). Repeat up to maxAttempts.
 *   4. Stop the instant acceptance is detected — never double-delivers once accepted.
 *
 * Double-send safety: once an acceptance marker appears we return immediately without
 * sending again, regardless of how many attempts remain.
 *
 * @returns number of send attempts made (1 = delivered on first try).
 */
export async function sendKickoffWith(
  captureFn: (target: string) => string,
  sendFn: (target: string, line: string) => void,
  target: string,
  skillLine: string,
  opts: {
    maxAttempts?: number;    // default 6
    acceptWaitMs?: number;   // per-attempt poll window (default 12_000ms)
    acceptPollMs?: number;   // poll cadence inside window (default 1_000ms)
  } = {},
): Promise<number> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const acceptWaitMs = opts.acceptWaitMs ?? 12_000;
  const acceptPollMs = opts.acceptPollMs ?? 1_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    sendFn(target, skillLine);

    // Poll for acceptance
    const deadline = Date.now() + acceptWaitMs;
    while (Date.now() < deadline) {
      const pane = captureFn(target);
      if (ACCEPTANCE_MARKERS.some((m) => pane.includes(m))) return attempt;
      await new Promise((r) => setTimeout(r, acceptPollMs));
    }
    // Not accepted — loop continues to re-send (unless we're at maxAttempts)
  }
  // All attempts exhausted without confirmed acceptance; session may have been reaped.
  return maxAttempts;
}

/**
 * Send a skill kickoff to a live tmux session with retry-until-accepted.
 * Wraps sendKickoffWith with the real capturePaneContent and sendKeys.
 */
export async function sendKickoff(
  target: string,
  skillLine: string,
  opts: {
    maxAttempts?: number;
    acceptWaitMs?: number;
    acceptPollMs?: number;
  } = {},
): Promise<number> {
  return sendKickoffWith(capturePaneContent, sendKeys, target, skillLine, opts);
}

/**
 * List all session names on the void-os socket.
 * Returns [] when the socket has no sessions yet (exit code non-zero).
 */
export function listVosSessions(): string[] {
  const r = run(["list-sessions", "-F", "#{session_name}"]);
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}
