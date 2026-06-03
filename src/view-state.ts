// view-state.ts — pure predicates for the state-derived session view (VOS-210).
// No live process: liveTmux/ccId are resolved by the caller and passed in.

/**
 * The spawn-seeded placeholder (render.ts placeholderBody) is the "starting…" spinner doc.
 * Real content = a body.html the skill actually wrote. Discriminate on the placeholder's
 * stable signature rather than existsSync (the placeholder always exists on disk).
 */
export function bodyHasRealContent(html: string): boolean {
  if (!html.trim()) return false;
  const isPlaceholder =
    /<title>[^<]*— starting…<\/title>/.test(html) && html.includes('class="spinner"');
  return !isPlaceholder;
}

/** Attach/resume is offered iff a live tmux session OR a resumable ccId exists. */
export function isResumable(s: { liveTmux: boolean; ccId: string | null }): boolean {
  return s.liveTmux || s.ccId != null;
}
