// interactive-decide.ts — decide whether a skill launches as an interactive tmux REPL
// (VOS-206). Explicit frontmatter `interactive` flag wins; otherwise a name heuristic:
// conversational/iterative skills run interactive, pure-worker skills run print one-shot.
// Unknown skills default to print (conservative — preserves the pre-VOS-206 one-shot path).

/** Conversational skills that benefit from a live multi-turn REPL. */
const CONVERSATIONAL = new Set(["chat", "onboarding", "work"]);

export interface InteractiveDecidable {
  name: string;
  interactive?: boolean; // explicit frontmatter override
}

export function decideInteractive(meta: InteractiveDecidable): boolean {
  if (typeof meta.interactive === "boolean") return meta.interactive;
  return CONVERSATIONAL.has(meta.name);
}
