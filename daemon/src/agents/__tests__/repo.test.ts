// VOS-92 T1.4: makeAgentRepo.upsertAll + list against a real :memory: db
// with migrations applied. Mirrors the cost.test.ts pattern.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../adapters/sqlite/migrations";
import { makeAgentRepo } from "../repo";
import type { AgentRow } from "../types";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "adapters", "sqlite", "migrations");

function freshDb(): Database {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  return db;
}

function row(name: string, description = "d", model = "opus"): AgentRow {
  return {
    name,
    description,
    model,
    vault_path: `/tmp/vault/agents/${name}/agent.md`,
    updated_at: Date.now(),
  };
}

describe("makeAgentRepo", () => {
  test("upsertAll inserts new rows; list returns them", () => {
    const db = freshDb();
    const repo = makeAgentRepo(db);
    repo.upsertAll([row("maya"), row("journaler")]);
    const got = repo.list().map((r) => r.name).sort();
    expect(got).toEqual(["journaler", "maya"]);
    db.close();
  });

  test("upsertAll on existing PK updates fields, total count unchanged", () => {
    const db = freshDb();
    const repo = makeAgentRepo(db);
    repo.upsertAll([row("maya", "v1")]);
    repo.upsertAll([row("maya", "v2")]);
    const got = repo.list();
    expect(got.length).toBe(1);
    expect(got[0]!.description).toBe("v2");
    db.close();
  });

  test("upsertAll on empty array is a no-op", () => {
    const db = freshDb();
    const repo = makeAgentRepo(db);
    repo.upsertAll([row("maya")]);
    repo.upsertAll([]);
    expect(repo.list().length).toBe(1);
    db.close();
  });

  test("upsertAll runs in a single transaction — partial failure leaves prior rows intact", () => {
    const db = freshDb();
    const repo = makeAgentRepo(db);
    repo.upsertAll([row("maya")]);
    // Force a failure mid-transaction by passing a NULL `name` (PK NOT NULL).
    const bad = { ...row("oops"), name: null as unknown as string };
    expect(() => repo.upsertAll([row("journaler"), bad])).toThrow();
    // journaler must NOT have been inserted — transaction rolled back.
    const names = repo.list().map((r) => r.name).sort();
    expect(names).toEqual(["maya"]);
    db.close();
  });

  test("list returns [] when no rows", () => {
    const db = freshDb();
    // VOS-90 T8: migration 0008 seeds a default `maya` row. Clear it so this
    // test exercises the truly-empty path that AgentRepo.list() must handle.
    db.exec("DELETE FROM agents");
    const repo = makeAgentRepo(db);
    expect(repo.list()).toEqual([]);
    db.close();
  });
});
