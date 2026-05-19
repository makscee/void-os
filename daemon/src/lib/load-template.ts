/**
 * VOS-131 — `_templates/` first-class loader.
 *
 * Templates live at `<vaultRoot>/_templates/<name>.md`. Slot syntax is
 * `{{slot_name}}` — alphanumeric + dot + dash + underscore. Substitution is
 * a single-pass regex replace; substituted values are NOT re-scanned for
 * further `{{...}}` markers (no recursive expansion, no template injection).
 *
 * Error codes (all surface verbatim through the MCP tool wrapper):
 *   TEMPLATE_NOT_FOUND   — file at _templates/<name>.md does not exist
 *   MALFORMED_TEMPLATE   — unclosed `{{` or empty `{{}}` placeholder
 *   MISSING_SLOT         — template references slot `foo` but context lacks `foo`
 *
 * Path resolution is hardcoded to `_templates/` for v1 (per VOS-131 Decisions).
 * When role discovery (VOS-116, deferred) lands, the helper gets a small
 * refactor to look up the templates folder via role registry.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const ERR = {
  TEMPLATE_NOT_FOUND: "TEMPLATE_NOT_FOUND",
  MALFORMED_TEMPLATE: "MALFORMED_TEMPLATE",
  MISSING_SLOT: "MISSING_SLOT",
} as const;

export const TEMPLATES_DIR = "_templates";

// Slot identifier: same shape as a YAML key. Lets templates declare e.g.
// `{{task.id}}` or `{{daily-date}}` without forcing nested context dicts —
// the dot/dash is part of the slot name, not a path expression.
const SLOT_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_.-]*)\}\}/g;
// Detect unclosed `{{` or empty `{{}}` after a successful single-pass replace.
// Anything matching this AFTER substitution indicates malformed input.
const MALFORMED_RE = /\{\{(?!\})[^}]*$|\{\{\}\}|\{\{[^}]*\{\{/;

export class TemplateError extends Error {
  code: string;
  /** Human-readable detail without the code prefix. */
  detail: string;
  constructor(code: string, detail: string) {
    // Embed the code in `message` so callers using `.toThrow(/CODE/)` and
    // raw `error.message` logging both see the code. The MCP wrapper still
    // re-formats `${code}: ${detail}` from the structured fields so the
    // wire envelope is independent of how this class formats `message`.
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
    this.name = "TemplateError";
  }
}

export interface LoadedTemplate {
  /** Template name (without `.md`). */
  name: string;
  /** Raw file contents. */
  raw: string;
  /** Slot names referenced inside the template, in encounter order, deduped. */
  slots: string[];
  /** Absolute path the template was loaded from. */
  path: string;
}

/**
 * Read template `<vaultRoot>/_templates/<name>.md`.
 *
 * Does NOT render. Returns `{ raw, slots }` for callers who want to inspect
 * the slot inventory before binding context.
 */
export function loadTemplate(name: string, vaultRoot: string): LoadedTemplate {
  if (!name || /[/\\]/.test(name) || name.startsWith(".")) {
    throw new TemplateError(
      ERR.TEMPLATE_NOT_FOUND,
      `invalid template name: ${JSON.stringify(name)}`,
    );
  }
  const abs = path.join(vaultRoot, TEMPLATES_DIR, `${name}.md`);
  let raw: string;
  try {
    raw = fs.readFileSync(abs, "utf8");
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      throw new TemplateError(
        ERR.TEMPLATE_NOT_FOUND,
        `_templates/${name}.md does not exist`,
      );
    }
    throw e;
  }
  validateMalformed(raw);
  const slots = extractSlots(raw);
  return { name, raw, slots, path: abs };
}

/**
 * Substitute `{{slot}}` markers in `raw` with values from `context`.
 *
 * Strict by default: any slot referenced in `raw` but missing from `context`
 * throws `MISSING_SLOT`. Set `opts.allowMissing = true` to substitute missing
 * slots with the empty string instead (used by callers that intentionally
 * render a partial scaffold — Tinker's "draft an agent.md" pattern).
 */
export function renderTemplate(
  raw: string,
  context: Record<string, string>,
  opts: { allowMissing?: boolean } = {},
): string {
  validateMalformed(raw);
  const missing: string[] = [];
  const out = raw.replace(SLOT_RE, (_match, slot: string) => {
    if (Object.prototype.hasOwnProperty.call(context, slot)) {
      return String(context[slot]);
    }
    if (opts.allowMissing) return "";
    missing.push(slot);
    return "";
  });
  if (missing.length > 0) {
    // Stable, deduped, sorted list — easier to assert on in tests + cleaner
    // for the agent reading the error message.
    const unique = Array.from(new Set(missing)).sort();
    throw new TemplateError(
      ERR.MISSING_SLOT,
      `template references slot(s) not provided in context: ${unique.join(", ")}`,
    );
  }
  return out;
}

/** Convenience: load + render in one call. */
export function loadAndRender(
  name: string,
  context: Record<string, string>,
  vaultRoot: string,
  opts: { allowMissing?: boolean } = {},
): string {
  const { raw } = loadTemplate(name, vaultRoot);
  return renderTemplate(raw, context, opts);
}

function extractSlots(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of raw.matchAll(SLOT_RE)) {
    // m[1] is always defined here — the regex has a single capture group and
    // matchAll only yields successful matches. Cast satisfies tsc strict.
    const slot = m[1] as string;
    if (!seen.has(slot)) {
      seen.add(slot);
      out.push(slot);
    }
  }
  return out;
}

function validateMalformed(raw: string): void {
  if (MALFORMED_RE.test(raw)) {
    throw new TemplateError(
      ERR.MALFORMED_TEMPLATE,
      "template contains unclosed `{{` or empty `{{}}` placeholder",
    );
  }
}
