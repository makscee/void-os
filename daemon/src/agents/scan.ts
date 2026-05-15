// VOS-92 T1.3: scanVaultAgents — read vault/agents/<name>/agent.md files,
// parse YAML frontmatter via gray-matter (already a daemon dep), return
// AgentRow[]. Skip malformed entries; never throw.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { AgentRow } from "./types";

const REQUIRED = ["name", "description", "model"] as const;

export function scanVaultAgents(vaultRoot: string): AgentRow[] {
  const agentsDir = join(vaultRoot, "agents");
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }

  const rows: AgentRow[] = [];
  const now = Date.now();

  for (const folderName of entries) {
    const folderPath = join(agentsDir, folderName);
    try {
      if (!statSync(folderPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const filePath = join(folderPath, "agent.md");
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      // No agent.md in this folder — skip silently.
      continue;
    }

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch (e) {
      console.warn(`scanVaultAgents: ${filePath} frontmatter parse failed:`, e);
      continue;
    }

    const fm = parsed.data as Record<string, unknown>;
    const missing = REQUIRED.filter(
      (k) => typeof fm[k] !== "string" || (fm[k] as string).length === 0,
    );
    if (missing.length > 0) {
      console.warn(
        `scanVaultAgents: ${filePath} missing required field(s): ${missing.join(", ")} — skipping`,
      );
      continue;
    }

    if (fm.name !== folderName) {
      console.warn(
        `scanVaultAgents: folder "${folderName}" / frontmatter name "${fm.name}" mismatch — skipping`,
      );
      continue;
    }

    rows.push({
      name: fm.name as string,
      description: fm.description as string,
      model: fm.model as string,
      vault_path: filePath,
      updated_at: now,
    });
  }

  return rows;
}
