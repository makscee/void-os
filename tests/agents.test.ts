// agents.test.ts — VOS-200 agent-as-file unit tests
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentFile, listAgents, buildAgentLaunch } from "../src/agents.ts";

// ---- Task 1: parseAgentFile ----

test("parseAgentFile reads name/description/folders/mcps/skills + body", () => {
  const md = [
    "---",
    "name: librarian",
    "description: sorts knowledge across projects",
    "folders:",
    "  - vault/projects",
    "  - vault/journal",
    "mcps:",
    "  - context-mode",
    "skills:",
    "  - deep-research",
    "---",
    "I have learned that ANI notes live under projects/animaya.",
  ].join("\n");
  const a = parseAgentFile(md);
  expect(a.name).toBe("librarian");
  expect(a.description).toBe("sorts knowledge across projects");
  expect(a.folders).toEqual(["vault/projects", "vault/journal"]);
  expect(a.mcps).toEqual(["context-mode"]);
  expect(a.skills).toEqual(["deep-research"]);
  expect(a.body.trim()).toBe("I have learned that ANI notes live under projects/animaya.");
});

test("parseAgentFile: no frontmatter → entire md is body", () => {
  const a = parseAgentFile("just a body\nno frontmatter");
  expect(a.name).toBe("");
  expect(a.body).toContain("just a body");
});

test("parseAgentFile: empty lists result in empty arrays", () => {
  const md = ["---", "name: bot", "description: helper", "---", ""].join("\n");
  const a = parseAgentFile(md);
  expect(a.folders).toEqual([]);
  expect(a.mcps).toEqual([]);
  expect(a.skills).toEqual([]);
});

// ---- Task 2: listAgents + buildAgentLaunch ----

function seedAgent(): string {
  const vault = mkdtempSync(join(tmpdir(), "vos200-"));
  mkdirSync(join(vault, "agents"), { recursive: true });
  writeFileSync(join(vault, "agents", "librarian.md"), [
    "---", "name: librarian", "description: sorts knowledge",
    "folders:", "  - projects", "  - journal",
    "skills:", "  - deep-research", "---",
    "MEMORY: ANI notes live under projects/animaya.",
  ].join("\n"));
  return vault;
}

test("listAgents enumerates agents/ dir", () => {
  const vault = seedAgent();
  expect(listAgents(vault).map((a) => a.name)).toEqual(["librarian"]);
});

test("listAgents returns empty array when agents/ dir missing", () => {
  const vault = mkdtempSync(join(tmpdir(), "vos200-empty-"));
  expect(listAgents(vault)).toEqual([]);
});

test("buildAgentLaunch maps folders→addDirs, skills+desc→appendSystemPrompt, body→bodyMessage", () => {
  const vault = seedAgent();
  const lc = buildAgentLaunch(vault, "librarian");
  expect(lc.addDirs).toEqual([join(vault, "projects"), join(vault, "journal")]);
  expect(lc.appendSystemPrompt).toContain("sorts knowledge");
  expect(lc.appendSystemPrompt).toContain("deep-research");
  expect(lc.bodyMessage).toContain("ANI notes live under projects/animaya");
  expect(lc.outputTarget).toBe("agents/librarian.md");
});

test("buildAgentLaunch throws when agent file not found", () => {
  const vault = seedAgent();
  expect(() => buildAgentLaunch(vault, "nonexistent")).toThrow("agent not found: nonexistent");
});

test("CACHE INVARIANT: editing the memory body does not change appendSystemPrompt; body never leaks into the prefix", () => {
  const vault = seedAgent();
  const before = buildAgentLaunch(vault, "librarian");
  const originalContent = readFileSync(join(vault, "agents", "librarian.md"), "utf8");
  writeFileSync(
    join(vault, "agents", "librarian.md"),
    originalContent + "\nMEMORY+: VKE is the auth key pool.",
  );
  const after = buildAgentLaunch(vault, "librarian");
  // System-tier prefix is byte-identical before and after body edit
  expect(after.appendSystemPrompt).toBe(before.appendSystemPrompt);
  // Body text NEVER leaks into the system prefix
  expect(after.appendSystemPrompt).not.toContain("VKE is the auth key pool");
  expect(after.appendSystemPrompt).not.toContain("ANI notes live under projects/animaya");
  // New body line appears in the volatile messages tier only
  expect(after.bodyMessage).toContain("VKE is the auth key pool");
});

test("CACHE INVARIANT: system prompt does NOT contain any memory body content", () => {
  const vault = seedAgent();
  const lc = buildAgentLaunch(vault, "librarian");
  // Body text must only appear in bodyMessage, never in appendSystemPrompt
  expect(lc.appendSystemPrompt).not.toContain("MEMORY:");
  expect(lc.appendSystemPrompt).not.toContain("ANI notes");
  expect(lc.bodyMessage).toContain("MEMORY: ANI notes live under projects/animaya");
});
