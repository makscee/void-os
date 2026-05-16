import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { makeVaultRead, vaultReadDef } from "../../src/adapters/mcp/tools/vault-read";
import { createPermissionEngine, type AgentDefn } from "../../src/permissions/engine";

function fakeExtra(meta: Record<string, unknown> = {}) {
  return { _meta: meta } as any;
}

// VOS-106 T7.5: vault.read factory now requires `engine` + `agent` deps so it
// can apply the per-agent read-scope gate. Tests build a permissive engine
// rooted at the same vault tmpdir + a "test" agent that defaults to the
// engine's DEFAULT_READ_SCOPE (`vault/**`).
function makeDeps(vaultRoot: string, db: Database) {
  const engine = createPermissionEngine({ vaultRoot, homeRoot: "/tmp/home" });
  const agent: AgentDefn = { name: "test" };
  return { vaultRoot, db, engine, agent };
}

describe("vault-read factory", () => {
  it("vaultReadDef exposes Zod input shape (no JSON Schema literal)", () => {
    expect(vaultReadDef.inputSchema).toBeDefined();
    expect(typeof vaultReadDef.inputSchema).toBe("object");
    // Zod raw shape: each value is a ZodType
    const shape = vaultReadDef.inputSchema as Record<string, { _def?: unknown }>;
    expect(shape.path?._def).toBeDefined();
  });

  it("reads a file under vaultRoot and returns structuredContent", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vault-")));
    writeFileSync(join(root, "hello.md"), "# hi\n", "utf8");
    const db = new Database(":memory:");
    const handler = makeVaultRead(makeDeps(root, db));
    const out = await handler({ path: "hello.md" }, fakeExtra());
    expect(out.isError).toBeFalsy();
    expect((out.structuredContent as { path: string }).path).toBe("hello.md");
  });

  it("rejects absolute paths", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vault-")));
    const db = new Database(":memory:");
    const handler = makeVaultRead(makeDeps(root, db));
    const out = await handler({ path: "/etc/passwd" }, fakeExtra());
    expect(out.isError).toBe(true);
  });
});
