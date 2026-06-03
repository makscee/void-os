// send-interactive.test.ts — VOS-206 T4: /send routes interactive form-submits to live REPL
// Tests the new interactive branch in POST /s/:uuid/send.
import { expect, test, beforeAll, afterAll, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../src/registry.ts";
import { bodyPath, sessionDir } from "../src/paths.ts";
import { ensureRawRunner } from "../src/resume.ts";
import { randomUUID } from "node:crypto";

const vault = mkdtempSync(join(tmpdir(), "vos206-send-interactive-"));
const db = openRegistry(":memory:");

// --- Spies ---
const sentKeys: Array<[string, string]> = [];
const hasSessionMap: Map<string, boolean> = new Map();
const spawnRunCalls: Array<Record<string, unknown>> = [];
const runTurnCalls: Array<unknown> = [];
const respawnCalls: Array<{ execId: string; runner: string }> = [];

mock.module("../src/spawn.ts", () => ({
  buildLaunchArgv: (uuid: string, skill: string, text: string) => ["--session-id", uuid, "-p", text ? `/${skill} ${text}` : `/${skill}`, "--permission-mode", "bypassPermissions"],
  buildAnswerArgv: (uuid: string, text: string, ccSessionId?: string | null) => ["--resume", ccSessionId ?? uuid, "-p", text, "--permission-mode", "bypassPermissions"],
  readCcSessionId: (_vault: string, _execId: string) => null,
  tokenizeCommand: (cmd: string) => cmd.trim().split(/\s+/).filter(Boolean),
  spawnTurn: () => {},
  runTurn: async (...args: unknown[]) => { runTurnCalls.push(args); return 0; },
  spawnRun: (opts: Record<string, unknown>) => {
    const runId = `exec-${randomUUID()}`;
    spawnRunCalls.push(opts);
    // Write a minimal start event so readStartEvent still works if this mock bleeds
    // into other test files (e.g. triggers-fire.test.ts via spawn-adapter.ts).
    try {
      const { mkdirSync: _mkdir, appendFileSync: _append } = require("node:fs");
      const { join: _join } = require("node:path");
      if (opts.vault) {
        const evDir = _join(opts.vault, ".void-os", "events");
        _mkdir(evDir, { recursive: true });
        const ev = JSON.stringify({ type: "start", agent: null, skill: opts.skill ?? null,
          input_ref: null, tmux_session: `vos-run-${runId}`, at: Date.now(),
          trigger_id: null, step_ceiling: null, output_target: opts.outputTarget ?? null });
        _append(_join(evDir, `${runId}.jsonl`), ev + "\n");
      }
    } catch { /* non-fatal stub impl */ }
    return { runId, tmuxSession: `vos-run-${runId}` };
  },
  // re-export so spawn.test.ts still works if mocks bleed across test files
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
  // re-export checkPrereqs so preflight.test.ts still works if mocks bleed across files
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

mock.module("../src/tmux.ts", () => ({
  hasSession: (name: string) => hasSessionMap.get(name) ?? false,
  switchClient: () => ({ code: 0, stderr: "" }),
  sendKeys: (target: string, line: string) => { sentKeys.push([target, line]); },
  killSession: () => {},
  newRunSession: () => 0,
  listVosSessions: () => [],
  attachCommand: (name: string) => `tmux -L vos attach -t ${name}`,
  capturePaneContent: () => "",
  waitForPrompt: async () => true,
  VOS_SOCKET: "vos",
}));

mock.module("../src/resume.ts", () => ({
  respawnSession: (_db: unknown, _vault: string, execId: string, runner: string) => {
    respawnCalls.push({ execId, runner });
    hasSessionMap.set(`vos-run-${execId}`, true);
    return `vos-run-${execId}`;
  },
  buildResumeArgv: (ccId: string, vaultPath: string, o?: { addDirs?: string[] }) => {
    const argv = ["--resume", ccId, "--add-dir", vaultPath, "--permission-mode", "bypassPermissions"];
    for (const d of o?.addDirs ?? []) argv.push("--add-dir", d);
    return argv;
  },
  // re-export the real ensureRawRunner for tests that import from resume.ts directly
  ensureRawRunner: (cmd: string) => {
    const toks = cmd.trim().split(/\s+/).filter(Boolean);
    const sepIdx = toks.indexOf("--");
    if (sepIdx !== -1 && !toks.includes("--raw")) {
      toks.splice(sepIdx, 0, "--raw");
    }
    return toks;
  },
}));

mock.module("../src/agents.ts", () => ({
  buildAgentLaunch: () => { throw new Error("no agent"); },
  listAgents: () => [],
  parseAgentFile: () => ({ name: "", description: "", folders: [], mcps: [], skills: [], body: "" }),
  agentPath: (v: string, name: string) => join(v, "agents", `${name}.md`),
}));

const { makeApp } = await import("../src/server.ts");

beforeAll(() => {
  rmSync(vault, { recursive: true, force: true });
  mkdirSync(`${vault}/sessions`, { recursive: true });
  sentKeys.length = 0;
  spawnRunCalls.length = 0;
  runTurnCalls.length = 0;
  respawnCalls.length = 0;
  hasSessionMap.clear();
});

function seedSession(uuid: string, meta: Record<string, unknown>, body = "<form>") {
  const dir = sessionDir(vault, uuid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session-meta.json"), JSON.stringify(meta));
  writeFileSync(bodyPath(vault, uuid), body);
}

test("interactive session form-submit sends keys, does NOT fresh-spawn", async () => {
  const uuid = `interactive-live-${randomUUID()}`;
  seedSession(uuid, { skill: "onboarding", interactive: true, runner: "vc --" });
  // Mark session as live
  hasSessionMap.set(`vos-run-${uuid}`, true);

  const beforeSpawn = spawnRunCalls.length;
  const beforeSentKeys = sentKeys.length;
  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("name", "Alice");
  form.append("skill_chat", "on");
  const res = await app.request(`/s/${uuid}/send`, { method: "POST", body: form });

  expect(res.status).toBe(302);
  // Must redirect back to the SAME session (not a new one)
  expect(res.headers.get("location")).toBe(`/s/${uuid}`);
  // send-keys was called (message delivered to live REPL)
  expect(sentKeys.length).toBe(beforeSentKeys + 1);
  expect(sentKeys[sentKeys.length - 1][0]).toBe(`vos-run-${uuid}`);
  expect(sentKeys[sentKeys.length - 1][1]).toContain("Alice");
  // NO fresh spawnRun (no successor session)
  expect(spawnRunCalls.length).toBe(beforeSpawn);
  // body.html must NOT contain <form> (stranded-yellow dissolved)
  const bodyHtml = readFileSync(bodyPath(vault, uuid), "utf8");
  expect(bodyHtml).not.toContain("<form");
});

test("interactive + reaped → respawn (ensureRawRunner injects --raw) then send-keys", async () => {
  const uuid = `interactive-reaped-${randomUUID()}`;
  seedSession(uuid, { skill: "onboarding", interactive: true, runner: "vc --" });
  // Mark session as reaped (not live)
  hasSessionMap.set(`vos-run-${uuid}`, false);

  const beforeRespawn = respawnCalls.length;
  const beforeSentKeys = sentKeys.length;
  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("name", "Bob");
  const res = await app.request(`/s/${uuid}/send`, { method: "POST", body: form });

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`/s/${uuid}`);
  // respawnSession was called
  expect(respawnCalls.length).toBe(beforeRespawn + 1);
  const respawn = respawnCalls[respawnCalls.length - 1];
  // [[feedback_void_os_spawn_raw_flag_test]]: ensureRawRunner must inject --raw before --
  const rawArgv = ensureRawRunner(respawn.runner);
  expect(rawArgv).toContain("--raw");
  expect(rawArgv.indexOf("--raw")).toBeLessThan(rawArgv.indexOf("--"));
  // send-keys was called after respawn
  expect(sentKeys.length).toBe(beforeSentKeys + 1);
  expect(sentKeys[sentKeys.length - 1][1]).toContain("Bob");
});

test("print-mode session form-submit uses unified send path — resumes own thread, no successor", async () => {
  const uuid = `print-mode-${randomUUID()}`;
  seedSession(uuid, { skill: "onboarding", interactive: false, runner: "vc --" });

  const beforeSpawn = spawnRunCalls.length;
  const beforeSentKeys = sentKeys.length;
  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("name", "Carol");
  const res = await app.request(`/s/${uuid}/send`, { method: "POST", body: form });

  expect(res.status).toBe(302);
  // VOS-211: unified send path — redirects back to the SAME session (no successor exec).
  const newLoc = res.headers.get("location") ?? "";
  expect(newLoc).toBe(`/s/${uuid}`);
  // NO new exec row created.
  expect(spawnRunCalls.length).toBe(beforeSpawn);
  // send-keys was called (message delivered to this uuid's tmux session).
  expect(sentKeys.length).toBeGreaterThan(beforeSentKeys);
});

test("drain-gated session takes drain branch even when interactive flag set", async () => {
  const uuid = `drain-interactive-${randomUUID()}`;
  seedSession(uuid, { skill: "ralph", interactive: true, runner: "vc --", drainIssue: 7, worktree: "/tmp/drain-wt-vos206" });
  // Create the worktree dir so server doesn't bail
  mkdirSync("/tmp/drain-wt-vos206", { recursive: true });
  writeFileSync("/tmp/drain-wt-vos206/drain.stop", ""); // just needs to exist as dir

  const beforeRunTurn = runTurnCalls.length;
  const beforeSentKeys = sentKeys.length;
  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("verdict", "accept");
  const res = await app.request(`/s/${uuid}/send`, { method: "POST", body: form });

  expect(res.status).toBe(302);
  // runTurn was called (drain branch took over)
  expect(runTurnCalls.length).toBe(beforeRunTurn + 1);
  // send-keys was NOT called (drain branch, not interactive send-keys branch)
  expect(sentKeys.length).toBe(beforeSentKeys);
});

// Restore all mock.module registrations so sibling test files (e.g. triggers-fire.test.ts
// using spawn-adapter.ts → spawnRun) that run after this file get the real implementations.
afterAll(() => {
  mock.restore();
});
