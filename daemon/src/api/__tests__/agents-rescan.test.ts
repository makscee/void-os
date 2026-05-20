// VOS-166: GET /agents must surface an agent.md authored AFTER the daemon's
// boot-time scan, without a restart. Regression caught by the VOS-163
// operator-journey e2e (stage S4).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runMigrationsFromDir } from "../../adapters/sqlite/migrations";
import { agentsApi } from "../agents";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "adapters", "sqlite", "migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  db.exec("DELETE FROM agents");
  return db;
}

function writeAgent(vaultRoot: string, name: string) {
  const dir = join(vaultRoot, "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent.md"),
    `---\nname: ${name}\ndescription: ${name} agent\nmodel: opus\n---\n# ${name}\n`,
  );
}

async function listNames(app: Hono): Promise<string[]> {
  const res = await app.request("/agents");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { agents: Array<{ name: string }> };
  return body.agents.map((a) => a.name);
}

describe("VOS-166: GET /agents rescans vault on read", () => {
  let vaultRoot: string;

  beforeEach(() => {
    vaultRoot = mkdtempSync(join(tmpdir(), "vos166-"));
    mkdirSync(join(vaultRoot, "agents"), { recursive: true });
  });

  afterEach(() => {
    rmSync(vaultRoot, { recursive: true, force: true });
  });

  test("agent authored after boot becomes visible without restart", async () => {
    const db = freshDb();
    // Simulate boot: empty agents dir → empty registry.
    const app = new Hono();
    app.route("/", agentsApi(db, vaultRoot));
    expect(await listNames(app)).toEqual([]);

    // Operator authors a new agent.md AFTER the daemon booted.
    writeAgent(vaultRoot, "journaler");

    // Debounce window is 1s; advance past it so the rescan fires.
    await Bun.sleep(1100);

    expect(await listNames(app)).toEqual(["journaler"]);
    db.close();
  });

  test("rescan also seeds agent_cards (dispatch lookup)", async () => {
    const db = freshDb();
    const app = new Hono();
    app.route("/", agentsApi(db, vaultRoot));
    await listNames(app); // initial read, empty

    writeAgent(vaultRoot, "scout");
    await Bun.sleep(1100);
    await listNames(app); // triggers rescan

    const card = db
      .prepare("SELECT card_json FROM agent_cards WHERE agent_name = ?")
      .get("scout") as { card_json: string } | null;
    expect(card).not.toBeNull();
    db.close();
  });

  test("without vaultRoot the handler still works (unit-test shape)", async () => {
    const db = freshDb();
    const app = new Hono();
    app.route("/", agentsApi(db)); // no vaultRoot
    expect(await listNames(app)).toEqual([]);
    db.close();
  });
});
