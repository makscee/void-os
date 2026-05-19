import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ERR,
  TemplateError,
  loadTemplate,
  renderTemplate,
  loadAndRender,
} from "../load-template";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vos-131-template-"));
  mkdirSync(join(root, "_templates"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function seed(name: string, body: string): void {
  writeFileSync(join(root, "_templates", `${name}.md`), body);
}

describe("loadTemplate", () => {
  it("reads a template and extracts slot names in encounter order", () => {
    seed("daily", "# {{date}}\n\n## Sessions\n\n## Mood\n\n{{mood}}\n");
    const t = loadTemplate("daily", root);
    expect(t.name).toBe("daily");
    expect(t.slots).toEqual(["date", "mood"]);
    expect(t.path.endsWith("_templates/daily.md")).toBe(true);
  });

  it("dedupes repeated slots while preserving first-encounter order", () => {
    seed("repeat", "{{a}} {{b}} {{a}} {{c}} {{b}}");
    const t = loadTemplate("repeat", root);
    expect(t.slots).toEqual(["a", "b", "c"]);
  });

  it("throws TEMPLATE_NOT_FOUND for missing file", () => {
    try {
      loadTemplate("nope", root);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError);
      expect((e as TemplateError).code).toBe(ERR.TEMPLATE_NOT_FOUND);
    }
  });

  it("rejects names containing path separators", () => {
    expect(() => loadTemplate("../escape", root)).toThrow(/TEMPLATE_NOT_FOUND|invalid/);
    expect(() => loadTemplate("sub/dir", root)).toThrow();
  });

  it("rejects dotfile names", () => {
    expect(() => loadTemplate(".hidden", root)).toThrow();
  });

  it("throws MALFORMED_TEMPLATE for unclosed `{{`", () => {
    seed("bad", "Hello {{name\n");
    try {
      loadTemplate("bad", root);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as TemplateError).code).toBe(ERR.MALFORMED_TEMPLATE);
    }
  });

  it("throws MALFORMED_TEMPLATE for empty `{{}}`", () => {
    seed("bad", "Hello {{}}");
    expect(() => loadTemplate("bad", root)).toThrow(/MALFORMED_TEMPLATE/);
  });
});

describe("renderTemplate", () => {
  it("substitutes all slots from context", () => {
    const raw = "# {{date}}\n{{mood}}";
    const out = renderTemplate(raw, { date: "2026-05-19", mood: "ok" });
    expect(out).toBe("# 2026-05-19\nok");
  });

  it("throws MISSING_SLOT listing every absent slot, sorted + deduped", () => {
    const raw = "{{a}} {{b}} {{c}} {{a}}";
    try {
      renderTemplate(raw, { a: "1" });
      throw new Error("expected throw");
    } catch (e) {
      expect((e as TemplateError).code).toBe(ERR.MISSING_SLOT);
      expect((e as TemplateError).message).toContain("b, c");
    }
  });

  it("allowMissing substitutes empty string for absent slots", () => {
    const raw = "{{a}}-{{b}}";
    const out = renderTemplate(raw, { a: "x" }, { allowMissing: true });
    expect(out).toBe("x-");
  });

  it("does NOT recursively expand substituted values", () => {
    // Defense against template-injection: if context.name happens to look
    // like a placeholder, it must be substituted literally — not re-scanned.
    const raw = "Hello {{name}}";
    const out = renderTemplate(raw, { name: "{{evil}}" });
    expect(out).toBe("Hello {{evil}}");
  });

  it("accepts dotted and dashed slot names", () => {
    const raw = "{{task.id}} / {{due-date}}";
    const out = renderTemplate(raw, { "task.id": "VOS-131", "due-date": "2026-05-19" });
    expect(out).toBe("VOS-131 / 2026-05-19");
  });
});

describe("loadAndRender", () => {
  it("composes load + render in one call", () => {
    writeFileSync(
      join(root, "_templates", "task.md"),
      "---\nid: {{id}}\n---\n\n# {{title}}\n",
    );
    const out = loadAndRender("task", { id: "VOS-131", title: "Templates" }, root);
    expect(out).toBe("---\nid: VOS-131\n---\n\n# Templates\n");
  });

  it("propagates TEMPLATE_NOT_FOUND from load step", () => {
    expect(() => loadAndRender("nope", {}, root)).toThrow(/TEMPLATE_NOT_FOUND/);
  });
});
