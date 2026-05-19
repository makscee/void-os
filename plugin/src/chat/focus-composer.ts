// focus-composer.ts — VOS-151
//
// Shared focus-the-message-input helper used by ChatRoot when the operator
// switches chats (ChatList row click / keyboard) or picks an agent
// (AgentList row click / keyboard). Keeping the logic out of the React
// component lets a unit test cover the modal-open / null-textarea / pass-
// preventScroll cases without rendering the full chat tree.
//
// Design notes:
//   - `preventScroll: true` is non-negotiable: without it, focusing a
//     textarea inside a scrollable thread viewport can re-scroll the
//     panel, which directly violates the acceptance bullet "focus
//     transition does NOT scroll the chat panel".
//   - The modal/popover guard checks for Obsidian's `.modal-container`
//     element, which Obsidian inserts into <body> for `Modal` and
//     `SuggestModal` (including the agent picker). When a modal is open
//     we DO NOT steal focus — the modal owns it. The agent picker itself
//     dismisses BEFORE `onPickAgent` fires (picker resolves, modal closes,
//     React state update, focus call → no modal in DOM), so the guard
//     only matters for unrelated modals the operator may have open.

export interface FocusableTextArea {
  focus: (options?: { preventScroll?: boolean }) => void;
}

export interface FocusComposerDoc {
  querySelector: (sel: string) => unknown;
}

/** Returns `true` if focus was applied, `false` if skipped (null textarea
 *  or a modal/popover is open). */
export function focusComposerInputSafely(
  textarea: FocusableTextArea | null | undefined,
  doc: FocusComposerDoc,
): boolean {
  if (!textarea) return false;
  // If any modal/popover is open we leave focus where it is — Obsidian's
  // SuggestModal / Modal both render a `.modal-container` in <body>.
  if (doc.querySelector(".modal-container") != null) return false;
  textarea.focus({ preventScroll: true });
  return true;
}
