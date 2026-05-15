import * as fs from "node:fs";

export default async function globalTeardown() {
  const statePath = process.env.VOS_E2E_STATE;
  if (!statePath || !fs.existsSync(statePath)) return;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    daemonPid: number;
    tmpdir: string;
  };
  try { process.kill(state.daemonPid, "SIGTERM"); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 2_000));
  try { process.kill(state.daemonPid, 0); process.kill(state.daemonPid, "SIGKILL"); } catch { /* gone */ }
  try { fs.rmSync(state.tmpdir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
