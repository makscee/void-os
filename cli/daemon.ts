import { spawn } from "node:child_process";
import { openSync, writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./lib/args.ts";
import { ensureStateDir, pidPath, portPath, logPath, tokenPath } from "./lib/state-dir.ts";
import { formatJson } from "./lib/output.ts";

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
    case "start":  return cmdStart(rest, ctx);
    case "stop":   return cmdStop(rest);
    case "status": return cmdStatus(rest);
    case "logs":   return cmdLogs(rest);
    default:
      console.error(`void-os daemon: unknown subcommand "${sub}"`);
      console.error(DAEMON_USAGE);
      return 2;
  }
}

async function cmdStart(args: string[], ctx: { prefix: string }): Promise<number> {
  const parsed = parseArgs(args, { flags: [], values: ["port", "vault"] });
  if (parsed.help) { console.log(DAEMON_USAGE); return 0; }

  const port = Number(parsed.values.port ?? process.env.VOID_OS_PORT ?? "7777");
  const vault = parsed.values.vault ?? process.env.VOID_OS_VAULT_ROOT;

  ensureStateDir();
  // Already running?
  if (existsSync(pidPath())) {
    const oldPid = parseInt(readFileSync(pidPath(), "utf8"), 10);
    if (Number.isFinite(oldPid) && isAlive(oldPid)) {
      const oldPort = existsSync(portPath()) ? readFileSync(portPath(), "utf8").trim() : "?";
      console.log(`already running (pid=${oldPid} port=${oldPort})`);
      return 0;
    }
  }

  // Resolve vault, mkdir it before spawn — daemon exits 2 if missing.
  const resolvedVault = vault ?? join(process.env.HOME ?? "", "Library/Application Support/void-os/vault");
  mkdirSync(resolvedVault, { recursive: true });

  // Open log file (append).
  const logFd = openSync(logPath(), "a");
  const entry = join(ctx.prefix, "daemon/src/index.ts");
  const child = spawn("bun", ["run", entry], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      VOID_OS_PORT: String(port),
      VOID_OS_VAULT_ROOT: resolvedVault,
    },
  });

  if (!child.pid) {
    console.error(`spawn failed`);
    return 1;
  }
  writeFileSync(pidPath(), String(child.pid));
  writeFileSync(portPath(), String(port));

  const ready = await raceHealth(child, port, 10000);
  if (ready === "ok") {
    // Detach now that we know the daemon is healthy — keeps it alive after
    // this CLI process exits. Deferred until after raceHealth so that
    // unref() never masks exit-event delivery during the readiness poll.
    child.unref();
    const h = ready_health ?? {};
    console.log(`void-os daemon ready (pid=${child.pid} port=${port} vault=${resolvedVault} version=${h.version ?? "?"})`);
    return 0;
  }
  // Failure path: ensure child dead, clean files, print log tail.
  try { process.kill(child.pid, "SIGKILL"); } catch {}
  if (existsSync(pidPath())) unlinkSync(pidPath());
  if (existsSync(portPath())) unlinkSync(portPath());
  console.error(`void-os daemon failed to start (${ready})`);
  printLogTail(20);
  return 1;
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

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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
