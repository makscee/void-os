// VOS-92 T2.1: GET /agents — list of AgentListEntry, alphabetical.
// VOS-152: dropped the "maya first" sort rule (it leaked a hardcoded persona
// name into the picker UI even when the vault shipped no maya agent). The
// 0014_drop_maya_seed migration also removes the placeholder seed from
// migration 0008, so a freshly-migrated DB now returns `{ agents: [] }`
// instead of a phantom maya entry.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../adapters/sqlite/migrations";
import { makeAgentRepo } from "../../agents/repo";
import { agentsApi } from "../agents";
import type { AgentRow } from "../../agents/types";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "adapters", "sqlite", "migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  return db;
}

function makeApp(db: Database): Hono {
  const app = new Hono();
  app.route("/", agentsApi(db));
  return app;
}

function row(name: string, description = `${name} desc`): AgentRow {
  return { name, description, model: "opus", vault_path: `/x/${name}.md`, updated_at: 1 };
}

// VOS-90 T8 (historical): migration 0008 used to seed a default `maya`
// agent for the picker. VOS-152 added migration 0014_drop_maya_seed which
// removes that placeholder immediately after 0008 runs, so a freshly-
// migrated DB is already empty. `clearAgents` is now defensive — it stays
// to guard against any future seeds and to keep test intent explicit.
function clearAgents(db: Database) {
  db.exec("DELETE FROM agents");
}

describe("GET /agents", () => {
  test("empty repo → { agents: [] }", async () => {
    const db = freshDb();
    clearAgents(db);
    const app = makeApp(db);
    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ agents: [] });
    db.close();
  });

  test("returns {name, description} entries in alphabetical order", async () => {
    const db = freshDb();
    clearAgents(db);
    const repo = makeAgentRepo(db);
    repo.upsertAll([row("zeta"), row("journaler"), row("maya"), row("alpha")]);

    const app = makeApp(db);
    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: Array<{ name: string; description: string }> };

    // VOS-152: pure alphabetical — no maya-first special case.
    expect(body.agents.map((a) => a.name)).toEqual(["alpha", "journaler", "maya", "zeta"]);
    expect(body.agents[0]).toEqual({ name: "alpha", description: "alpha desc" });
    // model field MUST NOT be exposed
    expect((body.agents[0] as Record<string, unknown>).model).toBeUndefined();
    db.close();
  });

  test("alphabetical regardless of insert order", async () => {
    const db = freshDb();
    clearAgents(db);
    const repo = makeAgentRepo(db);
    repo.upsertAll([row("zeta"), row("alpha")]);

    const app = makeApp(db);
    const res = await app.request("/agents");
    const body = await res.json() as { agents: Array<{ name: string }> };
    expect(body.agents.map((a) => a.name)).toEqual(["alpha", "zeta"]);
    db.close();
  });

  test("VOS-152: fresh DB has NO seeded maya (0014 drops the placeholder)", async () => {
    const db = freshDb();
    const app = makeApp(db);
    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: Array<{ name: string; description: string }> };
    // The 0008 seed is dropped by 0014_drop_maya_seed; a freshly-migrated
    // DB is empty until scanVaultAgents populates it from vaultRoot.
    expect(body.agents).toEqual([]);
    db.close();
  });
});
