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
import { fireTrigger, dueTriggers } from "./triggers-fire.ts";
import { drainInbox } from "./inbox-watch.ts";
import { makeSpawnFn } from "./spawn-adapter.ts";
import { appendUserMessage } from "./chat.ts";

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
        if (inputRef) {
          try {
            const bl = JSON.parse(readFileSync(inputRef, "utf8")) as Record<string, unknown>;
            if (bl.kind === "chat") {
              const routing = (bl.routing ?? {}) as Record<string, unknown>;
              const thread = typeof routing.thread === "string" ? routing.thread : "";
              if (thread) {
                const at = typeof bl.ts === "number" ? bl.ts : Date.now();
                appendUserMessage(vault, thread, typeof bl.payload === "string" ? bl.payload : input, at);
                const threadFile = chatThreadPath(vault, thread);
                fireTrigger(db, name, {
                  spawn: spawnFn, now: Date.now(),
                  input: threadFile, inputRef: threadFile,
                });
                return;
              }
            }
          } catch { /* fall through to default fire */ }
        }
        fireTrigger(db, name, { spawn: spawnFn, now: Date.now(), input, inputRef });
      });
    } catch { /* never crash serve */ }
  }, TRIGGER_TICK_MS).unref();

  // idleTimeout:255 prevents Bun's 10s default from killing long-lived SSE connections
  // during cold starts. 255 is Bun's max; the SSE loop also sends periodic keepalive
  // pings so connections survive even beyond 255s.
  Bun.serve({ port, hostname: "0.0.0.0", fetch: app.fetch, idleTimeout: 255 });
  console.log(`void-os serving ${vault} at ${url}`);

  const noOpen = process.argv.includes("--no-open");
  if (!noOpen) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    Bun.spawn([opener, url]);
  }
}
