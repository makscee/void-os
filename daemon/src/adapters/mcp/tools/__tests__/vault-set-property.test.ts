import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createPermissionEngine } from "../../../../permissions/engine";
import { createVaultWriter } from "../../../../vault/writer";
import { makeVaultSetProperty } from "../vault-set-property";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vos-108-prop-")));
  mkdirSync(join(root, "journal"), { recursive: true });
  const db = new Database(":memory:");
  const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
  const writer = createVaultWriter({ vaultRoot: root, db });
  return { root, db, engine, writer };
}

describe("vault.set_property", () => {
  it("sets a string property on existing frontmatter", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "---\ntitle: old\n---\nbody\n");
    const h = makeVaultSetProperty({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/x.md", property: "title", value: "new" }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(readFileSync(join(root, "journal/x.md"), "utf8")).toContain("title: new");
  });

  it("sets array values", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "---\ntags: []\n---\nbody\n");
    const h = makeVaultSetProperty({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/x.md", property: "tags", value: ["a", "b"] }, {} as never);
    expect(res.isError).toBeFalsy();
  });

  it("denies out-of-scope", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "---\nt: x\n---\n");
    const h = makeVaultSetProperty({ vaultRoot: root, db, engine, writer, agent: { name: "maya", write_scope: [] } });
    const res = await h({ path: "journal/x.md", property: "t", value: "y" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^SCOPE_DENIED:/);
  });

  it("NOT_FOUND on missing file", async () => {
    const { root, db, engine, writer } = setup();
    const h = makeVaultSetProperty({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/missing.md", property: "t", value: "y" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^NOT_FOUND:/);
  });
});
