// doctor.ts — `void-os doctor` subcommand (VOS-232).
// Lists every running void-os daemon (pid · port · vault · stale?) for the operator,
// and with --kill-stale cleans every stale daemon at once. "stale" is relative to the
// vault the operator is currently targeting (resolveVault of cwd/env).
import { resolveVault } from "./serve.ts";
import {
  discoverDaemons, classifyStale, isKillableDaemon,
  type DaemonInfo,
} from "./discover-daemons.ts";
export type { DaemonInfo } from "./discover-daemons.ts";

/** Render the operator-facing table. Pure: takes the daemon list + target vault. */
export function renderDoctorTable(daemons: DaemonInfo[], targetVault: string): string {
  if (daemons.length === 0) {
    return `no running void-os daemons found (target vault: ${targetVault})`;
  }
  const rows = daemons.map((d) => classifyStale(d, targetVault));
  const lines = [
    `void-os daemons (target vault: ${targetVault}):`,
    `  PID     PORT    STALE  VAULT`,
    ...rows.map((r) =>
      `  ${String(r.pid).padEnd(7)} ${String(r.port).padEnd(7)} ${(r.stale ? "stale" : "-").padEnd(6)} ${r.vault}`,
    ),
  ];
  return lines.join("\n");
}

export interface KillDeps {
  selfPid: number;
  kill: (pid: number) => Promise<void>;
}

/** Kill every STALE, killable daemon. Same-vault and self are never touched. */
export async function killStaleDaemons(
  daemons: DaemonInfo[], targetVault: string, deps: KillDeps,
): Promise<number[]> {
  const killed: number[] = [];
  for (const d of daemons) {
    const { stale } = classifyStale(d, targetVault);
    if (!stale) continue;
    if (!isKillableDaemon(d, deps.selfPid)) continue;
    await deps.kill(d.pid);
    killed.push(d.pid);
  }
  return killed;
}

/** Default kill: SIGTERM the single daemon process by pid (NOT a process group). */
async function killByPid(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

/** CLI entry: `void-os doctor [--kill-stale]`. Exit 0 on success. */
export async function runDoctor(argv: string[]): Promise<void> {
  const targetVault = resolveVault(process.env as Record<string, string | undefined>, process.cwd());
  const daemons = await discoverDaemons();
  console.log(renderDoctorTable(daemons, targetVault));
  if (argv.includes("--kill-stale")) {
    const killed = await killStaleDaemons(daemons, targetVault, {
      selfPid: process.pid,
      kill: killByPid,
    });
    console.log(killed.length
      ? `killed ${killed.length} stale daemon(s): ${killed.join(", ")}`
      : `no stale daemons to kill`);
  }
}
