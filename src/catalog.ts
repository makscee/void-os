// catalog.ts — list installable skills from the vendored catalog (Task 4)
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, type SkillMeta } from "./frontmatter.ts";

export interface CatalogSkill extends SkillMeta { dir: string; }

export function listCatalogSkills(catalogRoot: string): CatalogSkill[] {
  const skillsDir = join(catalogRoot, "skills");
  if (!existsSync(skillsDir)) return [];

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  const skills: CatalogSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    const skillMd = join(dir, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const content = readFileSync(skillMd, "utf8");
    const meta = parseFrontmatter(content);
    skills.push({ dir, ...meta });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
