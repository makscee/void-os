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

/** A single task card derived from a vault md file's frontmatter (VOS-228 §2 live data). */
export interface TaskCard {
  id: string;
  title: string;
  state: string;
}

/**
 * Parse the leading YAML-ish frontmatter of a task md into a board card (id/title/state).
 * Tolerant line-scan (no YAML dep): strips surrounding quotes, keeps the rest of the value
 * verbatim (so a title with a ':' survives). Missing fields → "". Never throws.
 */
export function parseTaskCard(md: string): TaskCard {
  const out: TaskCard = { id: "", title: "", state: "" };
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, vRaw] = kv;
    const v = vRaw.replace(/^["']|["']$/g, "").trim();
    if (k === "id") out.id = v;
    else if (k === "title") out.title = v;
    else if (k === "state") out.state = v;
  }
  return out;
}

/** Translate a glob basename pattern (e.g. "*.md", "VOS-*.md") into a RegExp. */
function globToRe(pattern: string): RegExp {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`);
}

/** List the task md files matching a data-source glob (vault-relative), sorted by name. */
function listSourceFiles(vault: string, glob: string): string[] {
  const dir = dataSourceDir(vault, glob);
  if (!existsSync(dir)) return [];
  const parts = glob.split("/");
  const last = parts[parts.length - 1] ?? "";
  const pat = /[*?[\]{}]/.test(last) ? last : "*"; // if last segment is the dir itself, match all
  const re = globToRe(pat);
  try {
    return readdirSync(dir)
      .filter((n) => re.test(n))
      .sort()
      .map((n) => join(dir, n));
  } catch { return []; }
}

const escHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/**
 * THE live-data seam (VOS-228 §2/§3 of the contract). A kanban-style panel ships with example
 * cards inside `[data-col][... data-cards]` containers + a top-level `data-vos-source` glob. The
 * daemon REPLACES those example cards with REAL cards parsed from the glob's task files, grouping
 * each into the column whose `data-col` matches the task `state` (fallback: the FIRST column).
 *
 * No-op (returns the html unchanged) when the panel declares no `data-vos-source` or has no
 * `data-cards` container — so non-board scaffolds (form/detail/feed) pass through untouched.
 * Pure string transform: same input → same output for a fixed disk, so the SSE reload that
 * re-fetches /p/:slug/body always reflects current task files (regenerate-on-change, §3.4).
 */
export function renderBoardData(vault: string, html: string): string {
  const glob = extractDataSource(html);
  if (!glob) return html;
  if (!/data-cards/.test(html)) return html;

  // discover the columns in document order: each <div ... data-col="X" ...> ... data-cards container
  const colRe = /data-col\s*=\s*["']([^"']*)["']/g;
  const cols: string[] = [];
  let cm: RegExpExecArray | null;
  while ((cm = colRe.exec(html)) !== null) cols.push(cm[1]);
  if (cols.length === 0) return html;

  // build the card list, bucketed by column
  const buckets: Record<string, string[]> = {};
  for (const col of cols) buckets[col] = [];
  for (const f of listSourceFiles(vault, glob)) {
    let card: TaskCard;
    try { card = parseTaskCard(readFileSync(f, "utf8")); } catch { continue; }
    if (!card.title && !card.id) continue;
    const target = cols.includes(card.state) ? card.state : cols[0];
    const label = card.title || card.id;
    buckets[target].push(
      `<div class="card" data-id="${escHtml(card.id)}">${escHtml(label)}</div>`,
    );
  }

  // for each `data-col="X"` block, replace the inner-most data-cards container's children
  return html.replace(
    /(<div[^>]*data-col\s*=\s*["']([^"']*)["'][^>]*>[\s\S]*?<div[^>]*\bdata-cards\b[^>]*>)([\s\S]*?)(<\/div>)/g,
    (_full, open: string, col: string, _children: string, close: string) =>
      `${open}${(buckets[col] ?? []).join("")}${close}`,
  );
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
