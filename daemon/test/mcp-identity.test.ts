import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { runMigrationsFromDir } from "../src/adapters/sqlite/migrations";
import { mountMcp } from "../src/adapters/mcp";
import { createEventBus } from "../src/events";
import { createAskUserBridge } from "../src/chat/ask-user-bridge";
import { createPermissionEngine } from "../src/permissions/engine";

const MIGRATIONS = join(import.meta.dir, "..", "src", "adapters", "sqlite", "migrations");

function makeFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vos-106-mcp-id-")));
  mkdirSync(join(root, "journal"), { recursive: true });
  mkdirSync(join(root, "work"), { recursive: true });
  writeFileSync(join(root, "journal", "x.md"), "j");
  writeFileSync(join(root, "work", "x.md"), "w");

  const db = new Database(":memory:");
  runMigrationsFromDir(db, MIGRATIONS);
  db.run(
    "INSERT INTO agent_cards (agent_name, card_json, source_mtime) VALUES (?, ?, 0)",
    [
      "journaler",
      JSON.stringify({ name: "journaler", read_scope: ["vault/journal/**"] }),
    ],
  );
  return { root, db };
}

async function callVaultRead(app: Hono, agent: string, path: string) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "vault.read", arguments: { path } },
  };
  const res = await app.request(`/mcp?agent=${agent}&run=test-run`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  });
  return res;
}

describe("mountMcp identity from URL query", () => {
  it("vault.read for journaler on journal path: allow", async () => {
    const { root, db } = makeFixture();
    const bus = createEventBus({ db });
    const bridge = createAskUserBridge({ db, bus });
    const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
    const app = new Hono();
    mountMcp(app, { vaultRoot: root, db, bus, bridge, engine });
    const res = await callVaultRead(app, "journaler", "journal/x.md");
    expect(res.status).toBe(200);
  });

  it("vault.read for journaler on work path: SCOPE_DENIED", async () => {
    const { root, db } = makeFixture();
    const bus = createEventBus({ db });
    const bridge = createAskUserBridge({ db, bus });
    const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
    const app = new Hono();
    mountMcp(app, { vaultRoot: root, db, bus, bridge, engine });
    const res = await callVaultRead(app, "journaler", "work/x.md");
    const txt = await res.text();
    expect(txt).toMatch(/SCOPE_DENIED/);
  });
});
