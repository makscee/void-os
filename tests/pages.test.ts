// pages.test.ts — VOS-225 P1: page-manifest read/upsert + slug grammar + data-source extraction.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidSlug, readManifest, upsertPage, manifestPath,
  extractDataSource, type PageEntry,
} from "../src/pages.ts";

let vault: string;
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), "vos-pages-")); });
afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

test("isValidSlug enforces the frozen grammar ^[a-z0-9][a-z0-9-]{0,62}$", () => {
  expect(isValidSlug("kanban")).toBe(true);
  expect(isValidSlug("my-board-1")).toBe(true);
  expect(isValidSlug("a")).toBe(true);
  expect(isValidSlug("0")).toBe(true);
  expect(isValidSlug("-bad")).toBe(false);     // leading dash
  expect(isValidSlug("Bad")).toBe(false);       // uppercase
  expect(isValidSlug("")).toBe(false);          // empty
  expect(isValidSlug("a/b")).toBe(false);       // slash
  expect(isValidSlug("a".repeat(64))).toBe(false); // too long (>63)
  expect(isValidSlug("a".repeat(63))).toBe(true);   // exactly 63
});

test("readManifest on missing file returns {pages:[]} (never throws)", () => {
  expect(readManifest(vault)).toEqual({ pages: [] });
});

test("readManifest on corrupt JSON returns {pages:[]} (never throws)", () => {
  mkdirSync(join(vault, "panels"), { recursive: true });
  writeFileSync(manifestPath(vault), "{ not json");
  expect(readManifest(vault)).toEqual({ pages: [] });
});

test("upsertPage adds a new entry with pinned:true default", () => {
  const e = upsertPage(vault, { slug: "kanban", title: "Kanban", path: "panels/kanban.html" });
  expect(e).toEqual({ slug: "kanban", title: "Kanban", path: "panels/kanban.html", pinned: true });
  const m = readManifest(vault);
  expect(m.pages).toHaveLength(1);
  expect(m.pages[0].slug).toBe("kanban");
  // round-trips to disk as valid JSON
  expect(JSON.parse(readFileSync(manifestPath(vault), "utf8")).pages[0].slug).toBe("kanban");
});

test("upsertPage updates title/path of an existing slug, preserving pinned", () => {
  upsertPage(vault, { slug: "kanban", title: "Kanban", path: "panels/kanban.html" });
  // flip pinned off via a manual edit, then upsert again
  const m = readManifest(vault);
  m.pages[0].pinned = false;
  writeFileSync(manifestPath(vault), JSON.stringify(m));
  const e = upsertPage(vault, { slug: "kanban", title: "Board", path: "panels/board.html" });
  expect(e.title).toBe("Board");
  expect(e.path).toBe("panels/board.html");
  expect(e.pinned).toBe(false); // preserved
  expect(readManifest(vault).pages).toHaveLength(1); // still one entry (upsert, not append)
});

test("upsertPage preserves array order across multiple inserts", () => {
  upsertPage(vault, { slug: "a", title: "A", path: "panels/a.html" });
  upsertPage(vault, { slug: "b", title: "B", path: "panels/b.html" });
  upsertPage(vault, { slug: "c", title: "C", path: "panels/c.html" });
  expect(readManifest(vault).pages.map((p: PageEntry) => p.slug)).toEqual(["a", "b", "c"]);
});

test("extractDataSource reads the data-vos-source attribute glob", () => {
  const html = `<!doctype html><div data-vos-source="work/tasks/active/*.md"><h1>board</h1></div>`;
  expect(extractDataSource(html)).toBe("work/tasks/active/*.md");
});

test("extractDataSource returns null when no attribute present", () => {
  expect(extractDataSource("<div>no source</div>")).toBe(null);
});

test("extractDataSource handles single quotes", () => {
  expect(extractDataSource(`<div data-vos-source='panels/x.html'>`)).toBe("panels/x.html");
});
