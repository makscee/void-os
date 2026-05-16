// VOS-92 T2.1: GET /agents — list of AgentListEntry, maya-first then alphabetical.

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

// VOS-90 T8: migration 0008 seeds a default `maya` agent so the plugin
// picker has a fallback option on a fresh install. Tests that need a
// "blank slate" must DELETE the seed before asserting.
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

  test("returns {name, description} entries, maya first then alphabetical", async () => {
    const db = freshDb();
    clearAgents(db);
    const repo = makeAgentRepo(db);
    repo.upsertAll([row("zeta"), row("journaler"), row("maya"), row("alpha")]);

    const app = makeApp(db);
    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: Array<{ name: string; description: string }> };

    expect(body.agents.map((a) => a.name)).toEqual(["maya", "alpha", "journaler", "zeta"]);
    expect(body.agents[0]).toEqual({ name: "maya", description: "maya desc" });
    // model field MUST NOT be exposed
    expect((body.agents[0] as Record<string, unknown>).model).toBeUndefined();
    db.close();
  });

  test("maya absent → alphabetical only", async () => {
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

  test("fresh DB has seeded maya (migration 0008)", async () => {
    const db = freshDb();
    const app = makeApp(db);
    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: Array<{ name: string; description: string }> };
    expect(body.agents.map((a) => a.name)).toEqual(["maya"]);
    db.close();
  });
});
