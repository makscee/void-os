import { spawn } from "node:child_process";
import { openSync, writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./lib/args.ts";
import {
  ensureStateDir,
  pidPath,
  portPath,
  logPath,
  tokenPath,
  readPidJson,
  writePidJson,
  removePidJson,
} from "./lib/state-dir.ts";
import { formatJson } from "./lib/output.ts";
import pkg from "../daemon/package.json" with { type: "json" };

const PACKAGE_VERSION: string = (pkg as { version?: string }).version ?? "0.0.0";

// VOS-120 T2: structured result for vault-aware start. CLI translates to
// stdout/stderr + exit code; tests inspect the structured value directly.
export type StartOpts = {
  vault: string;
  port?: number;
  prefix?: string;
  dryRun?: boolean;
};
export type StartResult =
  | { status: "already-running"; pid: number; port: number }
  | { status: "vault-mismatch"; activeVault: string; pid: number; port: number }
  | { status: "would-spawn" }
  | { status: "spawned"; pid: number; port: number; vault: string; version?: string }
  | { status: "spawn-failed"; reason: string };

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const DAEMON_USAGE = `usage: void-os daemon <subcommand>

subcommands:
  start [--port N] [--vault PATH]   start the daemon (detached, blocks until /health 200, 10s timeout)
  stop                              SIGTERM then SIGKILL the daemon
  status [--json]                   running/stopped + health info
  logs [-f|--follow] [--tail N]     print or tail ~/.void-os/daemon.log
`;

export default async function daemon(args: string[], ctx: { prefix: string }): Promise<number> {
  // Dispatcher (bin/void-os) strips the top-level "daemon" word, so args[0]
  // is the subcommand (e.g. "start", "stop", ...).
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(DAEMON_USAGE);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case "start":  return cmdStartCli(rest, ctx);
    case "stop":   return cmdStop(rest);
    case "status": return cmdStatus(rest);
    case "logs":   return cmdLogs(rest);
    default:
      console.error(`void-os daemon: unknown subcommand "${sub}"`);
      console.error(DAEMON_USAGE);
      return 2;
  }
}

// CLI-side wrapper: parses flags, calls cmdStart, prints + returns exit code.
// Kept separate from cmdStart so tests can drive the structured API without
// touching process.exit / console.
async function cmdStartCli(args: string[], ctx: { prefix: string }): Promise<number> {
  const parsed = parseArgs(args, { flags: [], values: ["port", "vault"] });
  if (parsed.help) { console.log(DAEMON_USAGE); return 0; }

  const port = Number(parsed.values.port ?? process.env.VOID_OS_PORT ?? "7777");
  const vaultArg = parsed.values.vault ?? process.env.VOID_OS_VAULT_ROOT;
  const resolvedVault = vaultArg ?? join(process.env.HOME ?? "", "Library/Application Support/void-os/vault");

  const result = await cmdStart({ vault: resolvedVault, port, prefix: ctx.prefix });
  switch (result.status) {
    case "already-running":
      console.log(`already running (pid=${result.pid} port=${result.port})`);
      return 0;
    case "vault-mismatch":
      console.error(
        `void-os daemon already serving ${result.activeVault} (pid=${result.pid} port=${result.port}); stop it first`,
      );
      return 1;
    case "spawned":
      console.log(
        `void-os daemon ready (pid=${result.pid} port=${result.port} vault=${result.vault} version=${result.version ?? "?"})`,
      );
      return 0;
    case "spawn-failed":
      console.error(`void-os daemon failed to start (${result.reason})`);
      printLogTail(20);
      return 1;
    case "would-spawn":
      // Only reachable via dryRun, which the CLI never sets. Defensive no-op.
      return 0;
  }
}

// VOS-120 T2: vault-aware start logic. Exported for unit tests + future plugin
// callers (e.g. ensureDaemon). Reads daemon.json; if a daemon is alive serving
// the same vault → no-op; different vault → refuse; dead pid → treat as stale
// and proceed. dryRun short-circuits before spawn (test-only hook).
export async function cmdStart(opts: StartOpts): Promise<StartResult> {
  ensureStateDir();

  const existing = readPidJson();
  if (existing) {
    if (isPidAlive(existing.pid)) {
      if (existing.vault_root === opts.vault) {
        return { status: "already-running", pid: existing.pid, port: existing.port };
      }
      return {
        status: "vault-mismatch",
        activeVault: existing.vault_root,
        pid: existing.pid,
        port: existing.port,
      };
    }
    removePidJson();
  }
  // Legacy compat: also fall back to daemon.pid if daemon.json was missing
  // (warm install from pre-VOS-120 binary). Same vault-awareness is impossible
  // here (the legacy file doesn't record vault), so we treat any live legacy
  // pid as "already-running" without vault check.
  if (!existing && existsSync(pidPath())) {
    const oldPid = parseInt(readFileSync(pidPath(), "utf8"), 10);
    if (Number.isFinite(oldPid) && isPidAlive(oldPid)) {
      const oldPort = existsSync(portPath())
        ? Number(readFileSync(portPath(), "utf8").trim()) || 0
        : 0;
      return { status: "already-running", pid: oldPid, port: oldPort };
    }
  }

  if (opts.dryRun) return { status: "would-spawn" };

  const port = opts.port ?? Number(process.env.VOID_OS_PORT ?? "7777");
  const prefix = opts.prefix;
  if (!prefix) {
    return { status: "spawn-failed", reason: "missing prefix (no entry path)" };
  }

  // mkdir vault before spawn — daemon exits 2 if missing.
  mkdirSync(opts.vault, { recursive: true });

  const logFd = openSync(logPath(), "a");
  const entry = join(prefix, "daemon/src/index.ts");
  const child = spawn("bun", ["run", entry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      VOID_OS_PORT: String(port),
      VOID_OS_VAULT_ROOT: opts.vault,
    },
  });

  if (!child.pid) {
    return { status: "spawn-failed", reason: "spawn returned no pid" };
  }
  // Legacy compat writers (kept one release cycle).
  writeFileSync(pidPath(), String(child.pid));
  writeFileSync(portPath(), String(port));

  const ready = await raceHealth(child, port, 10000);
  if (ready === "ok") {
    // Detach after raceHealth resolves — unref() during the poll can mask
    // exit-event delivery.
    child.unref();
    const h = ready_health ?? {};
    writePidJson({
      pid: child.pid,
      port,
      vault_root: opts.vault,
      version: PACKAGE_VERSION,
      started_at: new Date().toISOString(),
    });
    return { status: "spawned", pid: child.pid, port, vault: opts.vault, version: h.version };
  }
  // Failure: ensure child dead, clean files.
  try { process.kill(child.pid, "SIGKILL"); } catch {}
  if (existsSync(pidPath())) unlinkSync(pidPath());
  if (existsSync(portPath())) unlinkSync(portPath());
  removePidJson();
  return { status: "spawn-failed", reason: ready };
}

// Tiny mutable carrier so cmdStart can read the parsed health body.
let ready_health: { version?: string } | null = null;

async function raceHealth(child: import("node:child_process").ChildProcess, port: number, timeoutMs: number): Promise<"ok" | "timeout" | "child-exit"> {
  ready_health = null;
  const start = Date.now();
  // Seed from the spawn handle in case the child already exited between
  // spawn() returning and us attaching the listener (race on tiny systems
  // or when the child fails fast on EADDRINUSE).
  let childExited = child.exitCode !== null || child.signalCode !== null;
  child.once("exit", () => { childExited = true; });
  while (Date.now() - start < timeoutMs) {
    if (childExited) return "child-exit";
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${tokenOrEmpty()}` } });
      if (r.ok) {
        try { ready_health = await r.json() as { version?: string }; } catch { ready_health = {}; }
        return "ok";
      }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return "timeout";
}

function tokenOrEmpty(): string {
  try { return readFileSync(tokenPath(), "utf8").trim(); } catch { return ""; }
}

function sleep(ms: number): Promise<void> { return new Promise((res) => setTimeout(res, ms)); }

// Local alias retained for readability in stop/status — same impl as the
// exported isPidAlive (kept to avoid call-site churn in this file).
const isAlive = isPidAlive;

function printLogTail(n: number): void {
  try {
    const lp = logPath();
    if (!existsSync(lp)) return;
    const body = readFileSync(lp, "utf8");
    const lines = body.split("\n");
    console.error(lines.slice(-n).join("\n"));
  } catch {}
}

async function cmdStop(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: [], values: [] });
  if (parsed.help) { console.log(DAEMON_USAGE); return 0; }

  if (!existsSync(pidPath())) {
    console.log("not running");
    return 0;
  }
  const pid = parseInt(readFileSync(pidPath(), "utf8"), 10);
  if (!Number.isFinite(pid) || !isAlive(pid)) {
    cleanupFiles();
    console.log("not running");
    return 0;
  }
  // Anti-PID-recycle: verify the live PID is actually void-os via /health.
  const port = existsSync(portPath()) ? readFileSync(portPath(), "utf8").trim() : "";
  let identified = false;
  if (/^\d+$/.test(port)) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${tokenOrEmpty()}` } });
      if (r.ok) {
        const body = await r.json() as { version?: string };
        if (body && typeof body.version === "string") identified = true;
      }
    } catch { /* unreachable — treat as stale */ }
  }
  if (!identified) {
    cleanupFiles();
    console.log("not running (stale pid file)");
    return 0;
  }
  // Signal.
  try { process.kill(pid, "SIGTERM"); } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break;
    await sleep(100);
  }
  if (isAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
    const hardDeadline = Date.now() + 2000;
    while (Date.now() < hardDeadline && isAlive(pid)) await sleep(50);
  }
  cleanupFiles();
  console.log("stopped");
  return 0;
}

function cleanupFiles(): void {
  if (existsSync(pidPath())) unlinkSync(pidPath());
  if (existsSync(portPath())) unlinkSync(portPath());
  removePidJson();
}

async function cmdStatus(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["json"], values: [] });
  if (parsed.help) { console.log(DAEMON_USAGE); return 0; }
  const asJson = !!parsed.flags.json;

  const pidExists = existsSync(pidPath());
  const pid = pidExists ? parseInt(readFileSync(pidPath(), "utf8"), 10) : NaN;
  const alive = Number.isFinite(pid) && isAlive(pid);
  if (!alive) {
    if (asJson) console.log(formatJson({ running: false }));
    else console.log("stopped");
    return 0;
  }
  const portStr = existsSync(portPath()) ? readFileSync(portPath(), "utf8").trim() : "";
  if (!/^\d+$/.test(portStr)) {
    if (asJson) console.log(formatJson({ running: true, pid, error: "no port file" }));
    else console.log(`running (pid=${pid}) but unhealthy: no port file`);
    return 1;
  }
  try {
    const r = await fetch(`http://127.0.0.1:${portStr}/health`, { headers: { Authorization: `Bearer ${tokenOrEmpty()}` } });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const h = await r.json() as { version?: string; vault_root?: string; uptime_s?: number; sessions?: number };
    if (asJson) {
      console.log(formatJson({ running: true, pid, port: Number(portStr), ...h }));
    } else {
      console.log(`running`);
      console.log(`  pid:        ${pid}`);
      console.log(`  port:       ${portStr}`);
      console.log(`  vault:      ${h.vault_root}`);
      console.log(`  uptime_s:   ${h.uptime_s}`);
      console.log(`  version:    ${h.version}`);
      console.log(`  sessions:   ${h.sessions}`);
    }
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (asJson) console.log(formatJson({ running: true, pid, port: Number(portStr), error: msg }));
    else console.log(`running (pid=${pid}) but unhealthy: ${msg}`);
    return 1;
  }
}

async function cmdLogs(args: string[]): Promise<number> {
  const parsed = parseArgs(args, { flags: ["follow"], values: ["tail"], shortMap: { f: "follow" } });
  if (parsed.help) { console.log(DAEMON_USAGE); return 0; }
  const lp = logPath();
  if (!existsSync(lp)) {
    console.error("no daemon log yet");
    return 0;
  }
  if (parsed.flags.follow) {
    // tail -f, inherit stdio so Ctrl-C reaches tail directly.
    const child = spawn("tail", ["-f", lp], { stdio: "inherit" });
    return await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? 0));
    });
  }
  const n = Math.max(0, parseInt(parsed.values.tail ?? "200", 10));
  const body = readFileSync(lp, "utf8");
  // Drop trailing empty line introduced by terminating "\n" so --tail N picks
  // the last N *content* lines, not N-1 + "".
  const lines = body.endsWith("\n") ? body.slice(0, -1).split("\n") : body.split("\n");
  process.stdout.write(lines.slice(-n).join("\n"));
  process.stdout.write("\n");
  return 0;
}
