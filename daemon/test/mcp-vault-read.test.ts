import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Database } from "bun:sqlite";
import { handleVaultRead, vaultReadDef } from "../src/adapters/mcp/tools/vault-read.ts";

// Mirrors daemon/src/adapters/sqlite/migrations/0001_init.sql
const SCHEMA = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, chat_id TEXT, run_id TEXT, agent TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
);
`;

interface Ctx { vaultRoot: string; db: Database; cleanup: () => void; }

function mkVault(): Ctx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-"));
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return {
    vaultRoot: fs.realpathSync(root),
    db,
    cleanup: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

describe("vault.read tool", () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = mkVault(); });

  test("definition shape", () => {
    expect(vaultReadDef.name).toBe("vault.read");
    expect(vaultReadDef.inputSchema.required).toEqual(["path"]);
  });

  test("returns content + sha for an existing file", async () => {
    fs.mkdirSync(path.join(ctx.vaultRoot, "notes"));
    fs.writeFileSync(path.join(ctx.vaultRoot, "notes", "x.md"), "hello world");
    const out = await handleVaultRead({ path: "notes/x.md" }, { vaultRoot: ctx.vaultRoot, db: ctx.db });
    expect(out.isError).toBeFalsy();
    expect(out.content[0]).toMatchObject({ type: "text", text: "hello world" });
    expect(out.structuredContent!.path).toBe("notes/x.md");
    expect(out.structuredContent!.sha).toMatch(/^[a-f0-9]{64}$/);
    expect(out.structuredContent!.bytes).toBe(11);
    const row = ctx.db.prepare(
      "SELECT type, data FROM events WHERE type='mcp.vault.read'",
    ).get() as { type: string; data: string };
    expect(row.type).toBe("mcp.vault.read");
    expect(JSON.parse(row.data).ok).toBe(true);
    ctx.cleanup();
  });

  test("rejects path that escapes the vault root", async () => {
    const out = await handleVaultRead({ path: "../etc/passwd" }, { vaultRoot: ctx.vaultRoot, db: ctx.db });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("PATH_ESCAPES_VAULT_ROOT");
    const data = JSON.parse(
      (ctx.db.prepare("SELECT data FROM events").get() as { data: string }).data,
    );
    expect(data.ok).toBe(false);
    expect(data.error_code).toBe("PATH_ESCAPES_VAULT_ROOT");
    ctx.cleanup();
  });

  test("rejects absolute path with PATH_MUST_BE_RELATIVE", async () => {
    const out = await handleVaultRead({ path: "/etc/passwd" }, { vaultRoot: ctx.vaultRoot, db: ctx.db });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("PATH_MUST_BE_RELATIVE");
    ctx.cleanup();
  });

  test("missing file → ENOENT", async () => {
    const out = await handleVaultRead({ path: "missing.md" }, { vaultRoot: ctx.vaultRoot, db: ctx.db });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("ENOENT");
    ctx.cleanup();
  });

  test("directory → NOT_A_FILE", async () => {
    fs.mkdirSync(path.join(ctx.vaultRoot, "a-dir"));
    const out = await handleVaultRead({ path: "a-dir" }, { vaultRoot: ctx.vaultRoot, db: ctx.db });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("NOT_A_FILE");
    ctx.cleanup();
  });
});
