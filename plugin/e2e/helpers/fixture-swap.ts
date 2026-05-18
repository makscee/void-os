import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * VOS-127 T3 — fixture swap helper.
 *
 * Wraps the beforeEach/afterEach ceremony shared by chat-list-polish,
 * cost-meter, and permission-deny-ui specs: snapshot the file at `path`,
 * write a replacement, run the test body, then restore the original (or
 * unlink if the file did not exist before).
 *
 * Includes a LOUD guard for trap 3 (see plugin/CLAUDE.md "E2E gotchas"):
 *
 *   "ChatList isEmpty filter hides rows with no text turns. Plain
 *    vos_ask_user-only fixtures (e.g. ask-with-options.jsonl) produce
 *    rows that are filtered out. Emit at least one assistant text turn
 *    first ("thinking…") so the row renders."
 *
 * Guard logic: if `contents` parses as JSONL and contains a `vos_ask_user`
 * turn with NO preceding assistant text turn, throw before the swap is
 * applied. The check is best-effort — non-JSONL contents (e.g. raw JS, a
 * permission-deny fixture) skip the guard cleanly.
 */

const TRAP_3_MESSAGE =
  "fixture-swap trap-3 guard: fixture contains a `vos_ask_user` turn with no preceding " +
  "assistant text turn. ChatList's isEmpty filter will hide the row and the dot will be " +
  "unobservable. Emit at least one assistant text turn first (\"thinking...\") so the row " +
  "renders. See plugin/CLAUDE.md \"E2E gotchas\" trap 3.";

type JsonlTurn = {
  type?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
};

function isAssistantTextTurn(turn: JsonlTurn): boolean {
  if (turn.type !== "assistant") return false;
  const content = turn.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) => part?.type === "text" && typeof part.text === "string" && part.text.length > 0,
  );
}

function isAskUserTurn(turn: JsonlTurn): boolean {
  return turn.type === "vos_ask_user";
}

/**
 * Trap-3 guard. Returns true if the fixture is safe to swap in, false if
 * the contents are not JSONL we can reason about (in which case the
 * caller skips the guard). Throws if the contents are JSONL AND violate
 * the "assistant text before vos_ask_user" rule.
 */
function assertTrap3Safe(contents: string): void {
  const lines = contents.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return;

  const turns: JsonlTurn[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSONL we can reason about — skip the guard rather than risk
      // false positives on raw JS / mixed fixtures.
      return;
    }
    if (parsed && typeof parsed === "object") {
      turns.push(parsed as JsonlTurn);
    }
  }

  let sawAssistantText = false;
  for (const turn of turns) {
    if (isAssistantTextTurn(turn)) {
      sawAssistantText = true;
      continue;
    }
    if (isAskUserTurn(turn) && !sawAssistantText) {
      throw new Error(TRAP_3_MESSAGE);
    }
  }
}

/**
 * Swap `path` to `contents` for the duration of `fn`, then restore.
 *
 * - If the file existed before, the original bytes are restored in
 *   `finally` (even if `fn` throws).
 * - If the file did not exist before, the replacement is removed via
 *   `unlinkSync` in `finally`.
 * - The trap-3 guard runs BEFORE any write; if it throws, the file on
 *   disk is untouched and no restore is needed.
 */
export async function withFixtureSwap(
  path: string,
  contents: string,
  fn: () => Promise<void>,
): Promise<void> {
  assertTrap3Safe(contents);

  const existed = existsSync(path);
  const original = existed ? readFileSync(path, "utf8") : null;

  writeFileSync(path, contents);
  try {
    await fn();
  } finally {
    if (original === null) {
      try {
        unlinkSync(path);
      } catch {
        // File already gone — nothing to restore.
      }
    } else {
      writeFileSync(path, original);
    }
  }
}
