import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { makeVaultRead } from "../vault-read";
import { createPermissionEngine } from "../../../../permissions/engine";

function makeVault(): { root: string; db: Database } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vos-106-vread-")));
  mkdirSync(join(root, "journal"), { recursive: true });
  mkdirSync(join(root, "work", "tasks", "active"), { recursive: true });
  writeFileSync(join(root, "journal", "2026-05-16.md"), "today");
  writeFileSync(join(root, "work", "tasks", "active", "X.md"), "secret");
  const db = new Database(":memory:");
  return { root, db };
}

describe("vault.read with scope gate", () => {
  it("allows path inside read_scope", async () => {
    const { root, db } = makeVault();
    const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
    const handler = makeVaultRead({
      vaultRoot: root,
      db,
      engine,
      agent: { name: "journaler", read_scope: ["vault/journal/**"] },
    });
    const res = await handler({ path: "journal/2026-05-16.md" }, {} as never);
    expect(res.isError).toBeFalsy();
  });

  it("denies path outside read_scope", async () => {
    const { root, db } = makeVault();
    const engine = createPermissionEngine({ vaultRoot: root, homeRoot: "/tmp/home" });
    const handler = makeVaultRead({
      vaultRoot: root,
      db,
      engine,
      agent: { name: "journaler", read_scope: ["vault/journal/**"] },
    });
    const res = await handler({ path: "work/tasks/active/X.md" }, {} as never);
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^SCOPE_DENIED:/);
  });
});
