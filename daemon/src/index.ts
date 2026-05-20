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
import { bootRecovery } from "./boot.ts";
import { ensureToken } from "./auth/token.ts";
import { checkCcBinAvailable } from "./providers/claude-code/index.ts";

const TOKEN = ensureToken();
const BOOT_TIME = Date.now();
import { reconcileOrphans } from "./chat/orchestrator.ts";
import { scanVaultAgents } from "./agents/scan.ts";
import { makeAgentRepo } from "./agents/repo.ts";
import { scanAgentCards, upsertAgentCards } from "./agents/cards-scan.ts";
import { auditVaultProjectSettings } from "./boot/audit-project-settings.ts";

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

// VOS-134: pre-flight CC wrapper check. Without claudev (or VOID_OS_CC_BIN
// pointing at the wrapper), every chat dispatch fails with a deferred
// "Executable not found in $PATH" error mid-run. Surface it now with an
// actionable message so the user knows exactly what to fix BEFORE the HTTP
// server binds.
{
  const ccCheck = checkCcBinAvailable();
  if (!ccCheck.ok) {
    console.error(ccCheck.reason);
    process.exit(3);
  }
}

// VOS-111: warn if <vaultRoot>/.claude/settings.json exists (still loaded
// by --setting-sources project). Runs once at boot, before any spawn.
auditVaultProjectSettings(vaultRoot);

const dbPath = process.env.VOID_OS_DB ?? path.join(vaultRoot, ".void", "state.sqlite");
const db = openDatabase(dbPath);

// VOS-79 T10: sweep orphan running/pending runs left by a previous crash.
bootRecovery(db);

// VOS-89 T13: reconcile task-tree orphans from a mid-flight daemon crash.
// (a) WAITING_ON_AGENT parent whose child already terminal → parent → WORKING.
// (b) Non-terminal descendant of any CANCELED ancestor → CANCELED (cascade).
// Runs before buildApp/mountMcp so MCP never accepts ask_agent / answer
// against a stale tree.
reconcileOrphans(db);

// VOS-92: scan vault/agents/ and mirror into the `agents` table.
// Runs after migrations (openDatabase) and before buildApp so all routes
// see a populated registry. Stale rows from deleted agents persist until
// next restart — acceptable for v1, documented in spec §4.4.
// Scanner failure must NOT block daemon boot — log and continue.
try {
  const agentRows = scanVaultAgents(vaultRoot);
  makeAgentRepo(db).upsertAll(agentRows);
  console.log(`  agents: ${agentRows.length} from ${vaultRoot}/agents/`);
} catch (e) {
  console.warn(`  agents: scan failed: ${e instanceof Error ? e.message : e} — continuing with existing rows`);
}

// VOS-106 follow-up: seed agent_cards from the same scan. The provider +
// permission engine resolve AgentDefn via defaultLoadAgentDefn which reads
// agent_cards.card_json; nothing else populates it in production.
try {
  const cards = scanAgentCards(vaultRoot);
  upsertAgentCards(db, cards);
  console.log(`  agent_cards: ${cards.length} from ${vaultRoot}/agents/`);
} catch (e) {
  console.warn(`  agent_cards: scan failed: ${e instanceof Error ? e.message : e} — dispatches will fail with 'unknown agent'`);
}

// VOS-90 T1: in fake-provider mode, the provider issues MCP `ask_user`
// calls back to this daemon over loopback. The provider factory reads
// `VOS_DAEMON_BASE` to learn the daemon's own URL. PORT/HOST are known
// here at boot, so we can derive the base URL before buildApp constructs
// the provider. Production (VOS_PROVIDER unset / claude-code) ignores it.
if (process.env.VOS_PROVIDER === "fake" && !process.env.VOS_DAEMON_BASE) {
  process.env.VOS_DAEMON_BASE = `http://127.0.0.1:${PORT}`;
}

// VOS-106 T7: arm the boot deny-probe at the production entrypoint.
// Tests inherit the default (off); only this prod-shaped `bun run` path
// pays the spawn cost. If the probe fails, buildApp throws and the
// daemon never binds the port — by design.
const app = await buildApp({
  db,
  vaultRoot,
  runBootProbe: true,
  token: TOKEN,
  bootTime: BOOT_TIME,
  // Pin daemonBase to the actual listening port. Without this app.ts falls
  // back to process.env.PORT ?? 17777, which silently inherits a shell PORT
  // var (claudev's proxy, dev tools, etc.) and bakes a wrong URL into every
  // spawn's mcp.json — CC then hits ConnectionRefused and marks void-os
  // MCP "failed", which means agents lose vos_ask_user / vault tools.
  daemonBase: `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`,
});

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  // VOS-104: /events is a long-lived WebSocket. Default idleTimeout (10s)
  // drops the socket while the agent is paused on ask_user, so plugin bus
  // listeners miss subsequent chat.task.state_changed frames. 255 = Bun max.
  idleTimeout: 255,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/events") {
      // wsHandler is WebSocketHandler<unknown>, so Bun's upgrade() requires an
      // explicit `data` even though this socket carries none (VOS-167).
      if (srv.upgrade(req, { data: undefined })) return;
      return new Response("expected WebSocket upgrade", { status: 426 });
    }
    return app.fetch(req);
  },
  websocket: wsHandler,
});

console.log(`void-os daemon v${VERSION} listening on http://${server.hostname}:${server.port}`);
console.log(`  vault: ${vaultRoot}`);
console.log(`  db:    ${dbPath}`);
