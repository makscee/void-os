import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Database } from "bun:sqlite";
import { makeVaultRead, vaultReadDef } from "../src/adapters/mcp/tools/vault-read.ts";

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

function fakeExtra() {
  return { _meta: {} } as any;
}

describe("vault.read tool", () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = mkVault(); });

  test("definition shape", () => {
    // VOS-97: vaultReadDef now exposes a Zod raw shape; no JSON Schema literal.
    expect(vaultReadDef.inputSchema).toBeDefined();
    const shape = vaultReadDef.inputSchema as Record<string, { _def?: unknown }>;
    expect(shape.path?._def).toBeDefined();
  });

  test("returns content + sha for an existing file", async () => {
    fs.mkdirSync(path.join(ctx.vaultRoot, "notes"));
    fs.writeFileSync(path.join(ctx.vaultRoot, "notes", "x.md"), "hello world");
    const handler = makeVaultRead({ vaultRoot: ctx.vaultRoot, db: ctx.db });
    const out = await handler({ path: "notes/x.md" }, fakeExtra());
    expect(out.isError).toBeFalsy();
    expect((out.content[0] as { type: string; text: string })).toMatchObject({ type: "text", text: "hello world" });
    const sc = out.structuredContent as { path: string; sha: string; bytes: number };
    expect(sc.path).toBe("notes/x.md");
    expect(sc.sha).toMatch(/^[a-f0-9]{64}$/);
    expect(sc.bytes).toBe(11);
    // VOS-83: events persistence removed; vault.read no longer records rows.
    ctx.cleanup();
  });

  test("rejects path that escapes the vault root", async () => {
    const handler = makeVaultRead({ vaultRoot: ctx.vaultRoot, db: ctx.db });
    const out = await handler({ path: "../etc/passwd" }, fakeExtra());
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("PATH_ESCAPES_VAULT_ROOT");
    // VOS-83: events persistence removed; error path no longer records rows.
    ctx.cleanup();
  });

  test("rejects absolute path with PATH_MUST_BE_RELATIVE", async () => {
    const handler = makeVaultRead({ vaultRoot: ctx.vaultRoot, db: ctx.db });
    const out = await handler({ path: "/etc/passwd" }, fakeExtra());
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("PATH_MUST_BE_RELATIVE");
    ctx.cleanup();
  });

  test("missing file → ENOENT", async () => {
    const handler = makeVaultRead({ vaultRoot: ctx.vaultRoot, db: ctx.db });
    const out = await handler({ path: "missing.md" }, fakeExtra());
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("ENOENT");
    ctx.cleanup();
  });

  test("directory → NOT_A_FILE", async () => {
    fs.mkdirSync(path.join(ctx.vaultRoot, "a-dir"));
    const handler = makeVaultRead({ vaultRoot: ctx.vaultRoot, db: ctx.db });
    const out = await handler({ path: "a-dir" }, fakeExtra());
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("NOT_A_FILE");
    ctx.cleanup();
  });
});
