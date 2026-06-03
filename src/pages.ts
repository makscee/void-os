// pages.ts — VOS-225 P1: page-manifest (§3) + slug grammar + data-source extraction + data-dir watch.
//
// The manifest (panels/manifest.json) is JSON (NOT markdown) so page.register can do a safe
// programmatic read-modify-write. Pages are READ-ONLY LIVE VIEWS: the daemon file-watches each
// page's declared data-source glob (data-vos-source attr) and pushes an SSE reload on change.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

/** Frozen slug grammar (§1): ^[a-z0-9][a-z0-9-]{0,62}$ (1..63 chars). */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

export interface PageEntry {
  slug: string;
  title: string;
  path: string; // vault-relative .html the page serves
  pinned: boolean;
}
export interface Manifest {
  pages: PageEntry[];
}

/** Vault-relative manifest path: panels/manifest.json. */
export function manifestPath(vault: string): string {
  return join(vault, "panels", "manifest.json");
}

/** Read the manifest. Missing file OR parse error → {pages:[]} (never throws — §3.1). */
export function readManifest(vault: string): Manifest {
  const p = manifestPath(vault);
  if (!existsSync(p)) return { pages: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (!raw || !Array.isArray(raw.pages)) return { pages: [] };
    // normalize entries defensively
    const pages: PageEntry[] = raw.pages
      .filter((e: unknown): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e: Record<string, unknown>) => ({
        slug: String(e.slug ?? ""),
        title: String(e.title ?? ""),
        path: String(e.path ?? ""),
        pinned: e.pinned !== false, // default true
      }))
      .filter((e: PageEntry) => e.slug);
    return { pages };
  } catch {
    return { pages: [] };
  }
}

function writeManifest(vault: string, m: Manifest): void {
  const p = manifestPath(vault);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 2) + "\n", "utf8");
}

/**
 * Idempotent upsert by slug (§1.3, §3.2). New entries default pinned:true; existing entries
 * keep their current pinned. Synchronous read-modify-write — the daemon serializes concurrent
 * page.register calls via an in-process mutex (see registerPage in vault-mcp.ts).
 * Returns the resulting entry.
 */
export function upsertPage(
  vault: string,
  e: { slug: string; title: string; path: string },
): PageEntry {
  const m = readManifest(vault);
  const existing = m.pages.find((p) => p.slug === e.slug);
  let result: PageEntry;
  if (existing) {
    existing.title = e.title;
    existing.path = e.path;
    result = existing;
  } else {
    result = { slug: e.slug, title: e.title, path: e.path, pinned: true };
    m.pages.push(result);
  }
  writeManifest(vault, m);
  return result;
}

/** Extract the data-vos-source glob from a page's html (the seam P3 declares, P1 watches, §6.1). */
export function extractDataSource(html: string): string | null {
  const m = html.match(/data-vos-source\s*=\s*["']([^"']*)["']/);
  return m ? m[1] : null;
}

/**
 * Resolve a data-source glob to the directory the daemon should mtime-watch.
 * v1 mechanism (§3.4, R-3): poll the newest mtime across files matching the glob's dir.
 * We watch the GLOB'S PARENT DIR (e.g. "work/tasks/active/*.md" → "<vault>/work/tasks/active"),
 * falling back to the vault root if the dir cannot be resolved.
 */
export function dataSourceDir(vault: string, glob: string): string {
  // strip a trailing /<pattern> segment if the last segment contains glob metachars
  const parts = glob.split("/");
  const last = parts[parts.length - 1] ?? "";
  const dirParts = /[*?[\]{}]/.test(last) ? parts.slice(0, -1) : parts;
  const rel = dirParts.join("/");
  return rel ? join(vault, rel) : vault;
}

/**
 * Newest mtime (ms) across the page's data-source dir — the freshness signal for the SSE watch.
 * Returns 0 when the dir is absent. Recurses one level into the dir (flat task dirs are the
 * common case; deeper nesting is rare for a board source).
 */
export function dataSourceMtime(vault: string, glob: string): number {
  const dir = dataSourceDir(vault, glob);
  if (!existsSync(dir)) return 0;
  let newest = 0;
  try {
    const st = statSync(dir);
    newest = st.mtimeMs; // dir mtime advances on add/remove of children
    for (const name of readdirSync(dir)) {
      try {
        const fst = statSync(join(dir, name));
        if (fst.isFile() && fst.mtimeMs > newest) newest = fst.mtimeMs;
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir vanished mid-scan */ }
  return newest;
}
