// page-routes.test.ts — VOS-225 P1 §3.3/§6.3: GET /p/:slug, missing-stub, 404,
// POST /p/:slug/act (410 stub), and the data-source mtime-watch signal.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry } from "../src/registry.ts";
import { makeApp } from "../src/server.ts";
import { upsertPage } from "../src/pages.ts";
import { dataSourceMtime } from "../src/pages.ts";

let vault: string;
const db = openRegistry(":memory:");
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), "vos-proutes-")); });
afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

function writePanel(slug: string, html: string) {
  mkdirSync(join(vault, "panels"), { recursive: true });
  writeFileSync(join(vault, "panels", `${slug}.html`), html);
  upsertPage(vault, { slug, title: slug, path: `panels/${slug}.html` });
}

test("GET /p/:slug 404s for an unregistered slug", async () => {
  const res = await makeApp(vault, db).request("/p/nope");
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("no such page");
});

test("GET /p/:slug renders a missing-stub (never 500) when the file is gone (drift)", async () => {
  // registered in manifest but no file on disk
  upsertPage(vault, { slug: "ghost", title: "Ghost", path: "panels/ghost.html" });
  const res = await makeApp(vault, db).request("/p/ghost/body");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("page file missing: panels/ghost.html");
});

test("GET /p/:slug/body serves the panel html with the same pipeline (htmx + {{VOS_SLUG}} + base)", async () => {
  writePanel("board", `<div data-vos-source="work/tasks/active/*.md">slug={{VOS_SLUG}}</div>`);
  const res = await makeApp(vault, db).request("/p/board/body");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("slug=board");                 // {{VOS_SLUG}} substituted
  expect(html).toContain("/assets/htmx.min.js");         // vendored htmx injected
  expect(html).toContain('<base target="_top">');        // base injected (bare fragment wrap)
});

test("GET /p/:slug/body serves a full document, injecting base into <head>", async () => {
  writePanel("full", `<!doctype html><html><head><title>x</title></head><body>hi {{VOS_SLUG}}</body></html>`);
  const html = await (await makeApp(vault, db).request("/p/full/body")).text();
  expect(html).toContain('<base target="_top">');
  expect(html).toContain("hi full");
});

test("POST /p/:slug/act returns 410 Gone (write-back is the v1.5 seam)", async () => {
  writePanel("k", `<div>x</div>`);
  const res = await makeApp(vault, db).request("/p/k/act", { method: "POST", body: new URLSearchParams({ x: "1" }) });
  expect(res.status).toBe(410);
  expect(await res.text()).toContain("agent-mediated write-back is v1.5");
});

test("GET /p/:slug shell renders an iframe pointing at the page body", async () => {
  writePanel("dash", `<div>dash</div>`);
  const html = await (await makeApp(vault, db).request("/p/dash")).text();
  // shell embeds the body fragment via /p/:slug/body and opens an SSE stream
  expect(html).toContain("/p/dash/body");
  expect(html).toContain("/p/dash/stream");
});

test("data-source mtime advances when a matched task file changes (the SSE reload signal)", () => {
  const taskDir = join(vault, "work", "tasks", "active");
  mkdirSync(taskDir, { recursive: true });
  const f = join(taskDir, "A.md");
  writeFileSync(f, "v1");
  const m1 = dataSourceMtime(vault, "work/tasks/active/*.md");
  // advance mtime explicitly (write within the same ms otherwise reads equal)
  const future = Date.now() / 1000 + 5;
  utimesSync(f, future, future);
  const m2 = dataSourceMtime(vault, "work/tasks/active/*.md");
  expect(m2).toBeGreaterThan(m1);
});
