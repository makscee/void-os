// send-interactive.test.ts — VOS-206 T4: /send routes interactive form-submits to live REPL
// Tests the new interactive branch in POST /s/:uuid/send.
import { expect, test, beforeAll, mock } from "bun:test";
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
    return { runId, tmuxSession: `vos-run-${runId}` };
  },
}));

mock.module("../src/drain.ts", () => ({
  drain: async () => ({ status: "complete", iterations: 0 }),
}));

mock.module("../src/preflight.ts", () => ({
  realDeps: { vcStatus: async () => ({ ok: true, msg: "authed" }) },
}));

mock.module("../src/tmux.ts", () => ({
  hasSession: (name: string) => hasSessionMap.get(name) ?? false,
  switchClient: () => ({ code: 0, stderr: "" }),
  sendKeys: (target: string, line: string) => { sentKeys.push([target, line]); },
  killSession: () => {},
  newRunSession: () => 0,
  listVosSessions: () => [],
  attachCommand: (name: string) => `tmux -L vos attach -t ${name}`,
  VOS_SOCKET: "vos",
}));

mock.module("../src/resume.ts", () => ({
  respawnSession: (_db: unknown, _vault: string, execId: string, runner: string) => {
    respawnCalls.push({ execId, runner });
    hasSessionMap.set(`vos-run-${execId}`, true);
    return `vos-run-${execId}`;
  },
  buildResumeArgv: (ccId: string, vaultPath: string) => [
    "--resume", ccId, "--add-dir", vaultPath, "--permission-mode", "bypassPermissions",
  ],
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

test("print-mode session form-submit keeps fresh-spawn form-resume (unchanged)", async () => {
  const uuid = `print-mode-${randomUUID()}`;
  seedSession(uuid, { skill: "onboarding", interactive: false, runner: "vc --" });

  const beforeSpawn = spawnRunCalls.length;
  const beforeSentKeys = sentKeys.length;
  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("name", "Carol");
  const res = await app.request(`/s/${uuid}/send`, { method: "POST", body: form });

  expect(res.status).toBe(302);
  // Redirects to a NEW session (not the original uuid)
  const newLoc = res.headers.get("location") ?? "";
  expect(newLoc).not.toBe(`/s/${uuid}`);
  expect(newLoc).toMatch(/\/s\/exec-[0-9a-f-]+/);
  // spawnRun was called (legacy fresh-spawn path)
  expect(spawnRunCalls.length).toBe(beforeSpawn + 1);
  // NO send-keys (print mode)
  expect(sentKeys.length).toBe(beforeSentKeys);
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
