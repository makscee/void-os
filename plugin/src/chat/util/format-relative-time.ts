/**
 * Locale-aware relative time string suitable for narrow chat-list rows.
 * Uses Obsidian's bundled moment (runtime-external). The `true` flag
 * strips the "ago" suffix so the label stays compact (e.g. "5 minutes"
 * not "5 minutes ago"). Tests mock the `obsidian` module.
 *
 * Lazy require instead of static import value: obsidian ships .d.ts only —
 * importing values at module load fails outside the Obsidian runtime.
 *
 * Minimal call-site type: obsidian re-exports moment as `typeof import("moment")`,
 * but `moment` is not a declared dependency so that type resolves to a
 * non-callable namespace stub. We only need the `moment(ts).fromNow(strip)`
 * shape, so type the require result directly (VOS-167).
 */
type MomentLike = (ts: number) => { fromNow: (stripSuffix?: boolean) => string };

export function formatRelativeTime(updatedAt: number): string {
  const { moment } = require("obsidian") as { moment: MomentLike };
  return moment(updatedAt).fromNow(true);
}
