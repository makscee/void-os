// kill.ts — terminate a spawned runner's whole process group with SIGTERM→SIGKILL escalation.
// Children are spawned detached (own process group, pgid == pid), so process.kill(-pid, sig)
// signals the entire tree (vc + claude descendants) — no orphan "finishes anyway".

/** True if the process group still has at least one live member. */
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

/**
 * Kill the process group led by `pid`: SIGTERM first, then SIGKILL after `graceMs`
 * if anything in the group is still alive. Negative pid targets the whole group.
 * Safe to call when the group is already gone (no throw).
 */
export async function killProcessTree(pid: number, opts: { graceMs?: number } = {}): Promise<void> {
  const graceMs = opts.graceMs ?? 5000;
  if (!Number.isFinite(pid) || pid <= 1) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
  const start = Date.now();
  while (Date.now() - start < graceMs) {
    if (!groupAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (groupAlive(pid)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone between checks */ }
  }
}
