/**
 * VOS-118 T8 — End-to-end test for `void-os ask` + `void-os chat` against
 * a real daemon driven by the fake provider.
 *
 * Architecture note (why one daemon per scenario):
 *   `daemon/src/app.ts:227` hard-binds the orchestrator's provider to
 *   `defaultAgent ?? "maya"`. The fake-provider factory then resolves the
 *   script via `resolveFakeScript(deps.agent)` — i.e. ONE script per
 *   daemon process. `VOS_FAKE_SCRIPT_<otherAgent>` is silently ignored
 *   for top-level chats. So per-scenario isolation requires per-scenario
 *   daemon processes, each with `VOS_FAKE_SCRIPT` pinned to that
 *   scenario's fixture. (Per-agent envs would only matter for ask_agent
 *   *child* dispatches — irrelevant to ask/chat top-level runs.)
 *
 * Each scenario describe block boots its own daemon + isolated HOME +
 * vault root in beforeAll, tears down in afterAll. Tests inside a
 * describe block share the daemon (same fixture, same agent name).
 *
 * Acceptance coverage (VOS-118 task ## Acceptance):
 *   - `ask` happy: prints response, exit 0
 *   - `ask --stream`: emits tool one-liners + text frames
 *   - `ask --verbose`: raw JSON to stderr, text on stdout
 *   - `ask` with ask_user → exit 6 + hint
 *   - `ask` unknown agent → exit 4
 *   - `ask`: stdout unstyled when piped (no ANSI)
 *   - `chat` REPL: send + receive + EOF exits 0
 *   - `chat` with ask_user mid-stream: prompts stdin, posts /answer, resumes
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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

const TOKEN = "cli-e2e-token-deadbeef";

// --- Helpers ---------------------------------------------------------------

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
  agent: string;
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

function seedAgent(vaultRoot: string, name: string): void {
  const dir = join(vaultRoot, "agents", name);
  mkdirSync(dir, { recursive: true });
  // Permissive scopes so vault.read (tool scenario) isn't gated out.
  writeFileSync(
    join(dir, "agent.md"),
    `---\nname: ${name}\ndescription: cli e2e ${name}\nmodel: haiku\nread_scope: ["**"]\nwrite_scope: ["**"]\n---\nstub agent for cli e2e\n`,
  );
}

/**
 * Boot a fresh daemon process with an isolated HOME + vault, scripted by
 * exactly one fake-provider script. The daemon's orchestrator binds to
 * `agent` at boot, so that name is the only one valid for ask/chat
 * top-level runs against this daemon.
 */
async function startDaemon(opts: {
  fakeScript: string;
  agent: string;
}): Promise<DaemonRig> {
  const homeDir = mkdtempSync(join(tmpdir(), "vos-cli-e2e-home-"));
  const tokenDir = join(homeDir, ".void-os");
  mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(tokenDir, "token"), TOKEN + "\n", { mode: 0o600 });
  chmodSync(join(tokenDir, "token"), 0o600);

  const vaultRoot = mkdtempSync(join(tmpdir(), "vos-cli-e2e-vault-"));
  mkdirSync(join(vaultRoot, "agents"), { recursive: true });
  seedAgent(vaultRoot, opts.agent);

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
      VOID_OS_DB: join(vaultRoot, ".state.sqlite"),
      VOS_PROVIDER: "fake",
      VOS_TITLER: "stub",
      // One script per daemon — app.ts pins defaultAgent to "maya" but the
      // factory's `resolveFakeScript(deps.agent)` falls back to the global
      // `VOS_FAKE_SCRIPT`, so this env is what actually drives the run.
      VOS_FAKE_SCRIPT: opts.fakeScript,
      ANTHROPIC_API_KEY: "",
      VOID_KEYS_URL: "",
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

  return { baseUrl, port, homeDir, vaultRoot, agent: opts.agent, kill };
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runVoidOs(
  rig: DaemonRig,
  args: string[],
  opts: { stdinLines?: string[]; closeStdinAfterMs?: number } = {},
): Promise<SpawnResult> {
  const child = spawn({
    cmd: ["bun", "run", BIN_VOID_OS, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: rig.homeDir,
      VOID_OS_BASE: rig.baseUrl,
      VOID_OS_TOKEN: TOKEN,
      // CLI's vaultMissing() probe (cli/ask.ts) falls back to
      // ~/Library/.../vault under the isolated HOME — that doesn't exist,
      // so ask would exit 5 (vault not configured) before reaching the
      // daemon. Mirror the daemon's vault root explicitly. Same gotcha
      // captured in commit 1f45442.
      VOID_OS_VAULT_ROOT: rig.vaultRoot,
    },
    stdin: opts.stdinLines ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (opts.stdinLines) {
    const sink = child.stdin as {
      write(chunk: string | Uint8Array): number;
      flush(): void | Promise<void>;
      end(): void | Promise<void>;
    };
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
  return /\[[0-9;]*m/.test(s);
}

function expectOk(r: SpawnResult, expectedCode = 0): void {
  if (r.code !== expectedCode) {
    throw new Error(
      `expected code ${expectedCode}, got ${r.code}\nstdout=${JSON.stringify(r.stdout)}\nstderr=${JSON.stringify(r.stderr)}`,
    );
  }
}

// --- Scenarios -------------------------------------------------------------

describe("ask: happy + verbose (FIX_HAPPY)", () => {
  let rig: DaemonRig;
  beforeAll(async () => {
    rig = await startDaemon({ fakeScript: FIX_HAPPY, agent: "stub" });
  }, 30_000);
  afterAll(async () => {
    await rig?.kill();
  });

  test("ask: happy path prints response and exits 0", async () => {
    const r = await runVoidOs(rig, ["ask", "stub", "ping"]);
    expectOk(r, 0);
    expect(r.stdout).toContain("pong");
  }, 30_000);

  test("ask --verbose: mirrors raw frame JSON to stderr; readable text still on stdout", async () => {
    const r = await runVoidOs(rig, ["ask", "stub", "ping", "--verbose"]);
    expectOk(r, 0);
    expect(r.stdout).toContain("pong");
    expect(r.stderr).toContain(`"event":"text"`);
    expect(r.stderr).toContain(`"event":"run_end"`);
  }, 30_000);

  test("ask: unknown agent returns exit 4 with actionable hint", async () => {
    const r = await runVoidOs(rig, ["ask", "nope_agent", "hi"]);
    expectOk(r, 4);
    expect(r.stderr).toContain("agent 'nope_agent' not found");
  }, 15_000);

  test("chat: REPL sends message, prints response, EOF exits 0", async () => {
    const r = await runVoidOs(rig, ["chat", "stub"], {
      stdinLines: ["hello"],
      closeStdinAfterMs: 1500,
    });
    expectOk(r, 0);
    expect(r.stdout).toContain("pong");
  }, 30_000);
});

describe("ask: tool render + ANSI piping (FIX_TOOL)", () => {
  let rig: DaemonRig;
  beforeAll(async () => {
    rig = await startDaemon({ fakeScript: FIX_TOOL, agent: "stub" });
  }, 30_000);
  afterAll(async () => {
    await rig?.kill();
  });

  test("ask: output is unstyled when stdout is piped (no ANSI)", async () => {
    const r = await runVoidOs(rig, ["ask", "stub", "go"]);
    expectOk(r, 0);
    expect(containsAnsi(r.stdout)).toBe(false);
    expect(r.stdout).toContain("· vault.read");
    expect(r.stdout).toContain("done");
  }, 30_000);

  test("ask --stream: emits tool one-liners + text frames", async () => {
    const r = await runVoidOs(rig, ["ask", "stub", "go", "--stream"]);
    expectOk(r, 0);
    expect(r.stdout).toContain("reading ");
    expect(r.stdout).toContain("· vault.read");
    expect(r.stdout).toContain("done");
    expect(containsAnsi(r.stdout)).toBe(false);
  }, 30_000);
});

describe("ask + chat: ask_user gating (FIX_ASK_USER)", () => {
  let rig: DaemonRig;
  beforeAll(async () => {
    rig = await startDaemon({ fakeScript: FIX_ASK_USER, agent: "stub" });
  }, 30_000);
  afterAll(async () => {
    await rig?.kill();
  });

  test("ask: ask_user mid-run fails fast with exit 6 and 'void-os chat' hint", async () => {
    const r = await runVoidOs(rig, ["ask", "stub", "hi"]);
    expectOk(r, 6);
    expect(r.stderr).toContain("void-os chat stub");
  }, 30_000);

  test("chat: ask_user mid-stream prompts stdin, posts /answer, resumes", async () => {
    const r = await runVoidOs(rig, ["chat", "stub"], {
      stdinLines: ["hi", "eva"],
      closeStdinAfterMs: 4000,
    });
    expectOk(r, 0);
    expect(r.stdout).toContain("thinking");
    expect(r.stdout).toContain("agent asks: your name?");
    expect(r.stdout).toContain("nice to meet you eva");
  }, 45_000);
});
