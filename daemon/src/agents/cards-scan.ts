// Seed agent_cards from vault/agents/<name>/agent.md frontmatter.
//
// Production-side complement to scanVaultAgents (which only fills the wire
// `agents` table). The provider + permission engine look up an AgentDefn via
// `defaultLoadAgentDefn` which reads `agent_cards.card_json`; without this
// seed every dispatch dies with "unknown agent: <name>" because nothing in
// the boot path was populating the table outside tests.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import type { Database } from "bun:sqlite";

interface CardRow {
  name: string;
  cardJson: string;
  sourceMtime: number;
}

const stringArrayField = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
};

export function scanAgentCards(vaultRoot: string): CardRow[] {
  const agentsDir = join(vaultRoot, "agents");
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }

  const rows: CardRow[] = [];
  for (const folderName of entries) {
    const folderPath = join(agentsDir, folderName);
    let st: ReturnType<typeof statSync>;
    try {
      if (!statSync(folderPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const filePath = join(folderPath, "agent.md");
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
      st = statSync(filePath);
    } catch {
      continue;
    }
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch {
      continue;
    }
    const fm = parsed.data as Record<string, unknown>;
    if (typeof fm.name !== "string" || fm.name !== folderName) continue;

    const card: Record<string, unknown> = { name: fm.name };
    const r = stringArrayField(fm.read_scope);
    if (r) card.read_scope = r;
    const w = stringArrayField(fm.write_scope);
    if (w) card.write_scope = w;
    const a = stringArrayField(fm.ask_agent_allow);
    if (a) card.ask_agent_allow = a;

    rows.push({
      name: fm.name,
      cardJson: JSON.stringify(card),
      sourceMtime: Math.floor(st.mtimeMs),
    });
  }
  return rows;
}

export function upsertAgentCards(db: Database, rows: CardRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO agent_cards (agent_name, card_json, source_mtime)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_name) DO UPDATE SET
       card_json = excluded.card_json,
       source_mtime = excluded.source_mtime`,
  );
  const tx = db.transaction((items: CardRow[]) => {
    for (const r of items) stmt.run(r.name, r.cardJson, r.sourceMtime);
  });
  tx(rows);
}
