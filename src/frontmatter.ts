// frontmatter.ts — parse SKILL.md front matter (Task 3)
export interface SkillMeta { name: string; description: string; }

export function parseFrontmatter(md: string): SkillMeta {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const out: SkillMeta = { name: "", description: "" };
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    const val = v.replace(/^["']|["']$/g, "").trim();
    if (k === "name") out.name = val;
    if (k === "description") out.description = val;
  }
  return out;
}
