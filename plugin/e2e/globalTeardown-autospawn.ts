/**
 * VOS-120 T9: dedicated teardown for the daemon-autospawn Playwright project.
 *
 * Kills Obsidian + any daemon under the isolated HOME (one may be left over
 * from the last test in the project), removes the tmpdir.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export default async function globalTeardownAutospawn() {
  const statePath = process.env.VOS_E2E_STATE_AUTOSPAWN;
  if (!statePath || !fs.existsSync(statePath)) return;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    obsidianPid?: number;
    tmpdir: string;
    harnessHome: string;
  };
  // Best-effort: read daemon.json under harnessHome and SIGTERM it.
  try {
    const daemonJson = path.join(state.harnessHome, ".void-os", "daemon.json");
    if (fs.existsSync(daemonJson)) {
      const rec = JSON.parse(fs.readFileSync(daemonJson, "utf8")) as { pid?: number };
      if (typeof rec.pid === "number") {
        try { process.kill(rec.pid, "SIGTERM"); } catch { /* gone */ }
      }
    }
  } catch { /* ignore */ }
  if (state.obsidianPid) {
    try { process.kill(state.obsidianPid, "SIGTERM"); } catch { /* gone */ }
  }
  await new Promise((r) => setTimeout(r, 2_000));
  if (state.obsidianPid) {
    try { process.kill(state.obsidianPid, 0); process.kill(state.obsidianPid, "SIGKILL"); } catch { /* gone */ }
  }
  // Final daemon sweep in case respawn happened between SIGTERM and now.
  try {
    const daemonJson = path.join(state.harnessHome, ".void-os", "daemon.json");
    if (fs.existsSync(daemonJson)) {
      const rec = JSON.parse(fs.readFileSync(daemonJson, "utf8")) as { pid?: number };
      if (typeof rec.pid === "number") {
        try { process.kill(rec.pid, 0); process.kill(rec.pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
  } catch { /* ignore */ }
  try { fs.rmSync(state.tmpdir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
