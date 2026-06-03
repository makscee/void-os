// launch-interactive.test.ts — VOS-206 T3: /launch defaults conversational skills to interactive
import { expect, test, beforeAll, afterAll, mock } from "bun:test";
import { mkdirSync, rmSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../src/registry.ts";
import { randomUUID } from "node:crypto";

const vault = mkdtempSync(join(tmpdir(), "vos206-launch-interactive-"));
const db = openRegistry(":memory:");

// NOTE: We intentionally do NOT mock catalog.ts here — the server uses the repo's real
// catalog (hardcoded path). Mocking catalog.ts here would contaminate catalog.test.ts
// when both run in the same `bun test` invocation (Bun module mocks are session-scoped).
// Instead, tests use skills that exist in the real catalog with known interactive flags:
//   chat → interactive: true (set in T5)
//   ralph → interactive: false (set in T5)
// and "nonexistent-skill" → decideInteractive returns false (print, conservative default).

type SpawnRunCall = {
  skill: string | null;
  agent: string | null;
  interactive?: boolean;
  forcePrint?: boolean | null;
  outputTarget?: string | null;
  [key: string]: unknown;
};
const spawnRunCalls: SpawnRunCall[] = [];

mock.module("../src/spawn.ts", () => ({
  buildLaunchArgv: (uuid: string, skill: string, text: string) => ["--session-id", uuid, "-p", text ? `/${skill} ${text}` : `/${skill}`, "--permission-mode", "bypassPermissions"],
  buildAnswerArgv: (uuid: string, text: string, ccSessionId?: string | null) => ["--resume", ccSessionId ?? uuid, "-p", text, "--permission-mode", "bypassPermissions"],
  readCcSessionId: (_vault: string, _execId: string) => null,
  tokenizeCommand: (cmd: string) => cmd.trim().split(/\s+/).filter(Boolean),
  spawnTurn: () => {},
  runTurn: async () => 0,
  spawnRun: (opts: SpawnRunCall) => {
    const runId = `exec-${randomUUID()}`;
    spawnRunCalls.push(opts);
    // Write a minimal start event so readStartEvent still works if this mock bleeds
    // into other test files (e.g. triggers-fire.test.ts via spawn-adapter.ts).
    try {
      const { mkdirSync: _mkdir, appendFileSync: _append } = require("node:fs");
      const { join: _join } = require("node:path");
      const vaultOpts = opts as unknown as { vault?: string; outputTarget?: string | null };
      if (vaultOpts.vault) {
        const evDir = _join(vaultOpts.vault, ".void-os", "events");
        _mkdir(evDir, { recursive: true });
        const ev = JSON.stringify({ type: "start", agent: null, skill: opts.skill ?? null,
          input_ref: null, tmux_session: `vos-run-${runId}`, at: Date.now(),
          trigger_id: null, step_ceiling: null, output_target: vaultOpts.outputTarget ?? null });
        _append(_join(evDir, `${runId}.jsonl`), ev + "\n");
      }
    } catch { /* non-fatal stub impl */ }
    return { runId, tmuxSession: `vos-run-${runId}` };
  },
  // re-export functions that other test files import so mocks don't bleed and break them
  buildInteractiveArgv: (ccSeed: string, vault: string, o: { addDirs?: string[]; mcpConfigPath?: string | null; settingsPath?: string | null }) => {
    const argv = ["--session-id", ccSeed, "--add-dir", vault, "--permission-mode", "bypassPermissions"];
    if (o.settingsPath) argv.push("--settings", o.settingsPath);
    for (const d of o.addDirs ?? []) argv.push("--add-dir", d);
    return argv;
  },
  buildWrapperCommand: (wrapperPath: string, daemonUrl: string, runId: string, mode: string, ccCommand: string) =>
    `"${wrapperPath}" "${daemonUrl}" "${runId}" "${mode}" ${ccCommand}`,
  buildSpawnArgv: () => [],
  hookRelayScriptPath: "/mock/hook-relay.sh",
  runWrapperScriptPath: "/mock/run-wrapper.sh",
}));

mock.module("../src/drain.ts", () => ({
  drain: async () => ({ status: "complete", iterations: 0 }),
}));

mock.module("../src/preflight.ts", () => ({
  realDeps: { vcStatus: async () => ({ ok: true, msg: "authed" }) },
  // re-export checkPrereqs so preflight.test.ts still works when mocks bleed across files
  checkPrereqs: async (deps: { which: (b: string) => Promise<boolean>; vcStatus: () => Promise<{ ok: boolean; text: string }> }) => {
    const problems: string[] = [];
    let needsLogin = false;
    const [hasVc, hasClaude] = await Promise.all([deps.which("vc"), deps.which("claude")]);
    if (!hasVc) problems.push("vc not found — install via: curl -fsSL https://auth.makscee.ru/cv/install.sh | sh");
    if (!hasClaude) problems.push("claude not found — install Claude Code CLI");
    if (hasVc) {
      const status = await deps.vcStatus();
      if (!status.ok) { needsLogin = true; problems.push("vc not logged in — run: vc login"); }
    }
    return { ok: problems.length === 0, needsLogin, problems };
  },
  productionDeps: () => ({ which: async () => true, vcStatus: async () => ({ ok: true, text: "ok" }) }),
  checkPreflight: async () => ({ ok: true, needsLogin: false, problems: [] }),
}));

mock.module("../src/agents.ts", () => ({
  buildAgentLaunch: (v: string, name: string) => {
    throw new Error(`agent not found: ${name}`);
  },
  listAgents: () => [],
  parseAgentFile: () => ({ name: "", description: "", folders: [], mcps: [], skills: [], body: "" }),
  agentPath: (v: string, name: string) => join(v, "agents", `${name}.md`),
}));

mock.module("../src/tmux.ts", () => ({
  hasSession: () => false,
  switchClient: () => ({ code: 0, stderr: "" }),
  sendKeys: () => {},
  killSession: () => {},
  newRunSession: () => 0,
  listVosSessions: () => [],
  attachCommand: (name: string) => `tmux -L vos attach -t ${name}`,
  capturePaneContent: () => "",
  waitForPrompt: async () => true,
}));

mock.module("../src/resume.ts", () => ({
  respawnSession: (_db: unknown, _vault: string, execId: string) => `vos-run-${execId}`,
  buildResumeArgv: (ccId: string, vault: string, o?: { addDirs?: string[] }) => {
    const argv = ["--resume", ccId, "--add-dir", vault, "--permission-mode", "bypassPermissions"];
    for (const d of o?.addDirs ?? []) argv.push("--add-dir", d);
    return argv;
  },
  // re-export ensureRawRunner so resume.test.ts still works when mocks bleed across files
  ensureRawRunner: (cmd: string) => {
    const toks = cmd.trim().split(/\s+/).filter(Boolean);
    const sepIdx = toks.indexOf("--");
    if (sepIdx !== -1 && !toks.includes("--raw")) toks.splice(sepIdx, 0, "--raw");
    return toks;
  },
}));

const { makeApp } = await import("../src/server.ts");

beforeAll(() => {
  rmSync(vault, { recursive: true, force: true });
  mkdirSync(`${vault}/sessions`, { recursive: true });
  spawnRunCalls.length = 0;
});

test("launch chat spawns interactive + persists interactive:true in meta", async () => {
  const app = makeApp(vault, db);
  spawnRunCalls.length = 0;
  const form = new FormData();
  form.append("skill", "chat");
  const res = await app.request("/launch", { method: "POST", body: form });
  expect(res.status).toBe(302);
  expect(spawnRunCalls.length).toBe(1);
  const call = spawnRunCalls[0];
  expect(call.interactive).toBe(true);
  // forcePrint must be false (or not set) for interactive sessions
  expect(call.forcePrint == null || call.forcePrint === false).toBe(true);
  // session-meta.json should persist interactive:true
  const location = res.headers.get("location") ?? "";
  const runId = location.replace("/s/", "");
  const metaPath = join(vault, "sessions", runId, "session-meta.json");
  expect(existsSync(metaPath)).toBe(true);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  expect(meta.interactive).toBe(true);
});

test("launch ralph (interactive:false in catalog) spawns print one-shot + persists interactive:false in meta", async () => {
  const app = makeApp(vault, db);
  spawnRunCalls.length = 0;
  const form = new FormData();
  form.append("skill", "ralph");
  const res = await app.request("/launch", { method: "POST", body: form });
  expect(res.status).toBe(302);
  expect(spawnRunCalls.length).toBe(1);
  const call = spawnRunCalls[0];
  expect(call.interactive).toBeFalsy();
  // forcePrint must be true for print sessions
  expect(call.forcePrint).toBe(true);
  // session-meta.json should persist interactive:false
  const location = res.headers.get("location") ?? "";
  const runId = location.replace("/s/", "");
  const metaPath = join(vault, "sessions", runId, "session-meta.json");
  expect(existsSync(metaPath)).toBe(true);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  expect(meta.interactive).toBe(false);
});

// Restore all mock.module registrations so sibling test files (e.g. triggers-fire.test.ts
// using spawn-adapter.ts → spawnRun) that run after this file get the real implementations.
afterAll(() => {
  mock.restore();
});
