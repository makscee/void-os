// VOS-106 T10.B: persona injection — assert spawn argv carries the
// agent.md body via `--append-system-prompt`, and that missing/empty
// personas degrade gracefully (no flag, no crash).

import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { runMigrationsFromDir } from "../../../adapters/sqlite/migrations";
import { createEventBus } from "../../../events";
import { createPermissionEngine } from "../../../permissions/engine";
import { createCcSpawner } from "../index";
import { readAgentPersonaBody } from "../persona";

const MIGRATIONS = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "adapters",
  "sqlite",
  "migrations",
);

function setupVault(agentName: string, fm: string, body: string): string {
  const vaultRoot = mkdtempSync(join(tmpdir(), "vos-106-persona-vault-"));
  const agentDir = join(vaultRoot, "agents", agentName);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "agent.md"),
    `---\n${fm}\n---\n${body}`,
  );
  return vaultRoot;
}

function makeFakeSpawn() {
  let capturedCmd: string[] | undefined;
  const spawnFn = (cmd: string[], _opts: unknown) => {
    capturedCmd = cmd;
    return {
      pid: 99999,
      exited: Promise.resolve(0),
      stdout: new ReadableStream({ start: (c) => c.close() }),
      stderr: new ReadableStream({ start: (c) => c.close() }),
      kill: () => {},
    } as never;
  };
  return { spawnFn, getCmd: () => capturedCmd };
}

function seedAgentCard(db: Database, name: string) {
  db.run(
    "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
    [
      name,
      JSON.stringify({
        name,
        read_scope: ["vault/**"],
        write_scope: [],
      }),
    ],
  );
}

function loadAgentDefnFromDb(db: Database) {
  return (name: string) => {
    const row = db
      .query("SELECT card_json FROM agent_cards WHERE agent_name=?")
      .get(name) as { card_json: string } | undefined;
    if (!row) throw new Error(`unknown agent: ${name}`);
    const parsed = JSON.parse(row.card_json);
    return {
      name,
      read_scope: parsed.read_scope,
      write_scope: parsed.write_scope,
    };
  };
}

describe("readAgentPersonaBody", () => {
  it("returns the markdown body with frontmatter stripped", () => {
    const vault = setupVault(
      "maya",
      "name: maya\ndescription: x\nmodel: opus",
      "# maya\n\nYou are Maya. Route via ask_agent(...).\n",
    );
    const r = readAgentPersonaBody(vault, "maya");
    expect(r.reason).toBe("ok");
    expect(r.body).toContain("You are Maya");
    expect(r.body).not.toContain("---");
    expect(r.body).not.toMatch(/^name:/m);
  });

  it("returns empty + reason=missing when agent.md is absent", () => {
    const vault = mkdtempSync(join(tmpdir(), "vos-106-no-agent-"));
    const r = readAgentPersonaBody(vault, "ghost");
    expect(r.body).toBe("");
    expect(r.reason).toBe("missing");
  });

  it("returns empty + reason=empty when body is whitespace-only", () => {
    const vault = setupVault(
      "blank",
      "name: blank\ndescription: x\nmodel: opus",
      "\n\n",
    );
    const r = readAgentPersonaBody(vault, "blank");
    expect(r.body).toBe("");
    expect(r.reason).toBe("empty");
  });
});

describe("cc-spawner persona injection", () => {
  it("argv contains --append-system-prompt <body> when agent.md has a body", async () => {
    const db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS);
    seedAgentCard(db, "maya");
    const tracesDir = mkdtempSync(join(tmpdir(), "vos-106-traces-persona-"));
    const vaultRoot = setupVault(
      "maya",
      "name: maya\ndescription: x\nmodel: opus",
      "# maya\n\nYou must emit ask_agent(name, question).\n",
    );

    const bus = createEventBus({ db });
    const engine = createPermissionEngine({
      vaultRoot,
      homeRoot: "/tmp/home",
    });
    const fake = makeFakeSpawn();

    const cc = createCcSpawner({
      bus,
      db,
      tracesDir,
      engine,
      daemonBase: "http://127.0.0.1:17777",
      hookScriptPath: "/abs/pre-tool-use.ts",
      loadAgentDefn: loadAgentDefnFromDb(db),
      spawnFn: fake.spawnFn,
    });

    await cc.spawn({
      prompt: "hi",
      agent: "maya",
      cwd: vaultRoot,
      chatId: "c1",
      kind: "chat",
    });

    const cmd = fake.getCmd();
    expect(cmd).toBeDefined();
    const idx = cmd!.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(0);
    const body = cmd![idx + 1];
    expect(body).toContain("ask_agent(name, question)");
    expect(body).not.toMatch(/^---/);
  });

  it("argv omits --append-system-prompt when agent.md is missing", async () => {
    const db = new Database(":memory:");
    runMigrationsFromDir(db, MIGRATIONS);
    seedAgentCard(db, "ghost");
    const tracesDir = mkdtempSync(join(tmpdir(), "vos-106-traces-ghost-"));
    const vaultRoot = mkdtempSync(join(tmpdir(), "vos-106-vault-ghost-"));

    const bus = createEventBus({ db });
    const engine = createPermissionEngine({
      vaultRoot,
      homeRoot: "/tmp/home",
    });
    const fake = makeFakeSpawn();

    const cc = createCcSpawner({
      bus,
      db,
      tracesDir,
      engine,
      daemonBase: "http://127.0.0.1:17777",
      hookScriptPath: "/abs/pre-tool-use.ts",
      loadAgentDefn: loadAgentDefnFromDb(db),
      spawnFn: fake.spawnFn,
    });

    await cc.spawn({
      prompt: "hi",
      agent: "ghost",
      cwd: vaultRoot,
      chatId: "c1",
      kind: "chat",
    });

    const cmd = fake.getCmd();
    expect(cmd).toBeDefined();
    expect(cmd!.includes("--append-system-prompt")).toBe(false);
  });
});
