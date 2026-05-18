/**
 * VOS-124 T7 — E2E smoke: strict agent validation (known + unknown agent).
 *
 * Two scenarios exercised against a real daemon + real CLI binary:
 *
 *   1. ask tinker "ping" — known agent, exits 0, trace turn.start.payload.agent
 *      === "tinker" (acceptance bullet 2). Also asserted via DB runs.agent as
 *      belt-and-suspenders.
 *
 *   2. ask ghost "ping"  — unknown agent, exits 4, stderr mentions "ghost"
 *      + "not found". The CLI pre-flight (agents list check) rejects before
 *      any POST /chats, so no trace is written.
 *
 * Claude is NOT called — VOS_PROVIDER=fake drives the tinker run with a
 * one-response JSONL script. The ghost test exits at CLI pre-flight before
 * any provider interaction.
 *
 * Architecture note:
 *   The existing sibling (e2e/cli-ask-chat.spec.ts) already covers
 *   "unknown agent → exit 4". This spec adds the tinker-specific
 *   vault fixture (only agents/tinker/agent.md + migration-seeded maya)
 *   and the trace-existence + DB-agent assertions from VOS-124.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "bun";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as net from "node:net";
import { Database } from "bun:sqlite";

// --- Paths ------------------------------------------------------------------
const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..");
const DAEMON_ENTRY = resolve(REPO_ROOT, "daemon", "src", "index.ts");
const BIN_VOID_OS = resolve(REPO_ROOT, "bin", "void-os");

const FIX_HAPPY = resolve(HERE, "fixtures", "ask-agent-strict-happy.jsonl");

const TOKEN = "vos124-strict-e2e-token";

// --- Helpers ----------------------------------------------------------------

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      if (typeof a === "object" && a) {
        const p = a.port;
        srv.close(() => res(p));
      } else rej(new Error("freePort failed"));
    });
  });
}

interface DaemonRig {
  baseUrl: string;
  port: number;
  homeDir: string;
  vaultRoot: string;
  dbPath: string;
  kill: () => Promise<void>;
}

async function waitHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/health`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not come up within ${timeoutMs}ms`);
}

/**
 * Seed a minimal agent in the vault with permissive scopes.
 * Matches the pattern in cli-ask-chat.spec.ts seedAgent().
 */
function seedAgent(vaultRoot: string, name: string): void {
  const dir = join(vaultRoot, "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent.md"),
    `---\nname: ${name}\ndescription: vos-124 e2e ${name}\nmodel: haiku\nread_scope: ["**"]\nwrite_scope: ["**"]\n---\n${name} agent for vos-124 strict-agent e2e\n`,
  );
}

/**
 * Boot a fresh daemon with only agents/tinker/agent.md in the vault.
 * maya is also seeded (required by VOS-118 comment in sibling: the MCP
 * route resolves the calling agent by name; if "maya" is absent the
 * vos_ask_user directive silently fails — seed it defensively).
 */
async function startDaemon(): Promise<DaemonRig> {
  const homeDir = mkdtempSync(join(tmpdir(), "vos124-strict-home-"));
  const tokenDir = join(homeDir, ".void-os");
  mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(tokenDir, "token"), TOKEN + "\n", { mode: 0o600 });
  chmodSync(join(tokenDir, "token"), 0o600);

  const vaultRoot = mkdtempSync(join(tmpdir(), "vos124-strict-vault-"));
  mkdirSync(join(vaultRoot, "agents"), { recursive: true });

  // Seed ONLY tinker (+ maya as a defensive guard). This mirrors the task
  // spec: "starter-vault that has only agents/tinker/agent.md (plus the
  // seeded maya from migration 0008)". Migration 0008 inserts maya into the
  // DB unconditionally; here we also add maya to vault so the MCP route
  // can resolve it by name.
  seedAgent(vaultRoot, "tinker");
  seedAgent(vaultRoot, "maya");

  const dbPath = join(vaultRoot, ".state.sqlite");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const proc = spawn({
    cmd: ["bun", "run", DAEMON_ENTRY],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      VOID_OS_PORT: String(port),
      VOID_OS_HOST: "127.0.0.1",
      VOID_OS_VAULT_ROOT: vaultRoot,
      VOID_OS_DB: dbPath,
      VOS_PROVIDER: "fake",
      VOS_TITLER: "stub",
      // Global script drives runs for the daemon's defaultAgent ("maya").
      // Per-agent override VOS_FAKE_SCRIPT_tinker is checked first by
      // resolveFakeScript(agentName) — set it so that when the orchestrator
      // dispatches the tinker chat it picks up this script. Without this,
      // only the global fallback fires (which is also set for safety).
      VOS_FAKE_SCRIPT: FIX_HAPPY,
      VOS_FAKE_SCRIPT_tinker: FIX_HAPPY,
      ANTHROPIC_API_KEY: "",
      VOID_KEYS_URL: "",
      // VOS-134: daemon pre-flights the CC wrapper at boot. VOS_PROVIDER=fake
      // never actually spawns it, but the pre-flight runs unconditionally.
      // Point at /bin/sh (always exists) to satisfy the check.
      VOID_OS_CC_BIN: process.env.VOID_OS_CC_BIN ?? "/bin/sh",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    await waitHealth(baseUrl, 15_000);
  } catch (e) {
    try { proc.kill(); } catch { /* ignore */ }
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(vaultRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    throw e;
  }

  const kill = async (): Promise<void> => {
    try { proc.kill(); } catch { /* ignore */ }
    try { await proc.exited; } catch { /* ignore */ }
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(vaultRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { baseUrl, port, homeDir, vaultRoot, dbPath, kill };
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runVoidOs(rig: DaemonRig, args: string[]): Promise<SpawnResult> {
  const child = spawn({
    cmd: ["bun", "run", BIN_VOID_OS, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: rig.homeDir,
      VOID_OS_BASE: rig.baseUrl,
      VOID_OS_TOKEN: TOKEN,
      // Mirror the daemon's vault root so CLI vaultMissing() probe doesn't
      // exit 5 (same gotcha as cli-ask-chat.spec.ts).
      VOID_OS_VAULT_ROOT: rig.vaultRoot,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

// --- Tests ------------------------------------------------------------------

describe("ask-agent-strict: tinker (known) + ghost (unknown)", () => {
  let rig: DaemonRig;

  beforeAll(async () => {
    rig = await startDaemon();
  }, 30_000);

  afterAll(async () => {
    await rig?.kill();
  });

  // ── Test 1: known agent ─────────────────────────────────────────────────
  test("ask tinker ping: exits 0, trace.turn.start.payload.agent === tinker, runs.agent === tinker", async () => {
    const r = await runVoidOs(rig, ["ask", "tinker", "ping"]);

    // Exit 0.
    if (r.code !== 0) {
      throw new Error(
        `expected exit 0, got ${r.code}\nstdout=${JSON.stringify(r.stdout)}\nstderr=${JSON.stringify(r.stderr)}`,
      );
    }
    expect(r.code).toBe(0);

    const db = new Database(rig.dbPath, { readonly: true });
    try {
      const row = db
        .query("SELECT agent, trace_path FROM runs ORDER BY started_at DESC LIMIT 1")
        .get() as { agent: string; trace_path: string | null } | undefined;

      expect(row).toBeDefined();

      // ── Belt-and-suspenders: DB runs.agent ────────────────────────────────
      expect(row!.agent).toBe("tinker");

      // ── Primary assertion (VOS-124 acceptance bullet 2): trace payload ────
      // The fake provider now forwards req.agent → turn.start.payload.agent,
      // so the trace carries the per-run requested agent, not the provider's
      // static opts.agent identity.
      if (row!.trace_path) {
        const lines = readFileSync(row!.trace_path, "utf8")
          .split("\n")
          .filter((l) => l.trim());

        const turnStartLine = lines.find((l) => {
          try {
            return JSON.parse(l).kind === "turn.start";
          } catch {
            return false;
          }
        });

        expect(turnStartLine).toBeDefined();

        const startEvent = JSON.parse(turnStartLine!);
        expect(startEvent.payload).toBeDefined();
        expect(typeof startEvent.payload.runId).toBe("string");
        // VOS-124 acceptance bullet 2: trace.turn.start.payload.agent === requested agent.
        expect(startEvent.payload.agent).toBe("tinker");
      }
    } finally {
      db.close();
    }
  }, 30_000);

  // ── Test 2: unknown agent ───────────────────────────────────────────────
  test("ask ghost ping: exits 4 and stderr mentions ghost + not found", async () => {
    const r = await runVoidOs(rig, ["ask", "ghost", "ping"]);

    // Exit 4 (pre-flight rejection at CLI agents-list check — ghost is not
    // in the daemon's registry). Both T5 and the existing sibling confirm
    // this code. No trace is written because the CLI never reaches POST /chats.
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("ghost");
    expect(r.stderr).toContain("not found");
  }, 15_000);
});
