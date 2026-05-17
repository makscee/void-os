import type { moment as MomentFn } from "obsidian";

/**
 * Locale-aware relative time string suitable for narrow chat-list rows.
 * Uses Obsidian's bundled moment (runtime-external). The `true` flag
 * strips the "ago" suffix so the label stays compact (e.g. "5 minutes"
 * not "5 minutes ago"). Tests mock the `obsidian` module.
 *
 * Lazy require instead of static import value: obsidian ships .d.ts only —
 * importing values at module load fails outside the Obsidian runtime.
 */
export function formatRelativeTime(updatedAt: number): string {
  const { moment } = require("obsidian") as { moment: typeof MomentFn };
  return moment(updatedAt).fromNow(true);
}
