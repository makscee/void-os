# VOS-99 — session-replay decouples from cc-shape (design)

- **Task:** VOS-99
- **Date:** 2026-05-16
- **Status:** Draft
- **Supersedes:** ADR-0001 §"Why session-replay's CC-JSONL reader keeps the parsers" (in part — see §6)

## 1. Scope & architecture

`chat/session-replay.ts` becomes a thin DB walker. The legacy CC-JSONL migration code — lazy-fired on the first `walk()` of a pre-VOS-80 chat — is deleted outright, along with its tests. `messages-repo.walk()` is the only source `walk()` reads from.

The cross-layer import from `chat/` into `providers/claude-code/cc-shape.ts` goes away as a side effect: once `recordToEntries`, `legacyJsonlOrder`, and `importFromJsonl` are gone, nothing in `chat/session-replay.ts` references `providers/claude-code/*`. The acceptance grep `grep -r "from.*providers/claude-code" daemon/src/chat/` returns empty.

## 2. File-level changes

### `daemon/src/chat/session-replay.ts` (336 LOC → ~80 LOC)

**Delete:**
- Imports: `readFileSync`, `existsSync`, `realpathSync` (node:fs), `join` (node:path), `homedir` (node:os), `openTaskFor` (./repo), `extractTurnText`, `extractToolUses`, `extractToolResults` (../providers/claude-code/cc-shape), `Part`, `Role` (../types/a2a).
- Functions: `defaultEncode`, `recordToEntries`, `legacyJsonlOrder`, `importFromJsonl`.
- Types/interfaces: `JsonlRecord`, `ReplayOpts` (its three fields — `projectsRoot`, `cwd`, `encodeCwd` — have no remaining consumer).
- Module constants tied only to the deleted code: `VISIBLE_TYPES`.

**Keep:**
- Interfaces: `TextMessage`, `ToolUseEntry`, `ToolResultEntry`, `ReplayEntry`, `SessionReplay`.
- Imports: `Database` (bun:sqlite), `makeChatRepo` (./repo), `makeMessagesRepo` (./messages-repo), `readTrace` (../trace/reader).
- Function: `surfaceTraceDiagnostics` (unchanged).

**Signature change:**
- `makeSessionReplay(db: Database, opts: ReplayOpts = {}): SessionReplay` → `makeSessionReplay(db: Database): SessionReplay`. No remaining caller passes opts (verified: `app.ts:101` calls `makeSessionReplay(deps.db)`; `api/chat.ts:31` passes `opts.replay` which becomes a dead override — see §2.2).

**`walk()` body simplifies to:**

```ts
walk(chatId) {
  const chat = chatRepo.get(chatId);
  if (!chat) return [];
  const existing = messages.walk(chatId);
  if (existing.length > 0) {
    surfaceTraceDiagnostics(chatId);
    return existing;
  }
  return [];
}
```

The lazy-import branch (current lines 322–333) is deleted. The behavioural change for chats with `session_id` set but no DB rows: walk returns `[]` instead of attempting on-disk migration. Per user confirmation, no such chats exist that matter.

### `daemon/src/api/chat.ts`

- `makeChatRouter`'s options surface currently includes `opts.replay?: ReplayOpts` plumbed into `makeSessionReplay(db, opts.replay)`. Drop the `replay` option and the parameter forward. Tests that constructed routers with a `replay:` override are pruned in §3.
- Remove `type ReplayOpts` from the import statement at `api/chat.ts:17-19` (the type is deleted in `session-replay.ts`; leaving the import line points at nothing and `tsc` fails).
- Also drop any `ReplayOpts` re-export from `api/chat.ts`.
- Re-exports `makeSessionReplay`, `SessionReplay`, `ReplayEntry` unchanged — public read-side surface preserved.

### `daemon/src/app.ts`

- Line 101 `makeSessionReplay(deps.db)` is already opts-less. Confirm no change needed; no edit expected.

### `daemon/test/chat/session-replay-lazy-import.test.ts`

DELETE (235 LOC). The file's sole purpose is the lazy-JSONL-import behaviour; with the path gone, nothing to test.

### `daemon/test/chat/session-replay.test.ts` (794 LOC)

Audit + prune. **Delete a test iff both conditions hold:**
- **(a)** the test constructs `makeSessionReplay` with non-empty opts (`projectsRoot`, `cwd`, or `encodeCwd`) OR writes a `.jsonl` file to drive the lazy import path; AND
- **(b)** the test does **not** also assert on `messages-repo`-seeded rows (i.e. removing it costs no DB-walk coverage).

Generic primitives (`mkdtempSync`, `writeFileSync` to non-`.jsonl` paths) are not sufficient signals on their own — many DB-walk fixtures legitimately use them.

**Protocol:** the executing subagent lists the deletion candidates with one-line justification before deleting, and waits for orchestrator confirmation. Tests that only seed the messages table directly (via `messages.appendMessage` or via running the orchestrator/fake provider): keep.

After the prune, expected residue: DB-walk surface tests, trace-diagnostics tests, empty-chat tests. Retention LOC is whatever the (a) AND (b) rule yields — not a target.

### `daemon/src/providers/claude-code/cc-shape.ts`

No edit. Its second consumer disappears; `extractTurnText`, `extractToolUses`, `extractToolResults` still serve `provider.ts`'s `normalizeCcEvent`. Whether `normalizeCcEvent` still requires them as separate exports (vs. inlining) is a follow-up question for the Provider-folder consolidation candidate — out of scope here.

### `docs/adr/ADR-0001-provider-event-canonicalization.md`

Update the line-3 front-matter bullet from `- **Status:** Accepted` to `- **Status:** Accepted (amended 2026-05-16 — see below)`, and append a new `## Amendments` section at the end of the file:

> **2026-05-16 — §"Why session-replay's CC-JSONL reader keeps the parsers" superseded by VOS-99.** The second adapter (session-replay's legacy JSONL reader) was deleted because no live pre-VOS-80 chat data required preservation. `cc-shape.ts` now has a single consumer (`provider.ts`'s `normalizeCcEvent`). The cross-layer import from `chat/` into `providers/claude-code/*` is gone.

## 3. Test plan

**New test (required by acceptance):** in `daemon/test/chat/session-replay.test.ts`, add an explicit assertion that `walk()` returns `[]` for a chat row with `session_id` set but zero messages rows — the post-deletion behaviour for what used to be the lazy-import trigger. One short test, no fixtures.

**Round-trip assertion (required by acceptance bullet #3):** also in `session-replay.test.ts`, a test that walks a chat seeded via `messages-repo` with one tool-call turn (one tool_use part, one tool_result part) and asserts the resulting `ReplayEntry[]` shape contains the expected `tool_use` + `tool_result` entries with no CC vocabulary in fixtures or assertions (no `{type: "tool_use"}` content-block shape, no `message.content[]`). This proves the test fixtures are CC-vocab-free per the acceptance criterion. If an equivalent test already exists in the retained subset, no new test needed — verify during execution.

**Behavioural regression check (acceptance bullet #4):** existing replay tests in `session-replay.test.ts` that don't depend on JSONL (post-prune) verify wire-shape stability. Manual check: open one chat with a tool-call turn in the void-os plugin, confirm replay renders identically pre/post.

**Test commands (worktree-rooted):**
- `cd workspace/void-os && bun test daemon/test/chat/session-replay.test.ts`
- `cd workspace/void-os && bun test daemon/test/chat/` (broader chat-layer regression sweep)
- `cd workspace/void-os && bun test` (full daemon test suite — final gate)

## 4. Sequencing

Single PR, single subagent, ~one-shot edit. Recommended order to keep the type checker happy at every step:

1. Delete `daemon/test/chat/session-replay-lazy-import.test.ts`.
2. Edit `daemon/src/chat/session-replay.ts`: delete dead imports, types, and functions; simplify `walk()`; remove `ReplayOpts` parameter from `makeSessionReplay`.
3. Edit `daemon/src/api/chat.ts`: drop `opts.replay` plumbing.
4. Prune `daemon/test/chat/session-replay.test.ts`: remove JSONL-dependent tests; add the new empty-walk + tool-call-round-trip assertions if not already present.
5. Append the ADR-0001 status amendment.
6. Run test commands from §3; iterate until green.
7. Confirm the acceptance grep returns empty.

## 5. Acceptance verification

| Acceptance bullet | Verification |
|---|---|
| `chat/session-replay.ts` no longer imports from `providers/claude-code/*` | `grep -r "from.*providers/claude-code" daemon/src/chat/` returns empty (run from worktree) |
| Legacy CC JSONL replay path deleted (option b) | `git grep -E "importFromJsonl|legacyJsonlOrder|recordToEntries"` returns empty in `daemon/` |
| Tests assert replay round-trips without CC vocabulary in fixtures | Tool-call-round-trip test in `session-replay.test.ts` reviewed, passes; no `message.content[]` shape in any retained test fixture |
| No behavioural change to plugin-visible chat history | Pruned `session-replay.test.ts` green; manual void-os plugin spot-check on one chat with a tool-call turn |
| Code review evidence logged in Work Log | Subagent-driven code review run + entry in task Work Log |

## 6. Risk + reversibility

**Risk: a chat exists with `session_id` set but no DB rows.** Behavioural impact: that chat now renders empty in the plugin instead of attempting to seed from JSONL. Mitigation: user-confirmed no such data matters. No code mitigation.

**Risk: ADR-0001 readers cite the now-superseded paragraph.** Mitigation: the §Status amendment is appended in the same PR.

**Reversibility:** trivial via `git revert` until merged. Post-merge: rebuilding the JSONL reader requires reinstating the three deleted functions from history — straightforward, no schema cost.

## 7. Out of scope

- `cc-shape.ts` internal consolidation (merging into `provider.ts`) — separate candidate, currently in grilling, may absorb this task or follow it.
- `normalizeCcEvent`'s relationship to `extractTurnText`/`extractToolUses`/`extractToolResults` — same.
- Any change to the VOS-84 trace path (`surfaceTraceDiagnostics`, `readTrace`).
- Any change to `messages-repo.walk()` semantics or migration `0007_a2a_tables.sql`.

## 8. Decisions captured (from brainstorming, 2026-05-16)

1. No live pre-VOS-80 chat data needs preservation → option (b) selected over option (a).
2. Cleanup depth: remove JSONL path only; keep `ReplayEntry` types, `walk()`, `surfaceTraceDiagnostics`; session-replay stays the public read-side module (option 1 of 3 in clarifier #2).
3. ADR-0001 superseded inline (`## Status` amendment), not via a new ADR-0003.
