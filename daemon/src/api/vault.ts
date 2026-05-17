import type { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { resolveVaultPath, ERR } from "../vault/paths.ts";
import { isExcluded } from "../vault/exclude.ts";
import { VaultWriteReq } from "@voidos/protocol";

interface Deps { vaultRoot: string }

function mapResolveError(e: unknown): { status: 400 | 403; error: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === ERR.PATH_MUST_BE_RELATIVE) return { status: 400, error: "E_TRAVERSAL" };
  if (msg === ERR.PATH_ESCAPES_VAULT_ROOT) return { status: 403, error: "E_OUT_OF_SCOPE" };
  return { status: 400, error: "E_TRAVERSAL" };
}

export function mountVault(app: Hono, deps: Deps): void {
  const vaultRoot = fs.realpathSync(deps.vaultRoot);

  app.get("/vault/file", (c) => {
    const rel = c.req.query("path");
    if (!rel) return c.json({ error: "E_INVALID_BODY" }, 400);
    if (isExcluded(rel)) return c.json({ error: "E_EXCLUDED" }, 403);

    let abs: string;
    try { abs = resolveVaultPath(rel, vaultRoot); }
    catch (e) { const m = mapResolveError(e); return c.json({ error: m.error }, m.status); }

    if (!fs.existsSync(abs)) return c.json({ error: "E_NOT_FOUND" }, 404);

    const buf = fs.readFileSync(abs);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      return c.json({ error: "E_BINARY" }, 415);
    }

    const stat = fs.statSync(abs);
    return c.json({
      path: abs,
      content,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs / 1000),
    });
  });

  app.get("/vault/list", (c) => {
    const rel = c.req.query("path") ?? "";
    const depthRaw = c.req.query("depth");
    // Default depth = 1 per docs/api.md. Cap at 10 (silently clamp).
    // Note: the v1 response only ever emits top-level entries regardless of
    // depth, so this is effectively a forward-compat parameter — but we still
    // bound it so the contract is honored if recursion is reintroduced.
    let depth = depthRaw ? (parseInt(depthRaw, 10) || 1) : 1;
    if (depth < 1) depth = 1;
    if (depth > 10) depth = 10;
    void depth; // currently unused; kept for clarity of contract.

    let abs: string;
    if (rel === "" || rel === ".") {
      abs = vaultRoot;
    } else {
      if (isExcluded(rel)) return c.json({ error: "E_EXCLUDED" }, 403);
      try { abs = resolveVaultPath(rel, vaultRoot); }
      catch (e) { const m = mapResolveError(e); return c.json({ error: m.error }, m.status); }
    }

    if (!fs.existsSync(abs)) return c.json({ error: "E_NOT_FOUND" }, 404);

    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) {
      return c.json({ error: "E_NOT_FOUND" }, 404);
    }

    const ENTRY_CAP = 10000;
    const entries: Array<{name: string; type: "file"|"dir"; size: number; mtime: number}> = [];
    const names = fs.readdirSync(abs).sort();
    if (names.length > ENTRY_CAP) {
      return c.json({ error: "E_TOO_LARGE" }, 413);
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;  // excludes .obsidian, .git, dotfiles
      const child = `${abs}/${name}`;
      const s = fs.statSync(child);
      const type: "file"|"dir" = s.isDirectory() ? "dir" : "file";
      entries.push({ name, type, size: s.size, mtime: Math.floor(s.mtimeMs / 1000) });
    }

    return c.json({ path: abs, entries });
  });

  app.put("/vault/file", async (c) => {
    // Hard cap before reading body to avoid OOM on hostile content.
    const lenHeader = c.req.header("content-length");
    if (lenHeader && Number(lenHeader) > 10 * 1024 * 1024 + 1024) {
      return c.json({ error: "E_TOO_LARGE" }, 413);
    }

    let parsed;
    try { parsed = VaultWriteReq.parse(await c.req.json()); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Too big") || msg.includes("max")) return c.json({ error: "E_TOO_LARGE" }, 413);
      return c.json({ error: "E_INVALID_BODY" }, 400);
    }

    if (isExcluded(parsed.path)) return c.json({ error: "E_EXCLUDED" }, 403);

    // Defense-in-depth: if the literal target path is itself a symlink whose
    // realpath escapes the vault, reject before resolveVaultPath gets a chance
    // to follow it. This gives a clearer error code (E_SYMLINK_ESCAPE) than
    // the generic E_OUT_OF_SCOPE that resolveVaultPath would emit.
    const literalAbs = path.resolve(vaultRoot, parsed.path);
    if (fs.existsSync(literalAbs) && fs.lstatSync(literalAbs).isSymbolicLink()) {
      const realTarget = fs.realpathSync(literalAbs);
      if (realTarget !== vaultRoot && !realTarget.startsWith(vaultRoot + path.sep)) {
        return c.json({ error: "E_SYMLINK_ESCAPE" }, 403);
      }
    }

    let abs: string;
    try { abs = resolveVaultPath(parsed.path, vaultRoot); }
    catch (e) { const m = mapResolveError(e); return c.json({ error: m.error }, m.status); }

    // Realpath-check the parent of the target — if the parent is a symlink
    // out of vault, reject.
    const parent = path.dirname(abs);
    if (fs.existsSync(parent)) {
      const realParent = fs.realpathSync(parent);
      if (realParent !== vaultRoot && !realParent.startsWith(vaultRoot + path.sep)) {
        return c.json({ error: "E_SYMLINK_ESCAPE" }, 403);
      }
    }

    fs.mkdirSync(parent, { recursive: true });

    const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, parsed.content, { encoding: "utf8" });
    try {
      fs.renameSync(tmp, abs);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e;
    }

    const stat = fs.statSync(abs);
    return c.json({
      path: abs,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs / 1000),
    });
  });
}
