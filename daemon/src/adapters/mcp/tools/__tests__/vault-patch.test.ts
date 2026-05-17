import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createPermissionEngine } from "../../../../permissions/engine";
import { createVaultWriter } from "../../../../vault/writer";
import { makeVaultPatch } from "../vault-patch";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vos-108-patch-")));
  mkdirSync(join(root, "journal"), { recursive: true });
  const db = new Database(":memory:");
  const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
  const writer = createVaultWriter({ vaultRoot: root, db });
  return { root, db, engine, writer };
}

describe("vault.patch", () => {
  it("replaces unique old_string with new_string", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "alpha\nbeta\ngamma\n");
    const h = makeVaultPatch({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/x.md", old_string: "beta", new_string: "BETA" }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(readFileSync(join(root, "journal/x.md"), "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("OLD_STRING_NOT_FOUND when string absent", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "alpha\n");
    const h = makeVaultPatch({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/x.md", old_string: "missing", new_string: "X" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe("OLD_STRING_NOT_FOUND: journal/x.md: old_string not found");
  });

  it("OLD_STRING_NOT_UNIQUE when string matches twice", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "x\nx\n");
    const h = makeVaultPatch({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/x.md", old_string: "x", new_string: "y" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe("OLD_STRING_NOT_UNIQUE: journal/x.md: old_string not unique");
  });

  it("denies out-of-scope", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "alpha\n");
    const h = makeVaultPatch({ vaultRoot: root, db, engine, writer, agent: { name: "maya", write_scope: [] } });
    const res = await h({ path: "journal/x.md", old_string: "alpha", new_string: "x" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^SCOPE_DENIED:/);
    expect(readFileSync(join(root, "journal/x.md"), "utf8")).toBe("alpha\n");
  });

  it("NOT_FOUND on missing file", async () => {
    const { root, db, engine, writer } = setup();
    const h = makeVaultPatch({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/missing.md", old_string: "a", new_string: "b" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^NOT_FOUND:/);
  });
});
