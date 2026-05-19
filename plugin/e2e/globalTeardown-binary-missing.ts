/**
 * VOS-150 T6: dedicated teardown for the binary-missing Playwright project.
 *
 * Mirrors globalTeardown-autospawn.ts minus the daemon-sweep (no daemon
 * was ever spawned). Just kills Obsidian + removes the tmpdir.
 */
import * as fs from "node:fs";

export default async function globalTeardownBinaryMissing() {
  const statePath = process.env.VOS_E2E_STATE_BINARY_MISSING;
  if (!statePath || !fs.existsSync(statePath)) return;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    obsidianPid?: number;
    tmpdir: string;
  };
  if (state.obsidianPid) {
    try { process.kill(state.obsidianPid, "SIGTERM"); } catch { /* gone */ }
  }
  await new Promise((r) => setTimeout(r, 2_000));
  if (state.obsidianPid) {
    try { process.kill(state.obsidianPid, 0); process.kill(state.obsidianPid, "SIGKILL"); } catch { /* gone */ }
  }
  try { fs.rmSync(state.tmpdir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
