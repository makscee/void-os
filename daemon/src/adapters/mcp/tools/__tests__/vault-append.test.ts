import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createPermissionEngine } from "../../../../permissions/engine";
import { createVaultWriter } from "../../../../vault/writer";
import { makeVaultAppend } from "../vault-append";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vos-108-append-")));
  mkdirSync(join(root, "journal"), { recursive: true });
  const db = new Database(":memory:");
  const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
  const writer = createVaultWriter({ vaultRoot: root, db });
  return { root, db, engine, writer };
}

describe("vault.append", () => {
  it("appends to file end when section omitted", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "head\n");
    const h = makeVaultAppend({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/x.md", content: "tail" }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(readFileSync(join(root, "journal/x.md"), "utf8")).toContain("head");
    expect(readFileSync(join(root, "journal/x.md"), "utf8")).toContain("tail");
  });

  it("appends under section when section provided", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "# Top\n\n## Log\n\n## Other\n");
    const h = makeVaultAppend({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/x.md", content: "entry1", section: "Log" }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(readFileSync(join(root, "journal/x.md"), "utf8")).toMatch(/## Log[\s\S]*entry1[\s\S]*## Other/);
  });

  it("denies out-of-scope — file unchanged", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "head\n");
    const h = makeVaultAppend({ vaultRoot: root, db, engine, writer, agent: { name: "maya", write_scope: [] } });
    const res = await h({ path: "journal/x.md", content: "tail" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^SCOPE_DENIED:/);
    expect(readFileSync(join(root, "journal/x.md"), "utf8")).toBe("head\n");
  });

  it("returns NOT_FOUND when file is missing", async () => {
    const { root, db, engine, writer } = setup();
    const h = makeVaultAppend({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/missing.md", content: "x" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe("NOT_FOUND: journal/missing.md: not found");
  });

  it("returns SECTION_NOT_FOUND when section absent", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "# Top\n");
    const h = makeVaultAppend({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/x.md", content: "x", section: "Missing" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe("SECTION_NOT_FOUND: journal/x.md: section Missing not found");
  });
});
