/**
 * VOS-109 T7: dedicated teardown for the permission-deny-ui Playwright project.
 *
 * Mirrors globalTeardown-ask-user.ts but reads the sidecar path from
 * VOS_E2E_STATE_PERMISSION_DENY (set by globalSetup-permission-deny-ui.ts).
 */
import * as fs from "node:fs";

export default async function globalTeardownPermissionDenyUi() {
  const statePath = process.env.VOS_E2E_STATE_PERMISSION_DENY;
  if (!statePath || !fs.existsSync(statePath)) return;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    daemonPid: number;
    obsidianPid?: number;
    tmpdir: string;
  };
  if (state.obsidianPid) {
    try { process.kill(state.obsidianPid, "SIGTERM"); } catch { /* already gone */ }
  }
  try { process.kill(state.daemonPid, "SIGTERM"); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 2_000));
  if (state.obsidianPid) {
    try { process.kill(state.obsidianPid, 0); process.kill(state.obsidianPid, "SIGKILL"); } catch { /* gone */ }
  }
  try { process.kill(state.daemonPid, 0); process.kill(state.daemonPid, "SIGKILL"); } catch { /* gone */ }
  try { fs.rmSync(state.tmpdir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
