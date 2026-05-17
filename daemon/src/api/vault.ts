import type { Hono } from "hono";
import * as fs from "node:fs";
import { resolveVaultPath, ERR } from "../vault/paths.ts";
import { isExcluded } from "../vault/exclude.ts";

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
}
