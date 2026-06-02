// frontmatter.ts — parse SKILL.md front matter (Task 3)
export interface SkillMeta {
  name: string;
  description: string;
  needsInput: boolean;
  inputLabel: string;
  outputTarget: string; // vault-relative path/glob the execution must mutate (VOS-191)
  version?: string;     // semver — optional (VOS-199 skill-manage rollback)
}

export function parseFrontmatter(md: string): SkillMeta {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const out: SkillMeta = { name: "", description: "", needsInput: false, inputLabel: "", outputTarget: "" };
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    const val = v.replace(/^["']|["']$/g, "").trim();
    if (k === "name") out.name = val;
    if (k === "description") out.description = val;
    if (k === "needs_input") out.needsInput = val === "true";
    if (k === "input_label") out.inputLabel = val;
    if (k === "output_target") out.outputTarget = val;
    if (k === "version") out.version = val;
  }
  return out;
}
