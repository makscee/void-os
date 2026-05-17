import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditVaultProjectSettings } from "../src/boot/audit-project-settings";

describe("VOS-111: vault project-settings audit", () => {
  test("logs a warning when <vaultRoot>/.claude/settings.json exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "vos-111-audit-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", "settings.json"), "{}");
      const logged: string[] = [];
      auditVaultProjectSettings(dir, (msg) => logged.push(msg));
      expect(logged.length).toBe(1);
      expect(logged[0]).toContain(".claude/settings.json");
      expect(logged[0]).toContain("loaded by --setting-sources project");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("silent when no project settings file present", () => {
    const dir = mkdtempSync(join(tmpdir(), "vos-111-audit-"));
    try {
      const logged: string[] = [];
      auditVaultProjectSettings(dir, (msg) => logged.push(msg));
      expect(logged).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
