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
    const depth = depthRaw ? Math.max(1, parseInt(depthRaw, 10) || 1) : Number.POSITIVE_INFINITY;

    let abs: string;
    if (rel === "" || rel === ".") {
      abs = vaultRoot;
    } else {
      if (isExcluded(rel)) return c.json({ error: "E_EXCLUDED" }, 403);
      try { abs = resolveVaultPath(rel, vaultRoot); }
      catch (e) { const m = mapResolveError(e); return c.json({ error: m.error }, m.status); }
    }

    if (!fs.existsSync(abs)) return c.json({ error: "E_NOT_FOUND" }, 404);

    const entries: Array<{name: string; type: "file"|"dir"; size: number; mtime: number}> = [];
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) {
      return c.json({ error: "E_NOT_FOUND" }, 404);
    }

    function walk(dir: string, remaining: number) {
      for (const name of fs.readdirSync(dir).sort()) {
        if (name.startsWith(".")) continue;  // excludes .obsidian, .git, dotfiles
        const child = `${dir}/${name}`;
        const s = fs.statSync(child);
        const type: "file"|"dir" = s.isDirectory() ? "dir" : "file";
        if (dir === abs) {
          entries.push({ name, type, size: s.size, mtime: Math.floor(s.mtimeMs / 1000) });
        }
        if (type === "dir" && remaining > 1) walk(child, remaining - 1);
      }
    }
    walk(abs, depth);

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
