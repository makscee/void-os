// VOS-107 review followup: unit coverage for scanAgentCards + upsertAgentCards.
//
// Mirrors the scan.test.ts fixture style (tmpdir vault, in-line frontmatter)
// and the repo.test.ts DB harness (in-memory Database, runMigrationsFromDir).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../adapters/sqlite/migrations";
import { scanAgentCards, upsertAgentCards } from "../cards-scan";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "adapters", "sqlite", "migrations");

function makeVault(): string {
  return mkdtempSync(join(tmpdir(), "cards-scan-"));
}

function freshDb(): Database {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  return db;
}

function writeAgentRaw(vault: string, folder: string, raw: string) {
  const dir = join(vault, "agents", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), raw);
}

function writeAgent(
  vault: string,
  folder: string,
  frontmatter: Record<string, unknown>,
  body = "you are an agent\n",
) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}`;
      }
      return `${k}: ${v}`;
    })
    .join("\n");
  writeAgentRaw(vault, folder, `---\n${fm}\n---\n${body}`);
}

function readCards(db: Database): Array<{ agent_name: string; card_json: string; source_mtime: number }> {
  return db
    .query<{ agent_name: string; card_json: string; source_mtime: number }, []>(
      "SELECT agent_name, card_json, source_mtime FROM agent_cards ORDER BY agent_name",
    )
    .all();
}

describe("scanAgentCards", () => {
  test("missing vault/agents/ directory returns []", () => {
    const vault = makeVault();
    // No agents/ subdir created.
    expect(scanAgentCards(vault)).toEqual([]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("empty agents/ directory returns []", () => {
    const vault = makeVault();
    mkdirSync(join(vault, "agents"), { recursive: true });
    expect(scanAgentCards(vault)).toEqual([]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("agent.md missing frontmatter is skipped", () => {
    const vault = makeVault();
    // No --- delimiters: gray-matter parses empty .data, so fm.name !== folder.
    writeAgentRaw(vault, "naked", "just a body, no frontmatter at all\n");
    expect(scanAgentCards(vault)).toEqual([]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("name vs folder mismatch is skipped", () => {
    const vault = makeVault();
    writeAgent(vault, "maya", { name: "other", description: "x", model: "opus" });
    expect(scanAgentCards(vault)).toEqual([]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("well-formed maya/journaler/task-tracker → upsertAgentCards inserts 3 rows", () => {
    const vault = makeVault();
    writeAgent(vault, "maya", { name: "maya", description: "front desk", model: "opus" });
    writeAgent(vault, "journaler", { name: "journaler", description: "journal", model: "haiku" });
    writeAgent(vault, "task-tracker", { name: "task-tracker", description: "tasks", model: "sonnet" });

    const rows = scanAgentCards(vault);
    expect(rows.length).toBe(3);

    const db = freshDb();
    upsertAgentCards(db, rows);
    const cards = readCards(db);
    expect(cards.map((c) => c.agent_name)).toEqual(["journaler", "maya", "task-tracker"]);
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  test("second call with changed frontmatter updates card_json + source_mtime (ON CONFLICT DO UPDATE)", () => {
    const vault = makeVault();
    writeAgent(vault, "maya", {
      name: "maya",
      description: "v1",
      read_scope: ["vault/journal/**"],
    });

    const db = freshDb();
    upsertAgentCards(db, scanAgentCards(vault));
    const before = readCards(db);
    expect(before.length).toBe(1);
    const beforeCard = JSON.parse(before[0].card_json);
    expect(beforeCard.read_scope).toEqual(["vault/journal/**"]);
    const beforeMtime = before[0].source_mtime;

    // Rewrite with different scope + bumped mtime.
    writeAgent(vault, "maya", {
      name: "maya",
      description: "v2",
      read_scope: ["vault/work/**", "vault/journal/**"],
    });
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(vault, "agents", "maya", "agent.md"), future, future);

    upsertAgentCards(db, scanAgentCards(vault));
    const after = readCards(db);
    expect(after.length).toBe(1); // still one row — UPDATE not INSERT
    const afterCard = JSON.parse(after[0].card_json);
    expect(afterCard.read_scope).toEqual(["vault/work/**", "vault/journal/**"]);
    expect(after[0].source_mtime).toBeGreaterThan(beforeMtime);
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  test("VOS-122 F7: tools array serializes into card_json (declared allowlist)", () => {
    const vault = makeVault();
    writeAgent(vault, "tinker", {
      name: "tinker",
      description: "meta",
      model: "opus",
      tools: ["vault.read", "vault.create", "ask_user"],
    });
    const db = freshDb();
    upsertAgentCards(db, scanAgentCards(vault));
    const cards = readCards(db);
    expect(cards.length).toBe(1);
    const card = JSON.parse(cards[0].card_json);
    expect(card.tools).toEqual(["vault.read", "vault.create", "ask_user"]);
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  test("VOS-122 F7: agent.md without tools field => card.tools absent (legacy)", () => {
    const vault = makeVault();
    writeAgent(vault, "legacy", {
      name: "legacy",
      description: "no tools field",
      model: "opus",
    });
    const db = freshDb();
    upsertAgentCards(db, scanAgentCards(vault));
    const cards = readCards(db);
    const card = JSON.parse(cards[0].card_json);
    expect(card.tools).toBeUndefined();
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  test("read_scope/write_scope/ask_agent_allow arrays serialize into card_json", () => {
    const vault = makeVault();
    writeAgent(vault, "maya", {
      name: "maya",
      description: "x",
      read_scope: ["vault/**", "workspace/void-os/**"],
      write_scope: ["vault/work/**"],
      ask_agent_allow: ["journaler", "task-tracker"],
    });

    const db = freshDb();
    upsertAgentCards(db, scanAgentCards(vault));
    const cards = readCards(db);
    expect(cards.length).toBe(1);
    const card = JSON.parse(cards[0].card_json);
    expect(card.name).toBe("maya");
    expect(card.read_scope).toEqual(["vault/**", "workspace/void-os/**"]);
    expect(card.write_scope).toEqual(["vault/work/**"]);
    expect(card.ask_agent_allow).toEqual(["journaler", "task-tracker"]);
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });
});
