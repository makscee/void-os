# VOS-99 — session-replay decouples from cc-shape (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the legacy CC-JSONL migration path from `chat/session-replay.ts`, removing the last cross-layer import from `chat/` into `providers/claude-code/`.

**Architecture:** `session-replay` becomes a thin DB walker over `messages-repo.walk()`. The `importFromJsonl`/`legacyJsonlOrder`/`recordToEntries` triad and its `cc-shape` parser dependency are deleted outright. The `ReplayOpts` test seam (`projectsRoot`/`cwd`/`encodeCwd`) has no remaining consumer and is dropped along with the `api/chat.ts` plumbing. Lazy-import tests (235 LOC) are deleted; `session-replay.test.ts` is pruned with a deliberate (a)+(b) gate. ADR-0001 is amended inline.

**Tech Stack:** TypeScript, Bun (test runner + sqlite), Hono. Worktree: `/Users/admin/hub-wt/VOS-99`; void-os repo: `<worktree>/workspace/void-os`; branch: `task/VOS-99`.

**Spec:** `docs/superpowers/specs/2026-05-16-VOS-99-session-replay-decouple-from-cc-shape-design.md` (commit `e3fb07f`).

**Working directory for all commands:** `/Users/admin/hub-wt/VOS-99/workspace/void-os` (absolute). Every `git`, `bun`, and edit operates inside this directory unless stated otherwise. All commits go on `task/VOS-99`; never push.

---

### Task 1: Delete the lazy-import test file

**Files:**
- Delete: `daemon/test/chat/session-replay-lazy-import.test.ts` (235 LOC, sole purpose = legacy JSONL import path)

- [ ] **Step 1: Confirm the file exists**

```bash
ls -1 daemon/test/chat/session-replay-lazy-import.test.ts
```

Expected: prints the path.

- [ ] **Step 2: Delete via `git rm`**

```bash
git rm daemon/test/chat/session-replay-lazy-import.test.ts
```

Expected: `rm 'daemon/test/chat/session-replay-lazy-import.test.ts'`.

- [ ] **Step 3: Commit**

```bash
git commit -m "test(VOS-99): delete session-replay-lazy-import.test.ts

The legacy JSONL import path it covers is being removed; no production
behaviour remains to test."
```

---

### Task 2: Strip JSONL path from session-replay.ts

**Files:**
- Modify: `daemon/src/chat/session-replay.ts` (336 LOC → ~80 LOC)

This is a pure deletion task. No new tests yet — Task 4 adds them. The intent is to land a clean source file that compiles; Task 3 untangles the consumer in the same compile-pass.

- [ ] **Step 1: Read the current file end-to-end**

```bash
cat daemon/src/chat/session-replay.ts | wc -l
```

Expected: 336.

Read the full file to anchor what gets kept vs. deleted. Use `Read` tool (the file will be modified next).

- [ ] **Step 2: Replace the file with the post-deletion shape**

Write the file contents below to `daemon/src/chat/session-replay.ts`, replacing everything currently there. The result must compile under `tsc` (Task 3 finishes the consumer side, so an intermediate `tsc` may still flag `api/chat.ts` — that's expected and resolved in Task 3).

```ts
// session-replay reads the canonical `messages` table as the single source
// of truth for /chat/:id/messages. The orchestrator persists every
// user/assistant/tool event into it (see chat/messages-repo.ts and
// chat/orchestrator.ts), and the API layer walks this view.
//
// Pre-VOS-80 legacy import (CC JSONL → messages table seed) was removed in
// VOS-99 after confirming no live data depended on it. See ADR-0001
// `## Amendments` (2026-05-16) for the seam decision history.

import type { Database } from "bun:sqlite";
import { makeChatRepo } from "./repo";
import { makeMessagesRepo } from "./messages-repo";
import { readTrace } from "../trace/reader";

/** A visible text turn (user prompt or assistant narration). */
export interface TextMessage {
  role: "user" | "assistant";
  content: string;
  ts?: number;
  /** True when this assistant turn's run was marked cancelled (ESC cancel).
   *  Surfaced via LEFT JOIN runs in messages-repo.walk() so the plugin can
   *  render a "stopped" badge on the cached server-truth entry without
   *  relying on the optimistic pendingStoppedRunId path. Always omitted for
   *  user entries. */
  cancelled?: boolean;
}

/** A tool invocation block lifted out of an assistant turn's content[]. */
export interface ToolUseEntry {
  role: "tool_use";
  tool_call_id: string;
  name: string;
  input: unknown;
  ts?: number;
}

/** A tool result block lifted out of a user-role turn's content[]. */
export interface ToolResultEntry {
  role: "tool_result";
  tool_call_id: string;
  output: unknown;
  is_error: boolean;
  ts?: number;
}

/** Discriminated union surfaced to /chat/:id/messages. The plugin S4 panel
 * walks this list, rendering text turns inline and {tool_use, tool_result}
 * pairs in the tool-call panel keyed by tool_call_id. */
export type ReplayEntry = TextMessage | ToolUseEntry | ToolResultEntry;

export interface SessionReplay {
  walk(chatId: string): ReplayEntry[];
}

export function makeSessionReplay(db: Database): SessionReplay {
  const chatRepo = makeChatRepo(db);
  const messages = makeMessagesRepo(db);

  // VOS-84: surface partial/gap diagnostics from the daemon-side VOS-84
  // trace for the chat's most-recent run. The messages table remains the
  // authoritative view for /chat/:id/messages (per VOS-80a), so the trace
  // diagnostics are advisory — they help operators notice torn JSONL or
  // dropped sequences without changing the wire shape returned to callers.
  function surfaceTraceDiagnostics(chatId: string): void {
    type Row = { trace_path: string | null } | undefined;
    const row = db
      .query(
        "SELECT trace_path FROM runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(chatId) as Row;
    if (!row || !row.trace_path) return;
    const { records, gaps, recoveredPartial } = readTrace(row.trace_path);
    if (recoveredPartial) {
      console.warn(
        `session-replay: trace ${row.trace_path} had partial trailing line, recovered ${records.length} records`,
      );
    }
    if (gaps.length > 0) {
      console.warn(
        `session-replay: trace ${row.trace_path} has ${gaps.length} gap(s):`,
        gaps,
      );
    }
  }

  return {
    walk(chatId) {
      const chat = chatRepo.get(chatId);
      if (!chat) return [];
      const existing = messages.walk(chatId);
      if (existing.length > 0) {
        surfaceTraceDiagnostics(chatId);
        return existing;
      }
      return [];
    },
  };
}
```

- [ ] **Step 3: Confirm cross-layer import is gone**

```bash
grep -rn "from.*providers/claude-code" daemon/src/chat/
```

Expected: no output (exit code 1).

- [ ] **Step 4: Confirm deleted symbols are gone from `daemon/src/`**

```bash
git grep -E "importFromJsonl|legacyJsonlOrder|recordToEntries" daemon/src/
```

Expected: no output. (Test files may still reference these; cleared in Task 4.)

- [ ] **Step 5: Stage but do not commit yet**

```bash
git add daemon/src/chat/session-replay.ts
```

Defer the commit to Task 3 — the intermediate state breaks `api/chat.ts`'s `ReplayOpts` import; the two edits commit together to keep `master` always-buildable.

---

### Task 3: Drop ReplayOpts plumbing from api/chat.ts

**Files:**
- Modify: `daemon/src/api/chat.ts` (lines 5, 13–32 affected)

- [ ] **Step 1: Verify current imports + opts shape**

```bash
sed -n '1,35p' daemon/src/api/chat.ts
```

Expected (header comment + import + ChatApiOpts):
```ts
//   - GET  /chat/:id/messages   → sessionReplay walk over CC's JSONL DAG
...
import {
  makeSessionReplay,
  type ReplayOpts,
} from "../chat/session-replay.ts";
...
export interface ChatApiOpts {
  // Optional override for session-replay (test seam: projectsRoot, cwd, encodeCwd).
  replay?: ReplayOpts;
  ...
}
...
  const replay = makeSessionReplay(db, opts.replay);
```

- [ ] **Step 2: Apply the four edits**

Make the following edits to `daemon/src/api/chat.ts`:

**Edit A** — header comment (line 5). The "JSONL DAG" framing is wrong post-VOS-80; tighten while we're here.

Replace:
```
//   - GET  /chat/:id/messages   → sessionReplay walk over CC's JSONL DAG
```
with:
```
//   - GET  /chat/:id/messages   → sessionReplay walk over the messages table
```

**Edit B** — import block (lines 16–19). Drop `type ReplayOpts`.

Replace:
```ts
import {
  makeSessionReplay,
  type ReplayOpts,
} from "../chat/session-replay.ts";
```
with:
```ts
import { makeSessionReplay } from "../chat/session-replay.ts";
```

**Edit C** — `ChatApiOpts` interface (lines 22–27). Drop the `replay` field + its comment.

Replace:
```ts
export interface ChatApiOpts {
  // Optional override for session-replay (test seam: projectsRoot, cwd, encodeCwd).
  replay?: ReplayOpts;
  // Optional orchestrator. When omitted, POST /chat/:id/message returns 500.
  orchestrator?: Orchestrator;
}
```
with:
```ts
export interface ChatApiOpts {
  // Optional orchestrator. When omitted, POST /chat/:id/message returns 500.
  orchestrator?: Orchestrator;
}
```

**Edit D** — `chatApi` factory body (line 31). Drop `opts.replay`.

Replace:
```ts
  const replay = makeSessionReplay(db, opts.replay);
```
with:
```ts
  const replay = makeSessionReplay(db);
```

- [ ] **Step 3: Confirm no remaining `ReplayOpts` reference in daemon source**

```bash
git grep "ReplayOpts" daemon/src/
```

Expected: no output.

- [ ] **Step 4: Type-check the daemon**

```bash
cd daemon && bun run typecheck 2>&1 | head -40; cd ..
```

(`daemon/package.json` has `"typecheck": "tsc --noEmit"`.)

Expected: zero errors. If `api/chat.ts` still has stale `ReplayOpts` references, fix them per Step 2 and re-run.

- [ ] **Step 5: Commit Tasks 2 + 3 together**

```bash
git add daemon/src/api/chat.ts
git commit -m "refactor(VOS-99): session-replay drops CC-JSONL import path

session-replay.ts becomes a thin DB walker over messages-repo.walk;
importFromJsonl/legacyJsonlOrder/recordToEntries and the ReplayOpts
test seam are deleted. api/chat.ts drops the matching opts.replay
plumbing. No remaining caller passes opts.

Closes the last chat/-into-providers/claude-code cross-layer import
per ADR-0001 §Amendments (2026-05-16).

Refs VOS-99."
```

---

### Task 4: Prune session-replay.test.ts

**Files:**
- Modify: `daemon/test/chat/session-replay.test.ts` (794 LOC, expected to shrink)

**Deletion gate** (refines spec §2.5 after verifying repo state: all 18 existing `makeSessionReplay(db, …)` calls in this file pass opts, so "non-empty opts" cannot stand alone as a deletion signal).

**Delete a test iff both conditions hold:**
- **(a)** the test writes a `.jsonl` file to disk **OR** passes `projectsRoot` / `cwd` / `encodeCwd` to `makeSessionReplay` to drive disk reads (the actual JSONL-fixture coupling); AND
- **(b)** the test does **not** also assert on `messages-repo`-seeded rows (removing it costs no DB-walk coverage).

The `makeSessionReplay(db, { … })` → `makeSessionReplay(db)` conversion is a **separate mechanical pass**, not a deletion signal — once `ReplayOpts` is deleted in Tasks 2–3 the trailing arg is dead syntax. Strip it from retained tests via the sed pass in Step 0 below.

The candidate-list-before-delete protocol is mandatory: print the list, stop, await orchestrator confirmation.

- [ ] **Step 0: Mechanical opts-arg strip (must run before any deletion analysis)**

Once Tasks 2 + 3 are merged, the `, { … }` second arg to `makeSessionReplay` is dead. Strip it across all surviving tests so the deletion gate (a) operates on disk-fixture coupling, not on opts presence:

```bash
# Preview matches first.
grep -nE "makeSessionReplay\(db,\s*\{" daemon/test/chat/session-replay.test.ts
```

Then for each retained test that previously injected `projectsRoot`/`cwd`/`encodeCwd` from a tempdir, decide per gate (a): if the test stays, the opts block is replaced with `makeSessionReplay(db)` (and any tempdir scaffolding for disk reads becomes dead — remove it). If the test is deleted via gate (a)+(b), skip — it's going anyway.

Do this manually per test, not with a global sed — each test has its own setup paragraph and a blind global replace would corrupt tests that legitimately use the tempdir for other purposes (e.g. messages-repo seed via orchestrator).

- [ ] **Step 1: Identify candidate deletion blocks**

Run the discovery greps:

```bash
echo "--- (a1) tests writing .jsonl ---"
grep -nE "writeFileSync\(.+\.jsonl|jsonl.*writeFileSync" daemon/test/chat/session-replay.test.ts || echo "(none)"

echo "--- (a2) projectsRoot / cwd / encodeCwd overrides ---"
grep -nE "projectsRoot|encodeCwd|\bcwd:" daemon/test/chat/session-replay.test.ts || echo "(none)"

echo "--- (b) messages-repo seed calls ---"
grep -nE "messages\.appendMessage|appendMessage\(" daemon/test/chat/session-replay.test.ts || echo "(none)"

echo "--- test() / it() boundaries (for block extraction) ---"
grep -nE "^(test|it|describe)\(" daemon/test/chat/session-replay.test.ts | head -40
```

- [ ] **Step 2: List candidates with one-line justification**

For each `test(...)` / `it(...)` block that matches gate (a) above, walk its body and check gate (b): does it also call `messages.appendMessage` or invoke the orchestrator/fake provider to seed the messages table? If yes, the test stays — only the `.jsonl` setup portion (if any) is removed. If no, the whole block is a deletion candidate.

Produce a markdown list (write to a scratch file or print) of the form:

```
- L<start>–L<end> · test("<name>") · DELETE — reason: <one line, references gate>
- L<start>–L<end> · test("<name>") · TRIM   — reason: <what to remove, what to keep>
- L<start>–L<end> · test("<name>") · KEEP   — reason: gate (a) matches but (b) also matches
```

**Stop here.** Do not delete anything yet. Print this list as your subagent report so the orchestrator can confirm before destructive edits.

- [ ] **Step 3 (after orchestrator confirmation): apply deletions and trims**

Apply each `DELETE` / `TRIM` action listed above. For any test that needed the deleted imports (`readFileSync`, `mkdirSync`, `mkdtempSync` from node-fs, `tmpdir`, `join` with no other call site), remove the now-unused imports too.

- [ ] **Step 4: Add the empty-walk assertion (spec §3 acceptance #1)**

If a test for "chat row exists with `session_id` set but zero messages rows → `walk()` returns `[]`" is not already in the retained set, append this test at the end of the file (adjust `describe(...)` nesting to match the file's existing structure):

```ts
test("walk returns [] for a chat with session_id but no messages rows", () => {
  const db = freshDb();
  const chatRepo = makeChatRepo(db);
  const { id } = chatRepo.create({ agent: "claude-code" });
  chatRepo.setSession(id, "session-no-rows");
  const replay = makeSessionReplay(db);
  expect(replay.walk(id)).toEqual([]);
});
```

Signature reference (`daemon/src/chat/repo.ts`): `create(opts: { agent: string }): CreateChatResult` (the chat id is `CreateChatResult.id`); `setSession(id, sessionId): void`.

- [ ] **Step 5: Confirm the tool-call round-trip assertion exists (spec §3 acceptance #3)**

Look for a retained test that:
1. seeds a chat with one assistant turn containing a `tool_use` `Part` and one user turn containing a `tool_result` `Part` via `messages.appendMessage`,
2. walks the chat,
3. asserts the resulting `ReplayEntry[]` contains a `{role: "tool_use", tool_call_id, name, input}` entry and a `{role: "tool_result", tool_call_id, output, is_error}` entry,
4. uses no CC-shape vocabulary in fixtures (no `message: { content: [{ type: "tool_use", ... }] }`).

If absent, add it. Reuse the file's existing helpers (`freshDb`, `makeChatRepo`, etc.) — do not reinvent setup.

- [ ] **Step 6: Run the file in isolation**

```bash
bun test daemon/test/chat/session-replay.test.ts
```

Expected: all tests pass. If any test fails because it depended on a deleted helper (e.g. a top-level `writeLegacyJsonl` removed in Step 3), delete the dead helper.

- [ ] **Step 7: Run the broader chat-layer sweep**

```bash
bun test daemon/test/chat/
```

Expected: pass. Any unrelated chat-layer failure is a real regression — do not paper over.

- [ ] **Step 8: Commit**

```bash
git add daemon/test/chat/session-replay.test.ts
git commit -m "test(VOS-99): prune session-replay.test.ts JSONL-import cases

Per VOS-99 spec §2.5 gate (a)+(b): removed tests that exercised only the
deleted lazy-import path. Added empty-walk + tool-call-round-trip
assertions per acceptance §3.

Refs VOS-99."
```

---

### Task 5: Amend ADR-0001

**Files:**
- Modify: `docs/adr/ADR-0001-provider-event-canonicalization.md` (line 3 + EOF append)

- [ ] **Step 1: Update the front-matter Status line**

Replace line 3:
```
- **Status:** Accepted
```
with:
```
- **Status:** Accepted (amended 2026-05-16 — see below)
```

- [ ] **Step 2: Append the Amendments section at EOF**

Append the following block to the end of `docs/adr/ADR-0001-provider-event-canonicalization.md` (insert a blank line first if the file does not already end with one):

```markdown

## Amendments

### 2026-05-16 — §"Why session-replay's CC-JSONL reader keeps the parsers" superseded by VOS-99

The second adapter (session-replay's legacy JSONL reader) was deleted because no live pre-VOS-80 chat data required preservation. `cc-shape.ts` now has a single consumer (`provider.ts`'s `normalizeCcEvent`). The cross-layer import from `chat/` into `providers/claude-code/*` is gone.
```

- [ ] **Step 3: Commit**

```bash
git add docs/adr/ADR-0001-provider-event-canonicalization.md
git commit -m "docs(VOS-99): amend ADR-0001 — session-replay no longer keeps CC parsers

Inline amendment supersedes the §\"Why session-replay's CC-JSONL reader
keeps the parsers\" paragraph. cc-shape.ts now has a single consumer.

Refs VOS-99."
```

---

### Task 6: Full-suite verification + acceptance grep

**Files:** none modified. Verification only.

- [ ] **Step 1: Full daemon test suite**

```bash
bun test
```

Expected: all tests pass. Any unrelated failure is a regression to investigate, not paper over.

- [ ] **Step 2: Acceptance grep #1 (cross-layer import gone)**

```bash
grep -rn "from.*providers/claude-code" daemon/src/chat/
```

Expected: no output, exit code 1.

- [ ] **Step 3: Acceptance grep #2 (deleted symbols gone repo-wide)**

```bash
git grep -E "importFromJsonl|legacyJsonlOrder|recordToEntries"
```

Expected: no output. Repo-root scope (no path filter) catches stray references in `cli/`, `plugin/`, `scripts/`, `docs/` examples, etc. Any non-`daemon/` hit is real scope creep — surface it, do not silently merge.

- [ ] **Step 4: Acceptance grep #3 (`ReplayOpts` purged repo-wide)**

```bash
git grep "ReplayOpts"
```

Expected: no output.

- [ ] **Step 5: Acceptance grep #4 (no CC vocab in retained test fixtures)**

```bash
grep -rnE '"type"\s*:\s*"(tool_use|tool_result)"|message:\s*\{[^}]*content:\s*\[' daemon/test/chat/session-replay.test.ts
```

Expected: no output. (A non-empty result is a fixture leaning on raw CC shape — replace it with `messages.appendMessage` calls using canonical `Part[]`.)

- [ ] **Step 6: Manual plugin spot-check (spec §5 acceptance #4)**

Open one chat with a tool-call turn in the void-os Obsidian plugin pointed at this daemon build. Confirm the tool-call panel renders identically pre/post. Log the chat ID and a one-line "rendered identically" / "regression: <what>" note in the task Work Log.

This is a human-in-the-loop step. The subagent does not perform it; the orchestrator runs the daemon and operates the plugin, then logs the outcome.

- [ ] **Step 7: Code review (spec §5 acceptance #5)**

The orchestrator dispatches `superpowers:requesting-code-review` against the full `task/VOS-99` branch diff after Task 5 commits. The review report is appended to the task Work Log.

This step is the orchestrator's responsibility, not the implementation subagent's.

---

## Final state checklist

After all six tasks land, the following are true on `task/VOS-99` in `/Users/admin/hub-wt/VOS-99/workspace/void-os`:

- [ ] `daemon/src/chat/session-replay.ts` has no `providers/claude-code` imports.
- [ ] `daemon/test/chat/session-replay-lazy-import.test.ts` does not exist.
- [ ] `daemon/test/chat/session-replay.test.ts` has no `.jsonl`-fixture tests; has the empty-walk + tool-call-round-trip assertions.
- [ ] `daemon/src/api/chat.ts` has no `ReplayOpts` import, no `replay?: ReplayOpts` field, no `opts.replay` argument.
- [ ] `docs/adr/ADR-0001-provider-event-canonicalization.md` line 3 reads `- **Status:** Accepted (amended 2026-05-16 — see below)` and has a `## Amendments` section at EOF.
- [ ] `bun test` passes from `daemon/`.
- [ ] All five acceptance greps in Task 6 return empty.
- [ ] Plugin spot-check + code review entries appended to the task Work Log.

Then `/done VOS-99`.
