/**
 * VOS-118 T8 — End-to-end test for `void-os ask` + `void-os chat` against
 * a real daemon driven by the fake provider.
 *
 * Self-contained: spawns the daemon as a subprocess (NOT using the Playwright
 * globalSetup — that one boots Obsidian + plugin which is irrelevant here).
 * Each scenario is bound to a dedicated agent so we can pin a distinct
 * fake-provider script per agent via `VOS_FAKE_SCRIPT_<agent>` env vars.
 * That way scripts never race even though tests share one daemon.
 *
 * Acceptance coverage (VOS-118 task ## Acceptance):
 *   - `ask` happy: prints response, exit 0
 *   - `ask --stream`: emits tool one-liners + text frames
 *   - `ask` with ask_user → exit 6 + hint
 *   - `chat` REPL: send + receive + EOF exits 0
 *   - `chat` with ask_user mid-stream: prompts stdin, posts /answer, resumes
 *   - Tool calls render readably (no --verbose) and verbose mirrors raw JSON
 *   - Output is unstyled when piped (no ANSI escapes)
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as net from "node:net";

// --- Paths -----------------------------------------------------------------
const HERE = resolve(fileURLToPath(import.meta.url), "..");
const REPO_ROOT = resolve(HERE, "..");
const DAEMON_ENTRY = resolve(REPO_ROOT, "daemon", "src", "index.ts");
const BIN_VOID_OS = resolve(REPO_ROOT, "bin", "void-os");

const FIX_HAPPY = resolve(HERE, "fixtures", "cli-ask-chat-happy.jsonl");
const FIX_TOOL = resolve(HERE, "fixtures", "cli-ask-chat-tool.jsonl");
const FIX_ASK_USER = resolve(HERE, "fixtures", "cli-ask-chat-ask-user.jsonl");

// --- Test rig --------------------------------------------------------------
const TOKEN = "cli-e2e-token-deadbeef";
let port: number;
let baseUrl: string;
let daemon: Subprocess | null = null;
let homeDir: string;
let vaultRoot: string;

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

async function waitHealth(timeoutMs: number): Promise<void> {
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
  throw new Error(`daemon did not come up on :${port} within ${timeoutMs}ms`);
}

function seedAgent(name: string): void {
  const dir = join(vaultRoot, "agents", name);
  mkdirSync(dir, { recursive: true });
  // Frontmatter feeds the agent_cards scan; permissive scopes so vault.read
  // (used by the tool-render scenario) doesn't get gated out.
  writeFileSync(
    join(dir, "agent.md"),
    `---\nname: ${name}\ndescription: cli e2e ${name}\nmodel: haiku\nread_scope: ["**"]\nwrite_scope: ["**"]\n---\nstub agent for cli e2e\n`,
  );
}

beforeAll(async () => {
  // Isolated HOME so the daemon's `ensureToken()` doesn't touch the real
  // ~/.void-os and so the CLI's `resolveToken()` (which we'll override via
  // env anyway) doesn't either.
  homeDir = mkdtempSync(join(tmpdir(), "vos-cli-e2e-home-"));
  const tokenDir = join(homeDir, ".void-os");
  mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(tokenDir, "token"), TOKEN + "\n", { mode: 0o600 });
  chmodSync(join(tokenDir, "token"), 0o600);

  // Isolated vault root with one agent per scenario.
  vaultRoot = mkdtempSync(join(tmpdir(), "vos-cli-e2e-vault-"));
  mkdirSync(join(vaultRoot, "agents"), { recursive: true });
  seedAgent("stub_happy");
  seedAgent("stub_tool");
  seedAgent("stub_ask");

  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  daemon = spawn({
    cmd: ["bun", "run", DAEMON_ENTRY],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      VOID_OS_PORT: String(port),
      VOID_OS_HOST: "127.0.0.1",
      VOID_OS_VAULT_ROOT: vaultRoot,
      VOID_OS_DB: join(vaultRoot, ".state.sqlite"),
      VOS_PROVIDER: "fake",
      VOS_TITLER: "stub",
      // Per-agent fake scripts: each scenario uses its own agent so scripts
      // never race. Global fallback unused.
      VOS_FAKE_SCRIPT: FIX_HAPPY,
      VOS_FAKE_SCRIPT_stub_happy: FIX_HAPPY,
      VOS_FAKE_SCRIPT_stub_tool: FIX_TOOL,
      VOS_FAKE_SCRIPT_stub_ask: FIX_ASK_USER,
      // Note: env var names with dashes are non-portable; daemon's
      // resolveFakeScript uses `VOS_FAKE_SCRIPT_<agentName>` literally, so
      // we must avoid dashes in agent names. We use underscores above
      // (stub_happy not stub-happy).
      ANTHROPIC_API_KEY: "",
      VOID_KEYS_URL: "",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  await waitHealth(15_000);
}, 30_000);

afterAll(async () => {
  if (daemon) {
    try {
      daemon.kill();
      await daemon.exited;
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(homeDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    rmSync(vaultRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// --- Helpers ---------------------------------------------------------------

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runVoidOs(
  args: string[],
  opts: { stdinLines?: string[]; closeStdinAfterMs?: number } = {},
): Promise<SpawnResult> {
  const child = spawn({
    cmd: ["bun", "run", BIN_VOID_OS, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: homeDir,
      VOID_OS_BASE: baseUrl,
      VOID_OS_TOKEN: TOKEN,
      // CLI's vaultMissing() probe (cli/ask.ts:49-54) checks
      // VOID_OS_VAULT_ROOT and otherwise falls back to ~/Library/.../vault.
      // With an isolated HOME the fallback never exists → exit 5 before the
      // request ever reaches the daemon. Mirror the daemon's vault root.
      VOID_OS_VAULT_ROOT: vaultRoot,
    },
    stdin: opts.stdinLines ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (opts.stdinLines) {
    // Bun.spawn's `stdin` is a FileSink when stdin: "pipe".
    const sink = child.stdin as { write(chunk: string | Uint8Array): number; flush(): void | Promise<void>; end(): void | Promise<void> };
    for (const line of opts.stdinLines) {
      sink.write(line + "\n");
    }
    await sink.flush();
    if (opts.closeStdinAfterMs) {
      await new Promise((r) => setTimeout(r, opts.closeStdinAfterMs));
    }
    try {
      await sink.end();
    } catch {
      /* ignore */
    }
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function containsAnsi(s: string): boolean {
  // SGR escape: ESC '[' ... 'm'
  return /\[[0-9;]*m/.test(s);
}

// --- Tests -----------------------------------------------------------------

function expectOk(r: SpawnResult, expectedCode = 0): void {
  if (r.code !== expectedCode) {
    throw new Error(
      `expected code ${expectedCode}, got ${r.code}\nstdout=${JSON.stringify(r.stdout)}\nstderr=${JSON.stringify(r.stderr)}`,
    );
  }
}

test("ask: happy path prints response and exits 0", async () => {
  const r = await runVoidOs(["ask", "stub_happy", "ping"]);
  expectOk(r, 0);
  expect(r.stdout).toContain("pong");
}, 30_000);

test("ask: output is unstyled when stdout is piped (no ANSI)", async () => {
  const r = await runVoidOs(["ask", "stub_tool", "go"]);
  expectOk(r, 0);
  expect(containsAnsi(r.stdout)).toBe(false);
  // Tool one-liner uses no-ANSI marker glyph (· …) when piped.
  expect(r.stdout).toContain("· vault.read");
  // No --stream → text is buffered until run_end; "done" still flushes.
  expect(r.stdout).toContain("done");
}, 30_000);

test("ask --stream: emits tool one-liners + text frames", async () => {
  const r = await runVoidOs(["ask", "stub_tool", "go", "--stream"]);
  expectOk(r, 0);
  // Stream mode writes text as received: "reading " is the pre-tool chunk.
  expect(r.stdout).toContain("reading ");
  expect(r.stdout).toContain("· vault.read");
  expect(r.stdout).toContain("done");
  // No ANSI when piped.
  expect(containsAnsi(r.stdout)).toBe(false);
}, 30_000);

test("ask --verbose: mirrors raw frame JSON to stderr; readable text still on stdout", async () => {
  const r = await runVoidOs(["ask", "stub_happy", "ping", "--verbose"]);
  expectOk(r, 0);
  expect(r.stdout).toContain("pong");
  // Renderer logs raw frames as JSON to stderr.
  expect(r.stderr).toContain(`"event":"text"`);
  expect(r.stderr).toContain(`"event":"run_end"`);
}, 30_000);

test("ask: ask_user mid-run fails fast with exit 6 and 'void-os chat' hint", async () => {
  const r = await runVoidOs(["ask", "stub_ask", "hi"]);
  expectOk(r, 6);
  expect(r.stderr).toContain("void-os chat stub_ask");
}, 30_000);

test("ask: unknown agent returns exit 4 with actionable hint", async () => {
  const r = await runVoidOs(["ask", "nope_agent", "hi"]);
  expectOk(r, 4);
  expect(r.stderr).toContain("agent 'nope_agent' not found");
}, 15_000);

test("chat: REPL sends message, prints response, EOF exits 0", async () => {
  const r = await runVoidOs(["chat", "stub_happy"], {
    stdinLines: ["hello"],
    closeStdinAfterMs: 1500,
  });
  expectOk(r, 0);
  expect(r.stdout).toContain("pong");
}, 30_000);

test("chat: ask_user mid-stream prompts stdin, posts /answer, resumes", async () => {
  const r = await runVoidOs(["chat", "stub_ask"], {
    stdinLines: ["hi", "eva"],
    closeStdinAfterMs: 2500,
  });
  expectOk(r, 0);
  // pre-ask text rendered
  expect(r.stdout).toContain("thinking");
  // ask_user prompt surfaced to stdout (chat.ts writes `agent asks: …`)
  expect(r.stdout).toContain("agent asks: your name?");
  // post-answer text contains the substituted answer
  expect(r.stdout).toContain("nice to meet you eva");
}, 45_000);
