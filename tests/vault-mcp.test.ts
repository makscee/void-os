// vault-mcp.test.ts — VOS-225 P1: the four daemon-hosted MCP tools (§1).
// Tests call the tool dispatch directly (callVaultTool) — the same code path the MCP
// CallToolRequest handler invokes — so behaviour + audit emit + error shapes are verified
// without a transport round-trip.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callVaultTool, VAULT_TOOLS } from "../src/vault-mcp.ts";
import { readManifest, manifestPath } from "../src/pages.ts";
import { auditPath } from "../src/audit.ts";

let vault: string;
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), "vos-mcp-")); });
afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

function auditLines(): any[] {
  const p = auditPath(vault);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("VAULT_TOOLS exposes exactly the four v1 tools (no session.* / vault.read)", () => {
  const names = VAULT_TOOLS.map((t) => t.name).sort();
  expect(names).toEqual(["page.list", "page.register", "vault.append", "vault.write"]);
});

// ── vault.write ────────────────────────────────────────────────────────────
test("vault.write writes the file + emits an audit line (source:mcp)", async () => {
  const r = await callVaultTool(vault, "vault.write", { path: "notes/a.md", content: "hello", exec_id: "exec-x" });
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toBe("wrote notes/a.md (5b)");
  expect(readFileSync(join(vault, "notes/a.md"), "utf8")).toBe("hello");
  const a = auditLines();
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({ tool: "vault.write", path: "notes/a.md", bytes: 5, source: "mcp", exec: "exec-x" });
});

test("vault.write creates parent dirs", async () => {
  await callVaultTool(vault, "vault.write", { path: "deep/nested/dir/x.txt", content: "y" });
  expect(existsSync(join(vault, "deep/nested/dir/x.txt"))).toBe(true);
});

test("vault.write rejects path escaping the vault", async () => {
  const r = await callVaultTool(vault, "vault.write", { path: "../escape.md", content: "x" });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toBe("path escapes vault");
  expect(existsSync(join(vault, "..", "escape.md"))).toBe(false);
});

test("vault.write hard-blocks SYSTEM_DENY paths + emits denied:true audit", async () => {
  for (const p of ["agents/maya.md", ".void-os/registry.db", "agents/sub/x.md"]) {
    const r = await callVaultTool(vault, "vault.write", { path: p, content: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`SYSTEM_DENY: ${p}`);
  }
  const a = auditLines();
  expect(a).toHaveLength(3);
  expect(a.every((l) => l.denied === true && l.source === "mcp")).toBe(true);
});

test("vault.write defaults exec to mcp-<uuid> when exec_id omitted", async () => {
  await callVaultTool(vault, "vault.write", { path: "x.md", content: "z" });
  expect(auditLines()[0].exec).toMatch(/^mcp-/);
});

// ── vault.append ─────────────────────────────────────────────────────────────
test("vault.append appends + audits source:mcp tool:vault.append", async () => {
  await callVaultTool(vault, "vault.write", { path: "log.md", content: "a" });
  const r = await callVaultTool(vault, "vault.append", { path: "log.md", content: "b" });
  expect(r.content[0].text).toBe("appended log.md (+1b)");
  expect(readFileSync(join(vault, "log.md"), "utf8")).toBe("ab");
  const last = auditLines().at(-1);
  expect(last).toMatchObject({ tool: "vault.append", source: "mcp" });
});

test("vault.append also honours SYSTEM_DENY", async () => {
  const r = await callVaultTool(vault, "vault.append", { path: ".void-os/audit.jsonl", content: "x" });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toMatch(/^SYSTEM_DENY:/);
});

// ── page.register ────────────────────────────────────────────────────────────
test("page.register upserts the manifest + audits the manifest write", async () => {
  const r = await callVaultTool(vault, "page.register", { slug: "kanban", title: "Kanban", path: "panels/kanban.html" });
  expect(r.isError).toBeFalsy();
  expect(r.content[0].text).toBe("registered kanban -> panels/kanban.html");
  const m = readManifest(vault);
  expect(m.pages).toHaveLength(1);
  expect(m.pages[0]).toMatchObject({ slug: "kanban", title: "Kanban", path: "panels/kanban.html", pinned: true });
  // manifest write goes through the audit path as a vault.write on panels/manifest.json
  const a = auditLines().find((l) => l.path === "panels/manifest.json");
  expect(a).toBeTruthy();
  expect(a).toMatchObject({ tool: "vault.write", source: "mcp" });
});

test("page.register rejects an invalid slug", async () => {
  const r = await callVaultTool(vault, "page.register", { slug: "Bad Slug", title: "x", path: "panels/x.html" });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toBe("invalid slug: Bad Slug");
  expect(existsSync(manifestPath(vault))).toBe(false);
});

test("page.register is idempotent (upsert) — second call updates not duplicates", async () => {
  await callVaultTool(vault, "page.register", { slug: "k", title: "K1", path: "panels/k.html" });
  await callVaultTool(vault, "page.register", { slug: "k", title: "K2", path: "panels/k2.html" });
  const m = readManifest(vault);
  expect(m.pages).toHaveLength(1);
  expect(m.pages[0].title).toBe("K2");
});

// ── page.list ────────────────────────────────────────────────────────────────
test("page.list returns a JSON array of manifest entries (readOnly, never errors)", async () => {
  // empty when no manifest
  let r = await callVaultTool(vault, "page.list", {});
  expect(JSON.parse(r.content[0].text)).toEqual([]);
  await callVaultTool(vault, "page.register", { slug: "a", title: "A", path: "panels/a.html" });
  r = await callVaultTool(vault, "page.list", {});
  const arr = JSON.parse(r.content[0].text);
  expect(arr).toHaveLength(1);
  expect(arr[0]).toMatchObject({ slug: "a", title: "A", path: "panels/a.html", pinned: true });
});

test("page.list never emits an audit line (read-only)", async () => {
  await callVaultTool(vault, "page.list", {});
  expect(auditLines()).toHaveLength(0);
});

test("unknown tool returns isError", async () => {
  const r = await callVaultTool(vault, "vault.nope", {});
  expect(r.isError).toBe(true);
});
