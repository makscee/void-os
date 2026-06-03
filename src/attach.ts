// attach.ts — void-os attach CLI: park the operator's terminal as a daemon-driven follower.
// VOS-205: the operator runs `void-os attach` in their terminal to become a tmux client
// on the void-os socket. The daemon retargets them to the chosen session via switch-client.
import { spawnSync } from "node:child_process";
import { VOS_SOCKET, hasSession, newRunSession } from "./tmux.ts";

/** The stable "follow" session that the daemon retargets via switch-client. */
export function followTargetName(): string {
  return "vos-follow";
}

/** The tmux command the operator runs to attach to the follow session. */
export function attachInvocation(): string {
  return `tmux -L ${VOS_SOCKET} attach -t ${followTargetName()}`;
}

/**
 * Ensure the follow session exists (a benign holding pane — e.g. `cat` — that the
 * daemon can retarget via switch-client), then exec the operator's terminal into it.
 *
 * The operator's terminal becomes the tmux client. When the web button POSTs
 * /s/:uuid/attach-here, the daemon calls switchClient(vos-run-<uuid>) and the
 * operator's terminal snaps to that session's live chat.
 *
 * NOTE: This function blocks the operator's terminal (correct — it IS the terminal client).
 * Never call from a subagent; intended for operator use only.
 */
export function runAttach(): void {
  const t = followTargetName();
  if (!hasSession(t)) {
    // A benign holding pane. The daemon will switch-client away from it on the first
    // /attach-here button click. "cat" sits idle without consuming CPU.
    newRunSession(t, process.cwd(), "cat", {});
  }
  // Attach in the foreground. The operator's terminal becomes the client.
  spawnSync("tmux", ["-L", VOS_SOCKET, "attach", "-t", t], { stdio: "inherit" });
}
