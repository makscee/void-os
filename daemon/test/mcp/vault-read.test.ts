import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { makeVaultRead, vaultReadDef } from "../../src/adapters/mcp/tools/vault-read";

function fakeExtra(meta: Record<string, unknown> = {}) {
  return { _meta: meta } as any;
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
    const handler = makeVaultRead({ vaultRoot: root, db });
    const out = await handler({ path: "hello.md" }, fakeExtra());
    expect(out.isError).toBeFalsy();
    expect((out.structuredContent as { path: string }).path).toBe("hello.md");
  });

  it("rejects absolute paths", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vault-")));
    const db = new Database(":memory:");
    const handler = makeVaultRead({ vaultRoot: root, db });
    const out = await handler({ path: "/etc/passwd" }, fakeExtra());
    expect(out.isError).toBe(true);
  });
});
