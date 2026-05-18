// VOS-92 T1.2: scanVaultAgents reads vault/agents/<name>/agent.md files,
// parses frontmatter, returns AgentRow[]. Skips malformed entries
// (missing required field, folder/name mismatch) without throwing.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanVaultAgents } from "../scan";

function makeVault(): string {
  return mkdtempSync(join(tmpdir(), "vault-"));
}

function writeAgent(
  vault: string,
  folder: string,
  frontmatter: Record<string, string> | string,
  body = "you are an agent\n",
) {
  const dir = join(vault, "agents", folder);
  mkdirSync(dir, { recursive: true });
  let fm: string;
  if (typeof frontmatter === "string") {
    fm = frontmatter;
  } else {
    fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  }
  writeFileSync(join(dir, "agent.md"), `---\n${fm}\n---\n${body}`);
}

describe("scanVaultAgents", () => {
  test("empty vault/agents/ returns []", () => {
    const vault = makeVault();
    expect(scanVaultAgents(vault)).toEqual([]);
    rmSync(vault, { recursive: true, force: true });
  });

  test("reads two valid agents with all required fields", () => {
    const vault = makeVault();
    writeAgent(vault, "maya", { name: "maya", description: "front desk", model: "opus" });
    writeAgent(vault, "journaler", { name: "journaler", description: "journal helper", model: "haiku" });

    const rows = scanVaultAgents(vault);
    expect(rows.length).toBe(2);
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(["journaler", "maya"]);

    const maya = rows.find((r) => r.name === "maya")!;
    expect(maya.description).toBe("front desk");
    expect(maya.model).toBe("opus");
    expect(maya.vault_path.endsWith("/agents/maya/agent.md")).toBe(true);
    expect(typeof maya.updated_at).toBe("number");
    expect(maya.updated_at).toBeGreaterThan(0);

    rmSync(vault, { recursive: true, force: true });
  });

  test("skips file missing required `description` field", () => {
    const vault = makeVault();
    writeAgent(vault, "good", { name: "good", description: "ok", model: "opus" });
    writeAgent(vault, "bad", { name: "bad", model: "opus" });

    const warn = spyWarn();
    try {
      const rows = scanVaultAgents(vault);
      expect(rows.map((r) => r.name)).toEqual(["good"]);
      expect(warn.calls.some((c) => c.includes("bad"))).toBe(true);
    } finally {
      warn.restore();
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("skips folder where folder name ≠ frontmatter `name`", () => {
    const vault = makeVault();
    writeAgent(vault, "journaler", { name: "imposter", description: "x", model: "opus" });

    const warn = spyWarn();
    try {
      const rows = scanVaultAgents(vault);
      expect(rows).toEqual([]);
      expect(warn.calls.some((c) => /journaler/.test(c) && /imposter/.test(c))).toBe(true);
    } finally {
      warn.restore();
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("ignores folders without agent.md", () => {
    const vault = makeVault();
    mkdirSync(join(vault, "agents", "empty"), { recursive: true });
    expect(scanVaultAgents(vault)).toEqual([]);
    rmSync(vault, { recursive: true, force: true });
  });

  // VOS-124 T6: boot-time scan warn when 0 agents found
  test("emits console.warn when agents dir is missing (0 agents)", () => {
    const vault = makeVault(); // no agents/ dir
    const warn = spyWarn();
    try {
      const rows = scanVaultAgents(vault);
      expect(rows).toEqual([]);
      expect(warn.calls.length).toBeGreaterThan(0);
      const msg = warn.calls.join(" ");
      expect(msg).toContain("agents/scan:");
      expect(msg).toContain("0 agents found under");
      expect(msg).toContain(vault + "/agents");
    } finally {
      warn.restore();
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("emits console.warn when agents dir is empty (0 agents)", () => {
    const vault = makeVault();
    mkdirSync(join(vault, "agents"), { recursive: true }); // empty dir
    const warn = spyWarn();
    try {
      const rows = scanVaultAgents(vault);
      expect(rows).toEqual([]);
      expect(warn.calls.length).toBeGreaterThan(0);
      const msg = warn.calls.join(" ");
      expect(msg).toContain("agents/scan:");
      expect(msg).toContain("0 agents found under");
      expect(msg).toContain(vault + "/agents");
    } finally {
      warn.restore();
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("does NOT emit scan-empty warn when agents are found", () => {
    const vault = makeVault();
    writeAgent(vault, "maya", { name: "maya", description: "front desk", model: "opus" });
    const warn = spyWarn();
    try {
      const rows = scanVaultAgents(vault);
      expect(rows.length).toBe(1);
      const scanEmptyWarns = warn.calls.filter((c) => c.includes("agents/scan:") && c.includes("0 agents found"));
      expect(scanEmptyWarns).toEqual([]);
    } finally {
      warn.restore();
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

function spyWarn() {
  const original = console.warn;
  const calls: string[] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args.map(String).join(" "));
  };
  return {
    calls,
    restore: () => {
      console.warn = original;
    },
  };
}
