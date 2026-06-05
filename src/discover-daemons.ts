// discover-daemons.ts — find running void-os daemons by listener-probe (VOS-232).
// Discovery is two-stage: (1) enumerate TCP listeners via `lsof`, (2) probe each
// candidate at GET /whoami. A void-os daemon answers with {vault,port,pid}; any other
// listener fails the probe and is dropped — identity is PROVEN by the /whoami answer,
// never inferred from a process name. The kill target is the pid the daemon reports
// about ITSELF, so we never act on a process we couldn't positively identify.

export interface DaemonInfo { pid: number; port: number; vault: string; }
export interface DaemonRow extends DaemonInfo { stale: boolean; }

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` output into deduped {pid,port} listeners. */
export function parseLsofListeners(out: string): Array<{ pid: number; port: number }> {
  const seen = new Set<string>();
  const rows: Array<{ pid: number; port: number }> = [];
  for (const line of out.split("\n")) {
    if (!line.includes("(LISTEN)")) continue;
    const cols = line.trim().split(/\s+/);
    const pid = parseInt(cols[1], 10);
    // NAME is the last col before "(LISTEN)"; port is the trailing :N of the addr.
    const name = cols[cols.length - 2] ?? "";
    const m = name.match(/:(\d+)$/);
    if (!m || Number.isNaN(pid)) continue;
    const port = parseInt(m[1], 10);
    if (Number.isNaN(port)) continue;
    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ pid, port });
  }
  return rows;
}

/** Spawn lsof and parse its listeners. Empty on any failure (lsof absent etc.). */
export async function listListeners(): Promise<Array<{ pid: number; port: number }>> {
  try {
    const p = Bun.spawn(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return parseLsofListeners(out);
  } catch { return []; }
}

/** Probe a port's /whoami. Returns DaemonInfo only for a well-shaped void-os answer. */
export async function probeWhoami(port: number, timeoutMs = 800): Promise<DaemonInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/whoami`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as Partial<DaemonInfo>;
    if (typeof b.vault === "string" && typeof b.port === "number" && typeof b.pid === "number") {
      return { vault: b.vault, port: b.port, pid: b.pid };
    }
    return null;
  } catch { return null; }
}

export interface DiscoverDeps {
  listListeners: () => Promise<Array<{ pid: number; port: number }>>;
  probe: (port: number) => Promise<DaemonInfo | null>;
}

/** Enumerate listeners → probe each → keep only confirmed void-os daemons. */
export async function discoverDaemons(
  deps: DiscoverDeps = { listListeners, probe: probeWhoami },
): Promise<DaemonInfo[]> {
  const listeners = await deps.listListeners();
  const out: DaemonInfo[] = [];
  for (const l of listeners) {
    const info = await deps.probe(l.port);
    if (info) out.push(info);
  }
  return out;
}

/** Stale iff the daemon's resolved-abs vault differs from the target vault. */
export function classifyStale(info: DaemonInfo, targetVault: string): DaemonRow {
  return { ...info, stale: info.vault !== targetVault };
}

/** Kill-safety: only a positively-identified void-os daemon, never self, never pid<=1. */
export function isKillableDaemon(info: DaemonInfo, selfPid: number): boolean {
  if (!Number.isFinite(info.pid) || info.pid <= 1) return false;
  if (info.pid === selfPid) return false;
  return true;
}
