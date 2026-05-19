import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeVaultLoadTemplate } from "../vault-load-template";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vos-131-tpl-tool-"));
  mkdirSync(join(root, "_templates"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function seed(name: string, body: string): void {
  writeFileSync(join(root, "_templates", `${name}.md`), body);
}

describe("vault.load_template", () => {
  it("inspect mode (no context) returns raw + slot inventory", async () => {
    seed("daily", "# {{date}}\n\n{{mood}}\n");
    const h = makeVaultLoadTemplate({ vaultRoot: root });
    const res = await h({ name: "daily" });
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).toBe("# {{date}}\n\n{{mood}}\n");
    const sc = res.structuredContent as {
      name: string;
      path: string;
      slots: string[];
    };
    expect(sc.name).toBe("daily");
    expect(sc.path).toBe("_templates/daily.md");
    expect(sc.slots).toEqual(["date", "mood"]);
  });

  it("render mode substitutes context values", async () => {
    seed("daily", "# {{date}}\n");
    const h = makeVaultLoadTemplate({ vaultRoot: root });
    const res = await h({ name: "daily", context: { date: "2026-05-19" } });
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).toBe("# 2026-05-19\n");
    const sc = res.structuredContent as { rendered: string };
    expect(sc.rendered).toBe("# 2026-05-19\n");
  });

  it("TEMPLATE_NOT_FOUND for missing template", async () => {
    const h = makeVaultLoadTemplate({ vaultRoot: root });
    const res = await h({ name: "missing" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^TEMPLATE_NOT_FOUND:/);
  });

  it("MISSING_SLOT when context omits a referenced slot", async () => {
    seed("daily", "# {{date}}\n{{mood}}");
    const h = makeVaultLoadTemplate({ vaultRoot: root });
    const res = await h({ name: "daily", context: { date: "x" } });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^MISSING_SLOT:/);
    expect((res.content[0] as { text: string }).text).toContain("mood");
  });

  it("allow_missing renders empty for absent slots", async () => {
    seed("daily", "# {{date}}\n{{mood}}");
    const h = makeVaultLoadTemplate({ vaultRoot: root });
    const res = await h({
      name: "daily",
      context: { date: "x" },
      allow_missing: true,
    });
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).toBe("# x\n");
  });

  it("MALFORMED_TEMPLATE for unclosed `{{`", async () => {
    seed("bad", "Hello {{name");
    const h = makeVaultLoadTemplate({ vaultRoot: root });
    const res = await h({ name: "bad" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^MALFORMED_TEMPLATE:/);
  });

  it("rejects path traversal in name", async () => {
    const h = makeVaultLoadTemplate({ vaultRoot: root });
    const res = await h({ name: "../escape" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^TEMPLATE_NOT_FOUND:/);
  });
});
