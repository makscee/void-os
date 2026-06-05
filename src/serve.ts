// serve.ts — start the Hono server + open browser (Task 12)
// F5: port 4317 hardcoded; --port flag or VOID_OS_PORT env override.
// --no-open: skip browser-open (required for G6 headless E2E).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { makeApp } from "./server.ts";
import { readConfig, writeConfig, registryDbPath, chatThreadPath } from "./paths.ts";
import { openRegistry } from "./registry.ts";
import { killSession } from "./tmux.ts";
import { reconcileTriggers } from "./triggers-reconcile.ts";
import { fireTrigger, dueTriggers, type SpawnFn } from "./triggers-fire.ts";
import { drainInbox } from "./inbox-watch.ts";
import { makeSpawnFn } from "./spawn-adapter.ts";
import { appendUserMessage } from "./chat.ts";
import { reapIdle } from "./reaper.ts";
import type { Database } from "bun:sqlite";
import { discoverDaemons, isKillableDaemon, type DaemonInfo } from "./discover-daemons.ts";

/**
 * Handle a drainInbox callback for a single bus line. If the persisted BusLine file at
 * `inputRef` carries `kind="chat"` with a `routing.thread`, this function:
 *   1. Deposits the user's message into the thread history file (appendUserMessage).
 *   2. Fires the trigger with `input`/`inputRef` both pointing at the thread file.
 *   3. Returns true so the caller knows the chat path was taken.
 * Returns false for non-chat lines or when `inputRef` is absent/unreadable (caller fires
 * the default path).
 *
 * Exported for unit-testing; the live serve tick calls this.
 */
export function handleChatBusLine(
  vault: string,
  db: Database,
  name: string,
  input: string,
  inputRef: string | null,
  spawnFn: SpawnFn,
  now: number = Date.now(),
): boolean {
  if (!inputRef) return false;
  try {
    const bl = JSON.parse(readFileSync(inputRef, "utf8")) as Record<string, unknown>;
    if (bl.kind !== "chat") return false;
    const routing = (bl.routing ?? {}) as Record<string, unknown>;
    const thread = typeof routing.thread === "string" ? routing.thread : "";
    if (!thread) return false;
    const at = typeof bl.ts === "number" ? bl.ts : now;
    appendUserMessage(vault, thread, typeof bl.payload === "string" ? bl.payload : input, at);
    const threadFile = chatThreadPath(vault, thread);
    fireTrigger(db, name, { spawn: spawnFn, now, input: threadFile, inputRef: threadFile });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether a thrown error from Bun.serve is an "address already in use" failure
 * (VOS-229). Bun surfaces this as an error whose `code` is "EADDRINUSE" and/or whose
 * message mentions the port being in use. We match on either so the detector is robust
 * across Bun versions / message phrasings.
 */
export function isPortInUse(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === "string" && e.code === "EADDRINUSE") return true;
  if (typeof e.message === "string") {
    const m = e.message.toLowerCase();
    if (m.includes("eaddrinuse")) return true;
    if (m.includes("address already in use")) return true;
    if (m.includes("is port") && m.includes("in use")) return true; // Bun's "Is port N in use?"
  }
  return false;
}

export interface GuardDeps {
  selfPid: number;
  discover: () => Promise<DaemonInfo[]>;
  kill: (pid: number) => Promise<void>;
}

/**
 * VOS-232: before binding, kill any *stale same-vault* daemon — a daemon already
 * serving THIS resolved-absolute vault (a re-run pile-up / leftover zombie). Foreign-vault
 * daemons are left alone (a daemon on a different vault/port is legitimate). Self is never
 * killed. A same-port-but-DIFFERENT-vault collision is NOT handled here — that falls through
 * to the existing VOS-229 EADDRINUSE clear-error path in runServe (no blind kill of a
 * foreign-vault daemon).
 */
export async function guardStaleSameVault(vault: string, deps: GuardDeps): Promise<void> {
  let daemons: DaemonInfo[];
  try { daemons = await deps.discover(); } catch { return; } // discovery failure must never block serve
  for (const d of daemons) {
    if (d.vault !== vault) continue;             // foreign vault — leave alone
    if (!isKillableDaemon(d, deps.selfPid)) continue; // never self / bogus pid
    try { await deps.kill(d.pid); } catch { /* already gone */ }
  }
}

/** Resolve the port: --port <n> flag > VOID_OS_PORT env > void-os.json > 4317. */
export function resolvePort(argv: string[], env: Record<string, string | undefined>, cfgPort: number): number {
  const flagIdx = argv.indexOf("--port");
  if (flagIdx !== -1 && argv[flagIdx + 1]) {
    const n = parseInt(argv[flagIdx + 1], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  if (env.VOID_OS_PORT) {
    const n = parseInt(env.VOID_OS_PORT, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return cfgPort;
}

/** Resolve the vault dir: VOID_OS_VAULT env > cwd if it has void-os.json > ~/void-os. */
export function resolveVault(env: Record<string, string | undefined>, cwd: string): string {
  if (env.VOID_OS_VAULT) return env.VOID_OS_VAULT;
  if (existsSync(join(cwd, "void-os.json"))) return cwd;
  return join(env.HOME ?? "/tmp", "void-os");
}

export async function runServe(): Promise<void> {
  const vault = resolveVault(process.env as Record<string, string | undefined>, process.cwd());

  if (!existsSync(join(vault, "void-os.json"))) {
    console.error(`no void-os vault at ${vault} — run \`void-os init\` first`);
    process.exit(1);
  }

  const cfg = readConfig(vault);
  const port = resolvePort(process.argv, process.env as Record<string, string | undefined>, cfg.port);

  // Persist port override so subsequent serves remember it.
  if (port !== cfg.port) {
    cfg.port = port;
    writeConfig(cfg);
  }

  // Open the registry DB (create dir if needed).
  const dbPath = registryDbPath(vault);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openRegistry(dbPath);

  const daemonUrl = `http://127.0.0.1:${port}`;
  const spawnFn = makeSpawnFn(db, vault, daemonUrl);
  const app = makeApp(vault, db, spawnFn);
  const url = `http://localhost:${port}`;

  // Reconcile Trigger files on boot so daemon picks up any existing Trigger files.
  try { reconcileTriggers(db, vault, Date.now()); } catch { /* never crash serve */ }
  const inboxOffsets = new Map<string, number>();

  // Trigger scheduler tick: reconcile files + fire due schedule triggers + drain event inboxes.
  // 30s resolution is fine for cron-minute schedules.
  const TRIGGER_TICK_MS = 30_000;
  setInterval(() => {
    try {
      const now = Date.now();
      // Fire due triggers BEFORE reconciling — reconcile can advance next_fire_at
      // which would skip a fire that's currently due.
      for (const t of dueTriggers(db, now)) {
        fireTrigger(db, t.name, { spawn: spawnFn, now, input: null });
      }
      // Then reconcile (picks up newly-added/edited files; doesn't overwrite live next_fire_at)
      reconcileTriggers(db, vault, now);
      drainInbox(db, vault, inboxOffsets, (name, input, inputRef) => {
        // Chat lines: deposit the user turn + set input to the thread file path, so the fresh
        // /chat execution reads the running transcript (ADR-0003 §4).
        if (handleChatBusLine(vault, db, name, input, inputRef, spawnFn, Date.now())) return;
        fireTrigger(db, name, { spawn: spawnFn, now: Date.now(), input, inputRef });
      });
    } catch { /* never crash serve */ }
  }, TRIGGER_TICK_MS).unref();

  // VOS-205: idle-reaper sweep — kill tmux for interactive sessions idle past reapIdleMs.
  // Folds into a separate interval (distinct from trigger tick) so it can be tuned independently.
  // Default: 10 min. Operator configures via void-os.json "reapIdleMs".
  const REAP_IDLE_MS = cfg.reapIdleMs ?? 10 * 60_000;
  const REAP_CHECK_MS = Math.min(REAP_IDLE_MS, 60_000); // check at most every minute
  setInterval(() => {
    try { reapIdle(db, vault, Date.now(), REAP_IDLE_MS); }
    catch { /* never crash serve */ }
  }, REAP_CHECK_MS).unref();

  // VOS-232: clear a stale daemon already serving THIS vault before we bind, so a re-run
  // of `serve` on a vault you're already serving doesn't pile up zombies or EADDRINUSE.
  // Foreign-vault daemons are untouched; a same-port/different-vault collision still falls
  // through to the VOS-229 clear-error below.
  // VOS_DISABLE_STALE_GUARD=1 disables for real-path proof MUTATE arm.
  if (!process.env.VOS_DISABLE_STALE_GUARD) {
    await guardStaleSameVault(vault, {
      selfPid: process.pid,
      discover: () => discoverDaemons(),
      kill: async (pid) => { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } },
    });
    // Give the killed daemon a beat to release the port before we bind.
    await new Promise((r) => setTimeout(r, 300));
  }

  // idleTimeout:255 prevents Bun's 10s default from killing long-lived SSE connections
  // during cold starts. 255 is Bun's max; the SSE loop also sends periodic keepalive
  // pings so connections survive even beyond 255s.
  //
  // VOS-229: catch EADDRINUSE (stale daemon holding the port). The port is config-derived
  // (cfg.port, persisted via writeConfig above) and the daemon URL / trigger-fire client both
  // read it back — auto-falling-forward to a free port would desync the stored config from the
  // live listener, so we take the clear-error route and keep the operator in control.
  try {
    Bun.serve({ port, hostname: "0.0.0.0", fetch: app.fetch, idleTimeout: 255 });
  } catch (err) {
    if (isPortInUse(err)) {
      console.error(
        `void-os serve: port ${port} is already in use.\n` +
        `  A void-os daemon (or another process) is likely already listening on it.\n` +
        `  Resolve it one of these ways:\n` +
        `    • stop the stale daemon:  lsof -ti tcp:${port} | xargs kill\n` +
        `    • or serve on another port:  void-os serve --port <N>`,
      );
      process.exit(1);
    }
    throw err;
  }
  console.log(`void-os serving ${vault} at ${url}`);

  const noOpen = process.argv.includes("--no-open");
  if (!noOpen) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    Bun.spawn([opener, url]);
  }
}
