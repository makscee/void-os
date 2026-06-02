// spawn-agent.test.ts — VOS-200 T3: buildSpawnArgv agent fields test
import { test, expect } from "bun:test";
import { buildSpawnArgv } from "../src/spawn.ts";

test("buildSpawnArgv: agent fields add --add-dir per folder, --mcp-config, --append-system-prompt, body in -p", () => {
  const argv = buildSpawnArgv("seed", "/s.json", "/v", {
    skill: null,
    isPrint: true,
    addDirs: ["/v/projects", "/v/journal"],
    mcpConfigPath: "/v/.void-os/agent-mcp/librarian.json",
    appendSystemPrompt: 'You are the "librarian" agent. sorts knowledge',
    bodyMessage: "MEMORY: ANI under projects/animaya",
  });
  // Agent folder dirs present as --add-dir
  expect(argv).toContain("--add-dir");
  expect(argv).toContain("/v/projects");
  expect(argv).toContain("/v/journal");
  // MCP config
  expect(argv).toContain("--mcp-config");
  expect(argv).toContain("/v/.void-os/agent-mcp/librarian.json");
  // STABLE identity in system tier
  expect(argv).toContain("--append-system-prompt");
  expect(argv).toContain('You are the "librarian" agent. sorts knowledge');
  // Body goes into -p (messages tier), NOT into --append-system-prompt
  const sysIdx = argv.indexOf("--append-system-prompt");
  expect(sysIdx).toBeGreaterThan(-1);
  expect(argv[sysIdx + 1]).not.toContain("MEMORY: ANI");
  const pIdx = argv.indexOf("-p");
  expect(pIdx).toBeGreaterThan(-1);
  expect(argv[pIdx + 1]).toContain("MEMORY: ANI under projects/animaya");
});

test("buildSpawnArgv: --strict-mcp-config present when mcpConfigPath set", () => {
  const argv = buildSpawnArgv("seed", "/s.json", "/v", {
    skill: null,
    isPrint: true,
    mcpConfigPath: "/v/.void-os/agent-mcp/bot.json",
  });
  expect(argv).toContain("--strict-mcp-config");
});

test("buildSpawnArgv: skill+bodyMessage combined in -p prompt", () => {
  const argv = buildSpawnArgv("seed", "/s.json", "/v", {
    skill: "deep-research",
    isPrint: true,
    bodyMessage: "MEMORY: prior knowledge here",
  });
  const pIdx = argv.indexOf("-p");
  expect(pIdx).toBeGreaterThan(-1);
  const prompt = argv[pIdx + 1];
  expect(prompt).toContain("/deep-research");
  expect(prompt).toContain("MEMORY: prior knowledge here");
});

test("buildSpawnArgv: no agent fields = today's shape (skill only)", () => {
  const argv = buildSpawnArgv("seed", "/s.json", "/v", { skill: "idle", isPrint: true });
  expect(argv).not.toContain("--mcp-config");
  expect(argv).not.toContain("--strict-mcp-config");
  expect(argv).not.toContain("--append-system-prompt");
  // Only the vault --add-dir (no extra dirs)
  const addDirCount = argv.filter((a) => a === "--add-dir").length;
  expect(addDirCount).toBe(1);
  // Skill is in -p
  const pIdx = argv.indexOf("-p");
  expect(pIdx).toBeGreaterThan(-1);
  expect(argv[pIdx + 1]).toBe("/idle");
});

test("buildSpawnArgv: no agent fields, no skill → no -p arg", () => {
  const argv = buildSpawnArgv("seed", "/s.json", "/v", { skill: null, isPrint: true });
  expect(argv).not.toContain("-p");
  expect(argv).not.toContain("--append-system-prompt");
});

test("buildSpawnArgv: non-print mode with skill places skill arg without -p flag", () => {
  const argv = buildSpawnArgv("seed", "/s.json", "/v", { skill: "onboarding", isPrint: false });
  expect(argv).not.toContain("-p");
  expect(argv).toContain("/onboarding");
});
