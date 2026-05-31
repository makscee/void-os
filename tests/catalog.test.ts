import { expect, test, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listCatalogSkills } from "../src/catalog.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const realCatalogRoot = join(repoRoot, "catalog");

const root = "/tmp/voidos-catalog-test";
beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(`${root}/skills/alpha`, { recursive: true });
  mkdirSync(`${root}/skills/beta`, { recursive: true });
  writeFileSync(`${root}/skills/alpha/SKILL.md`, `---\nname: alpha\ndescription: First.\n---\n`);
  writeFileSync(`${root}/skills/beta/SKILL.md`, `---\nname: beta\ndescription: Second.\n---\n`);
});

test("lists skills sorted by name with dir + meta", () => {
  const skills = listCatalogSkills(root);
  expect(skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
  expect(skills[0].dir).toBe(`${root}/skills/alpha`);
  expect(skills[1].description).toBe("Second.");
});

test("skips dirs without SKILL.md", () => {
  mkdirSync(`${root}/skills/orphan`, { recursive: true });
  // no SKILL.md written
  const skills = listCatalogSkills(root);
  expect(skills.map((s) => s.name)).not.toContain("orphan");
});

test("empty skills dir returns empty array", () => {
  rmSync(`${root}/skills`, { recursive: true });
  mkdirSync(`${root}/skills`, { recursive: true });
  expect(listCatalogSkills(root)).toEqual([]);
});

test("real catalog contains smoke-test skill", () => {
  const skills = listCatalogSkills(realCatalogRoot);
  const smokeTest = skills.find((s) => s.name === "smoke-test");
  expect(smokeTest).toBeDefined();
  expect(smokeTest!.description).toContain("smoke");
});

test("real catalog contains ralph skill with non-empty description", () => {
  const skills = listCatalogSkills(realCatalogRoot);
  const ralph = skills.find((s) => s.name === "ralph");
  expect(ralph).toBeDefined();
  expect(ralph!.description.length).toBeGreaterThan(0);
  expect(ralph!.description).toContain("Box");
});
