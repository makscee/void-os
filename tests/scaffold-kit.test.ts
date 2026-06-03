// scaffold-kit.test.ts — VOS-227 P3: default styled kit (tokens) + 5 scaffolds.
// Asserts the frozen vault-mcp-v1 scaffold contract (§6): tokens present, each scaffold is
// self-contained (no CDN, no external stylesheet), declares data-vos-source, carries the
// {{VOS_SLUG}} placeholder, vendors its runtime via the daemon asset route, and wires its
// dominant interaction's write-back to the /p/<slug>/act 410 stub.
import { expect, test, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SORTABLE_MIN_JS, SORTABLE_VERSION } from "../src/sortable-runtime.ts";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SCAFFOLDS = ["kanban", "list", "form", "detail", "feed"] as const;
const html = Object.fromEntries(
  SCAFFOLDS.map((s) => [s, read(`kit/scaffolds/${s}.html`)]),
) as Record<(typeof SCAFFOLDS)[number], string>;

// The 18 frozen token vars (== render.ts UI_TOKENS == ui-style-spec §2 slate-dark).
const TOKEN_VARS = [
  "--background", "--foreground", "--card", "--card-foreground", "--primary",
  "--primary-foreground", "--secondary", "--secondary-foreground", "--muted",
  "--muted-foreground", "--accent", "--accent-foreground", "--destructive",
  "--destructive-foreground", "--border", "--input", "--ring", "--radius",
];

describe("kit/tokens.css", () => {
  const css = read("kit/tokens.css");
  test("exists and declares all 18 frozen token vars in :root", () => {
    expect(css).toContain(":root");
    for (const v of TOKEN_VARS) expect(css).toContain(`${v}:`);
  });
  test("carries the exact frozen slate-dark values (verbatim from render.ts UI_TOKENS)", () => {
    expect(css).toContain("--background: 222.2 84% 4.9%;");
    expect(css).toContain("--foreground: 210 40% 98%;");
    expect(css).toContain("--radius: 0.5rem;");
    expect(css).toContain("--muted-foreground: 215 20.2% 65.1%;");
  });
  test("uses the system-native font stack (no webfont loader)", () => {
    expect(css).toContain("-apple-system");
    expect(css).toContain("system-ui");
  });
});

describe.each([...SCAFFOLDS])("scaffold %s", (name) => {
  const h = html[name];
  test("is a self-contained HTML document", () => {
    expect(h).toContain("<!doctype html>");
    expect(h).toContain("<style>");
  });
  test("inlines all 18 token vars (no external stylesheet, no @import)", () => {
    for (const v of TOKEN_VARS) expect(h).toContain(`${v}:`);
    expect(h).not.toContain("@import");
    expect(h).not.toMatch(/<link[^>]+stylesheet/i);
    expect(h).not.toContain("@hub/ui-kit");
  });
  test("vendors htmx via the daemon asset route (no CDN)", () => {
    expect(h).toContain(`<script src="/assets/htmx.min.js"></script>`);
    expect(h).not.toMatch(/https?:\/\/[^"']*(unpkg|jsdelivr|cdn|cdnjs)/i);
  });
  test("declares its data source via the frozen data-vos-source attribute", () => {
    expect(h).toMatch(/data-vos-source="[^"]+"/);
  });
  test("carries the {{VOS_SLUG}} placeholder for /p/:slug substitution", () => {
    expect(h).toContain("{{VOS_SLUG}}");
  });
});

describe("dominant interaction wiring (frozen §6.2/§6.3)", () => {
  test("kanban: SortableJS + hx-trigger end, write-back to the 410 stub", () => {
    expect(html.kanban).toContain(`<script src="/assets/sortable.min.js"></script>`);
    expect(html.kanban).toContain("new Sortable");
    expect(html.kanban).toContain(`hx-trigger="end"`);
    expect(html.kanban).toContain(`hx-post="/p/{{VOS_SLUG}}/act"`);
  });
  test("list: hx-post inline-add + hx-delete row, both to the 410 stub", () => {
    expect(html.list).toContain(`hx-post="/p/{{VOS_SLUG}}/act"`);
    expect(html.list).toContain(`hx-delete="/p/{{VOS_SLUG}}/act`);
  });
  test("form: hx-post submit + hx-target ack, to the 410 stub", () => {
    expect(html.form).toContain(`hx-post="/p/{{VOS_SLUG}}/act"`);
    expect(html.form).toMatch(/hx-target="#ack"/);
  });
  test("detail: hx-get lazy sections, to the 410 stub", () => {
    expect(html.detail).toContain(`hx-get="/p/{{VOS_SLUG}}/act`);
    expect(html.detail).toContain(`hx-trigger="revealed"`);
  });
  test("feed: hx-ext=sse + sse-connect, SSE ext vendored inline (no CDN)", () => {
    expect(html.feed).toContain(`hx-ext="sse"`);
    expect(html.feed).toContain("sse-connect=");
    // The htmx SSE extension is inlined (self-registers via htmx.defineExtension).
    expect(html.feed).toContain("defineExtension");
  });
});

describe("src/sortable-runtime.ts (vendored, no runtime dep)", () => {
  test("exports a non-trivial minified SortableJS const exposing the Sortable global", () => {
    expect(SORTABLE_VERSION).toBe("1.15.6");
    expect(SORTABLE_MIN_JS.length).toBeGreaterThan(40000);
    expect(SORTABLE_MIN_JS).toContain("Sortable");
  });
  test("sortablejs is NOT a package.json dependency (vendored as a string const)", () => {
    const pkg = JSON.parse(read("package.json"));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(deps.sortablejs).toBeUndefined();
  });
});

describe("kit ships exactly the contract files", () => {
  test("all five scaffolds + tokens.css exist", () => {
    expect(existsSync(join(ROOT, "kit/tokens.css"))).toBe(true);
    for (const s of SCAFFOLDS) expect(existsSync(join(ROOT, `kit/scaffolds/${s}.html`))).toBe(true);
  });
});
