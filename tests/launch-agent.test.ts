// launch-agent.test.ts — VOS-200 T4: /launch with optional agent param
import { expect, test, beforeAll, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRegistry } from "../src/registry.ts";
import { randomUUID } from "node:crypto";

const vault = mkdtempSync(join(tmpdir(), "vos200-launch-"));

const db = openRegistry(":memory:");

// --- Stubs ---

type SpawnRunCall = {
  skill: string | null;
  agent: string | null;
  addDirs?: string[];
  appendSystemPrompt?: string;
  bodyMessage?: string;
  outputTarget?: string | null;
  mcpConfigPath?: string | null;
  forcePrint?: boolean | null;
};
const spawnRunCalls: SpawnRunCall[] = [];

mock.module("../src/spawn.ts", () => ({
  buildLaunchArgv: (uuid: string, skill: string, text: string) => ["--session-id", uuid, "-p", text ? `/${skill} ${text}` : `/${skill}`, "--permission-mode", "bypassPermissions"],
  buildAnswerArgv: (uuid: string, text: string) => ["--resume", uuid, "-p", text, "--permission-mode", "bypassPermissions"],
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

// Stub agents.ts to avoid needing real agent files for the server route test
mock.module("../src/agents.ts", () => ({
  buildAgentLaunch: (v: string, name: string) => {
    if (name === "librarian") {
      return {
        addDirs: [join(v, "projects"), join(v, "journal")],
        mcpConfigPath: null,
        appendSystemPrompt: `You are the "librarian" agent. sorts knowledge\nYou compose these skills (invoke by name): deep-research.`,
        bodyMessage: "MEMORY: ANI notes live under projects/animaya.",
        outputTarget: "agents/librarian.md",
      };
    }
    throw new Error(`agent not found: ${name}`);
  },
  listAgents: () => [],
  parseAgentFile: () => ({ name: "", description: "", folders: [], mcps: [], skills: [], body: "" }),
  agentPath: (v: string, name: string) => join(v, "agents", `${name}.md`),
}));

const { makeApp } = await import("../src/server.ts");

beforeAll(() => {
  rmSync(vault, { recursive: true, force: true });
  mkdirSync(`${vault}/sessions`, { recursive: true });
  spawnRunCalls.length = 0;
});

test("POST /launch with agent=librarian: spawnRun receives agent name, addDirs, appendSystemPrompt, outputTarget", async () => {
  const app = makeApp(vault, db);
  spawnRunCalls.length = 0;
  const form = new FormData();
  form.append("agent", "librarian");
  const res = await app.request("/launch", { method: "POST", body: form });
  // Should redirect (302) to the session page
  expect(res.status).toBe(302);
  expect(spawnRunCalls.length).toBe(1);
  const call = spawnRunCalls[0];
  expect(call.agent).toBe("librarian");
  expect(call.addDirs).toBeDefined();
  expect((call.addDirs as string[]).length).toBeGreaterThan(0);
  expect(call.appendSystemPrompt).toContain("librarian");
  expect(call.outputTarget).toBe("agents/librarian.md");
  expect(call.forcePrint).toBe(true);
});

test("POST /launch without agent: spawnRun receives agent=null, no addDirs/appendSystemPrompt", async () => {
  const app = makeApp(vault, db);
  spawnRunCalls.length = 0;
  const form = new FormData();
  form.append("skill", "vault-native-smoke");
  const res = await app.request("/launch", { method: "POST", body: form });
  expect(res.status).toBe(302);
  expect(spawnRunCalls.length).toBe(1);
  const call = spawnRunCalls[0];
  expect(call.agent).toBeNull();
  expect(call.addDirs).toBeUndefined();
  expect(call.appendSystemPrompt).toBeUndefined();
  expect(call.forcePrint).toBeNull();
});

test("POST /launch with unknown agent returns 404", async () => {
  const app = makeApp(vault, db);
  const form = new FormData();
  form.append("agent", "nonexistent");
  const res = await app.request("/launch", { method: "POST", body: form });
  expect(res.status).toBe(404);
  const text = await res.text();
  expect(text).toContain("nonexistent");
});

test("POST /launch with agent + skill: both threaded to spawnRun", async () => {
  const app = makeApp(vault, db);
  spawnRunCalls.length = 0;
  const form = new FormData();
  form.append("agent", "librarian");
  form.append("skill", "deep-research");
  const res = await app.request("/launch", { method: "POST", body: form });
  expect(res.status).toBe(302);
  const call = spawnRunCalls[0];
  expect(call.agent).toBe("librarian");
  expect(call.skill).toBe("deep-research");
  expect(call.appendSystemPrompt).toContain("librarian");
});
