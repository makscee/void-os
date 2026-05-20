/**
 * VOS-163: dedicated teardown for the operator-journey Playwright project.
 *
 * Mirrors globalTeardown-ask-user.ts but reads the sidecar path from
 * VOS_E2E_STATE_JOURNEY (set by globalSetup-journey.ts).
 */
import * as fs from "node:fs";

export default async function globalTeardownJourney() {
  const statePath = process.env.VOS_E2E_STATE_JOURNEY;
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
