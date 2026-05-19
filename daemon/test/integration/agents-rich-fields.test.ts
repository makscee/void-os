// VOS-153 Task 3: integration test for the rich-fields agent flow.
//
// Scope: scan a fixture vault (real frontmatter on disk) → upsertAll into
// a freshly-migrated :memory: db → mount agentsApi on a bare Hono app →
// GET /agents and assert color/avatar/tagline travel end-to-end.
//
// The chat-lifecycle tests bootstrap a full `buildApp` because they need
// orchestrator/titler/MCP wiring. The agents flow only touches the
// scan → repo → /agents pipeline, so we mount just `agentsApi(db)` and
// drive it via `app.request("/agents")` — no daemon-wide boot helper
// (which doesn't exist yet) is required, and the test stays hermetic.
//
// Fixture layout:
//   daemon/test/fixtures/agents/rich/maya/agent.md     — full frontmatter
//   daemon/test/fixtures/agents/sparse/plain/agent.md  — no rich fields
//
// scanVaultAgents expects vault root containing an `agents/` directory,
// so the fixture root we pass is the parent of the relevant agents dir.

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { join } from "node:path";
import { runMigrationsFromDir } from "../../src/adapters/sqlite/migrations";
import { scanVaultAgents } from "../../src/agents/scan";
import { makeAgentRepo } from "../../src/agents/repo";
import { agentsApi } from "../../src/api/agents";

const MIGRATIONS_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "adapters",
  "sqlite",
  "migrations",
);
const FIXTURES_ROOT = join(import.meta.dir, "..", "fixtures", "agents");

function bootWithFixture(fixture: "rich" | "sparse"): { app: Hono; db: Database } {
  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS_DIR);
  // Fresh DB: 0014 already strips the placeholder maya seed, so the
  // table starts empty and the only rows in it come from our fixture.
  const vaultRoot = join(FIXTURES_ROOT, fixture);
  const rows = scanVaultAgents(vaultRoot);
  makeAgentRepo(db).upsertAll(rows);
  const app = new Hono();
  app.route("/", agentsApi(db));
  return { app, db };
}

test("GET /agents returns color/avatar/tagline when present in frontmatter", async () => {
  const { app, db } = bootWithFixture("rich");
  try {
    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    const maya = body.agents.find((a) => a.name === "maya");
    expect(maya).toBeDefined();
    expect(maya!.color).toBe("#5a8fd4");
    expect(maya!.avatar).toBe("🔬");
    expect(maya!.tagline).toBe("Curious. Skeptical. Reads the footnotes.");
    expect(maya!.description).toBe("researcher — finds and summarizes sources");
  } finally {
    db.close();
  }
});

test("GET /agents omits new fields when frontmatter lacks them (backwards compat)", async () => {
  const { app, db } = bootWithFixture("sparse");
  try {
    const res = await app.request("/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    const plain = body.agents.find((a) => a.name === "plain");
    expect(plain).toBeDefined();
    // undefined → JSON.stringify drops the key entirely. Assert that
    // the keys are absent, not just falsy, so the wire shape stays
    // identical to pre-VOS-153 consumers.
    expect("color" in plain!).toBe(false);
    expect("avatar" in plain!).toBe(false);
    expect("tagline" in plain!).toBe(false);
  } finally {
    db.close();
  }
});
