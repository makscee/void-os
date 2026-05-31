// serve.ts — start the Hono server + open browser (Task 12)
// F5: port 4317 hardcoded; --port flag or VOID_OS_PORT env override.
// --no-open: skip browser-open (required for G6 headless E2E).
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { makeApp } from "./server.ts";
import { readConfig, writeConfig, registryDbPath } from "./paths.ts";
import { openRegistry } from "./registry.ts";

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

  const app = makeApp(vault, db);
  const url = `http://localhost:${port}`;

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
