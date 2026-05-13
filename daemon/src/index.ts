/**
 * void-os daemon entry point.
 *
 * Bun + Hono HTTP server with WebSocket upgrade on :7777.
 * Thin: open DB, resolve vault root, build app, start server.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { buildApp, VERSION, wsHandler } from "./app.ts";
import { openDatabase } from "./adapters/sqlite/index.ts";

const PORT = Number(process.env.VOID_OS_PORT ?? 7777);
const HOST = process.env.VOID_OS_HOST ?? "127.0.0.1";

function defaultVaultRoot(): string {
  // brew install layout puts the vault under XDG-style state dir.
  return process.env.VOID_OS_VAULT_ROOT
    ?? path.join(os.homedir(), "Library", "Application Support", "void-os", "vault");
}

const vaultRoot = defaultVaultRoot();
if (!fs.existsSync(vaultRoot)) {
  console.error(`void-os: vault root does not exist: ${vaultRoot}`);
  console.error("set VOID_OS_VAULT_ROOT or run void-os init");
  process.exit(2);
}

const dbPath = process.env.VOID_OS_DB ?? path.join(path.dirname(vaultRoot), "state.sqlite");
const db = openDatabase(dbPath);

const app = buildApp({ db, vaultRoot });

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/events") {
      if (srv.upgrade(req)) return;
      return new Response("expected WebSocket upgrade", { status: 426 });
    }
    return app.fetch(req);
  },
  websocket: wsHandler,
});

console.log(`void-os daemon v${VERSION} listening on http://${server.hostname}:${server.port}`);
console.log(`  vault: ${vaultRoot}`);
console.log(`  db:    ${dbPath}`);
