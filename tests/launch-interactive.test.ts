// launch-interactive.test.ts — VOS-206 T3: /launch defaults conversational skills to interactive
import { expect, test, beforeAll, mock } from "bun:test";
import { mkdirSync, rmSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../src/registry.ts";
import { randomUUID } from "node:crypto";

const vault = mkdtempSync(join(tmpdir(), "vos206-launch-interactive-"));
const db = openRegistry(":memory:");

type SpawnRunCall = {
  skill: string | null;
  agent: string | null;
  interactive?: boolean;
  forcePrint?: boolean | null;
  outputTarget?: string | null;
  [key: string]: unknown;
};
const spawnRunCalls: SpawnRunCall[] = [];

// Mock catalog to return known skills with interactive flags
mock.module("../src/catalog.ts", () => ({
  listCatalogSkills: () => [
    { name: "chat", description: "Chat skill", needsInput: false, inputLabel: "", outputTarget: "", interactive: true, dir: "/mock" },
    { name: "organize", description: "Organize skill", needsInput: false, inputLabel: "", outputTarget: "", interactive: false, dir: "/mock" },
    { name: "onboarding", description: "Onboarding skill", needsInput: true, inputLabel: "Name", outputTarget: "", interactive: true, dir: "/mock" },
  ],
}));

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
    return { runId, tmuxSession: `vos-run-${runId}` };
  },
}));

mock.module("../src/drain.ts", () => ({
  drain: async () => ({ status: "complete", iterations: 0 }),
}));

mock.module("../src/preflight.ts", () => ({
  realDeps: { vcStatus: async () => ({ ok: true, msg: "authed" }) },
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
}));

mock.module("../src/resume.ts", () => ({
  respawnSession: (_db: unknown, _vault: string, execId: string) => `vos-run-${execId}`,
  buildResumeArgv: (ccId: string, vault: string) => ["--resume", ccId, "--add-dir", vault, "--permission-mode", "bypassPermissions"],
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

test("launch organize spawns print one-shot + persists interactive:false in meta", async () => {
  const app = makeApp(vault, db);
  spawnRunCalls.length = 0;
  const form = new FormData();
  form.append("skill", "organize");
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
