import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createPermissionEngine } from "../../../../permissions/engine";
import { createVaultWriter } from "../../../../vault/writer";
import { makeVaultCreate } from "../vault-create";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vos-108-create-")));
  mkdirSync(join(root, "journal"), { recursive: true });
  const db = new Database(":memory:");
  const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
  const writer = createVaultWriter({ vaultRoot: root, db });
  return { root, db, engine, writer };
}

describe("vault.create", () => {
  it("creates a file inside write_scope", async () => {
    const { root, db, engine, writer } = setup();
    const h = makeVaultCreate({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/journal/**"] } });
    const res = await h({ path: "journal/note.md", content: "hi" }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(readFileSync(join(root, "journal/note.md"), "utf8")).toBe("hi");
    expect((res.structuredContent as { bytes: number }).bytes).toBe(2);
  });

  it("denies out-of-scope write — file is NOT created", async () => {
    const { root, db, engine, writer } = setup();
    const h = makeVaultCreate({ vaultRoot: root, db, engine, writer, agent: { name: "maya", write_scope: [] } });
    const res = await h({ path: "journal/note.md", content: "hi" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^SCOPE_DENIED:/);
    expect(existsSync(join(root, "journal/note.md"))).toBe(false);
  });

  it("denies SYSTEM_DENY paths even with permissive write_scope", async () => {
    const { root, db, engine, writer } = setup();
    mkdirSync(join(root, "agents"), { recursive: true });
    const h = makeVaultCreate({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "agents/foo.md", content: "x" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^SCOPE_DENIED:/);
    expect(existsSync(join(root, "agents/foo.md"))).toBe(false);
  });

  it("returns FILE_EXISTS when target already exists", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/note.md"), "old");
    const h = makeVaultCreate({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/note.md", content: "new" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe("FILE_EXISTS: journal/note.md: already exists");
    expect(readFileSync(join(root, "journal/note.md"), "utf8")).toBe("old");
  });

  it("rejects absolute paths with PATH_MUST_BE_RELATIVE", async () => {
    const { root, db, engine, writer } = setup();
    const h = makeVaultCreate({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "/etc/passwd", content: "x" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^PATH_MUST_BE_RELATIVE:/);
  });

  it("rejects path traversal with PATH_ESCAPES_VAULT_ROOT", async () => {
    const { root, db, engine, writer } = setup();
    const h = makeVaultCreate({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "../escape.md", content: "x" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^PATH_ESCAPES_VAULT_ROOT:/);
  });
});
