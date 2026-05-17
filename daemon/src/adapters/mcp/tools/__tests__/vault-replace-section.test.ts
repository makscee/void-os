import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createPermissionEngine } from "../../../../permissions/engine";
import { createVaultWriter } from "../../../../vault/writer";
import { makeVaultReplaceSection } from "../vault-replace-section";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vos-108-replace-")));
  mkdirSync(join(root, "journal"), { recursive: true });
  const db = new Database(":memory:");
  const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
  const writer = createVaultWriter({ vaultRoot: root, db });
  return { root, db, engine, writer };
}

describe("vault.replace_section", () => {
  it("swaps section body when permitted", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "## Log\n\nold\n\n## End\n");
    const h = makeVaultReplaceSection({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/x.md", section: "Log", content: "new" }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(readFileSync(join(root, "journal/x.md"), "utf8")).toMatch(/## Log\s+new\s+\n## End/);
  });

  it("denies out-of-scope — file unchanged", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "## Log\n\nold\n");
    const before = readFileSync(join(root, "journal/x.md"), "utf8");
    const h = makeVaultReplaceSection({ vaultRoot: root, db, engine, writer, agent: { name: "maya", write_scope: [] } });
    const res = await h({ path: "journal/x.md", section: "Log", content: "new" }, {} as never);
    expect(res.isError).toBe(true);
    expect(readFileSync(join(root, "journal/x.md"), "utf8")).toBe(before);
  });

  it("returns SECTION_NOT_FOUND", async () => {
    const { root, db, engine, writer } = setup();
    writeFileSync(join(root, "journal/x.md"), "## Other\n");
    const h = makeVaultReplaceSection({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/x.md", section: "Log", content: "new" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe("SECTION_NOT_FOUND: journal/x.md: section Log not found");
  });

  it("returns NOT_FOUND when file missing", async () => {
    const { root, db, engine, writer } = setup();
    const h = makeVaultReplaceSection({ vaultRoot: root, db, engine, writer, agent: { name: "j", write_scope: ["vault/**"] } });
    const res = await h({ path: "journal/missing.md", section: "Log", content: "new" }, {} as never);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^NOT_FOUND:/);
  });
});
