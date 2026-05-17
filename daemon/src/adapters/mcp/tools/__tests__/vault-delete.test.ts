import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createPermissionEngine } from "../../../../permissions/engine";
import { createVaultWriter } from "../../../../vault/writer";
import { makeVaultDelete } from "../vault-delete";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vos-108-del-")));
  mkdirSync(join(root, "journal"), { recursive: true });
  const db = new Database(":memory:");
  const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
  const writer = createVaultWriter({ vaultRoot: root, db });
  return { root, db, engine, writer };
}

describe("vault.delete", () => {
  it("removes the file when permitted", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "x");
    const h = makeVaultDelete({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/x.md" }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(existsSync(join(root, "journal/x.md"))).toBe(false);
  });

  it("denies out-of-scope — file still present", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "x");
    const h = makeVaultDelete({ vaultRoot: root, db, engine, writer, agent: { name: "maya", write_scope: [] } });
    const res = await h({ path: "journal/x.md" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^SCOPE_DENIED:/);
    expect(existsSync(join(root, "journal/x.md"))).toBe(true);
  });

  it("denies SYSTEM_DENY paths", async () => {
    const { root, db, engine, writer } = setup();
    mkdirSync(join(root, "agents"), { recursive: true });
    writeFileSync(join(root, "agents/foo.md"), "x");
    const h = makeVaultDelete({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "agents/foo.md" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^SCOPE_DENIED:/);
    expect(existsSync(join(root, "agents/foo.md"))).toBe(true);
  });

  it("NOT_FOUND on missing", async () => {
    const { root, db, engine, writer } = setup();
    const h = makeVaultDelete({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/missing.md" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^NOT_FOUND:/);
  });
});
