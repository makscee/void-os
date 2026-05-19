/**
 * VOS-131 integration test: an agent prompt resolves a real starter-vault
 * template at render time. Pins the seed inventory's slot contract — if a
 * future refactor breaks the slot names in `_templates/agent.md`, this fails
 * loudly rather than letting Tinker silently emit a malformed draft.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAndRender, loadTemplate } from "../load-template";

// Resolve the in-repo starter-vault relative to this test file. The test
// reads templates directly from source — same path the daemon resolves at
// boot when the operator runs against the seed vault.
const STARTER_VAULT = resolve(import.meta.dir, "..", "..", "..", "..", "starter-vault");

describe("starter-vault _templates inventory", () => {
  it("starter-vault/_templates/ exists and is reachable from daemon", () => {
    expect(existsSync(join(STARTER_VAULT, "_templates"))).toBe(true);
    expect(existsSync(join(STARTER_VAULT, "_templates", "CLAUDE.md"))).toBe(true);
  });

  it("daily template renders with {date}", () => {
    const out = loadAndRender("daily", { date: "2026-05-19" }, STARTER_VAULT);
    expect(out.startsWith("# 2026-05-19")).toBe(true);
    expect(out).toContain("## Sessions");
  });

  it("task template renders with {id, title, created}", () => {
    const out = loadAndRender(
      "task",
      { id: "VOS-131", title: "Templates as first-class", created: "2026-05-18" },
      STARTER_VAULT,
    );
    expect(out).toContain("id: VOS-131");
    expect(out).toContain("title: Templates as first-class");
    expect(out).toContain("created: 2026-05-18");
    expect(out).toContain("# Templates as first-class");
  });

  it("agent template renders with {name, description, model}", () => {
    const out = loadAndRender(
      "agent",
      { name: "eva", description: "Personal assistant.", model: "sonnet" },
      STARTER_VAULT,
    );
    expect(out).toContain("name: eva");
    expect(out).toContain("description: Personal assistant.");
    expect(out).toContain("model: sonnet");
    expect(out).toContain("# eva");
  });

  it("agent template's slot inventory is exactly {name, description, model}", () => {
    const t = loadTemplate("agent", STARTER_VAULT);
    expect(t.slots.sort()).toEqual(["description", "model", "name"]);
  });

  it("missing slot in render fails closed", () => {
    expect(() =>
      loadAndRender("task", { id: "X-1", title: "T" }, STARTER_VAULT),
    ).toThrow(/MISSING_SLOT/);
  });
});
