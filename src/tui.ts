// tui.ts — arrow-key TUI menu for void-os CLI
// Uses @clack/prompts for a clean, minimal interactive experience.
// Non-TTY / piped invocation: gracefully exits without blocking.

import * as p from "@clack/prompts";

export type MenuAction =
  | "init"
  | "serve"
  | "list-sessions"
  | "quit";

export interface MenuItem {
  value: MenuAction;
  label: string;
  hint?: string;
}

/** Full list of menu items in display order. Pure data — testable without I/O. */
export const MENU_ITEMS: MenuItem[] = [
  { value: "init",          label: "init",           hint: "set up a new void-os vault" },
  { value: "serve",         label: "serve",          hint: "start the void-os web server" },
  { value: "list-sessions", label: "list sessions",  hint: "show all sessions in the vault" },
  { value: "quit",          label: "quit",           hint: "exit" },
];

/** Map a MenuAction to the argv[] that would invoke it via subcommand. */
export function actionToArgv(action: MenuAction): string[] {
  switch (action) {
    case "init":          return ["init"];
    case "serve":         return ["serve"];
    case "list-sessions": return ["list-sessions"];
    case "quit":          return [];
  }
}

/** Returns true if stdin is a real TTY (interactive). */
export function isTty(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Run the interactive arrow-key menu.
 * Returns the selected action, or null if cancelled / non-TTY.
 */
export async function runMenu(): Promise<MenuAction | null> {
  if (!isTty()) {
    return null;
  }

  p.intro("void-os");

  const selected = await p.select<MenuAction>({
    message: "what do you want to do?",
    options: MENU_ITEMS.map((item) => ({
      value: item.value,
      label: item.label,
      hint: item.hint,
    })),
  });

  if (p.isCancel(selected)) {
    p.cancel("cancelled");
    return null;
  }

  return selected as MenuAction;
}
