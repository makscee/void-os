import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createPermissionEngine } from "../../../../permissions/engine";
import { createVaultWriter } from "../../../../vault/writer";
import { makeVaultMove } from "../vault-move";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vos-108-move-")));
  mkdirSync(join(root, "a"), { recursive: true });
  mkdirSync(join(root, "b"), { recursive: true });
  const db = new Database(":memory:");
  const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
  const writer = createVaultWriter({ vaultRoot: root, db });
  return { root, db, engine, writer };
}

describe("vault.move triple-gate", () => {
  it("moves when all three gates pass", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "a/x.md"), "hi");
    const h = makeVaultMove({ vaultRoot: root, db, engine, writer, agent: { name: "j", read_scope: ["vault/**"], write_scope: ["vault/**"] } });
    const res = await h({ from: "a/x.md", to: "b/x.md" }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(existsSync(join(root, "a/x.md"))).toBe(false);
    expect(existsSync(join(root, "b/x.md"))).toBe(true);
  });

  it("denies when canRead(from) fails (read_scope excludes source)", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "b/x.md"), "hi");
    const h = makeVaultMove({
      vaultRoot: root, db, engine, writer,
      agent: { name: "j", read_scope: ["vault/a/**"], write_scope: ["vault/a/**", "vault/b/**"] },
    });
    const res = await h({ from: "b/x.md", to: "a/x.md" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^SCOPE_DENIED: b\/x\.md outside read_scope/);
    expect(existsSync(join(root, "b/x.md"))).toBe(true);
  });

  it("denies when canWrite(from) fails (write_scope excludes source)", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "b/x.md"), "hi");
    const h = makeVaultMove({
      vaultRoot: root, db, engine, writer,
      agent: { name: "j", read_scope: ["vault/**"], write_scope: ["vault/a/**"] },
    });
    const res = await h({ from: "b/x.md", to: "a/x.md" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^SCOPE_DENIED: b\/x\.md outside write_scope/);
    expect(existsSync(join(root, "b/x.md"))).toBe(true);
  });

  it("denies when canWrite(to) fails (write_scope excludes destination)", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "a/x.md"), "hi");
    const h = makeVaultMove({
      vaultRoot: root, db, engine, writer,
      agent: { name: "j", read_scope: ["vault/**"], write_scope: ["vault/a/**"] },
    });
    const res = await h({ from: "a/x.md", to: "b/x.md" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^SCOPE_DENIED: b\/x\.md outside write_scope/);
    expect(existsSync(join(root, "a/x.md"))).toBe(true);
  });

  it("NOT_FOUND when source missing", async () => {
    const { root, db, engine, writer } = setup();
    const h = makeVaultMove({ vaultRoot: root, db, engine, writer, agent: { name: "j", read_scope: ["vault/**"], write_scope: ["vault/**"] } });
    const res = await h({ from: "a/missing.md", to: "b/x.md" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^NOT_FOUND:/);
  });

  it("FILE_EXISTS when destination exists", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "a/x.md"), "src");
    writeFileSync(join(root, "b/x.md"), "dst");
    const h = makeVaultMove({ vaultRoot: root, db, engine, writer, agent: { name: "j", read_scope: ["vault/**"], write_scope: ["vault/**"] } });
    const res = await h({ from: "a/x.md", to: "b/x.md" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^FILE_EXISTS:/);
    expect(existsSync(join(root, "a/x.md"))).toBe(true);
  });
});
