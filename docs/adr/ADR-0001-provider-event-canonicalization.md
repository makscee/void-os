# ADR-0001 — Provider event canonicalization (A2A delta-style)

- **Status:** Accepted (amended 2026-05-16 — see below)
- **Date:** 2026-05-16
- **Supersedes:** the "canonicalization is deferred to a follow-up task" note in `daemon/src/providers/types.ts`

## Context

The `Provider` seam was introduced in VOS-86 with `ProviderEvent` intentionally loose (`{ type: string; [k: string]: unknown }`). This was a knowingly-deferred decision: the spec at `vault/projects/void-os/specs/2026-05-13-void-os-v1-architecture.md` and the `Provider` entry in `CONTEXT.md` both commit to A2A-shaped normalization, but the v1 ship made the choice that the first impl (`claude-code`) would pass the raw `stream-json` line shape straight through.

The deferred half is now causing real seam friction:

1. **Provider seam leaks into Chat layer.** `chat/orchestrator.ts:49,532` and `chat/dispatch-child.ts:43,183` import `extractAssistantText` from `providers/claude-code/index.ts`. A consumer reaching into a provider impl is a seam violation by construction.
2. **CC wire vocabulary lives in `chat/util.ts`.** The `CcRecordLike` interface and the `extractTurnText`/`extractToolUses`/`extractToolResults` parsers know about CC's `{message:{content:[{type:"text"|"tool_use"|"tool_result",...}]}}` shape, but live under `chat/`. The Chat layer is the wrong owner.
3. **Duplicate event loops.** `orchestrator.ts:511–600` and `dispatch-child.ts:180–220` both walk `ProviderEvent` with the same `if (evt.type === "assistant") { extractText; for extractToolUses; ... } else if (evt.type === "user") { for extractToolResults; ... }` ladder, both synthesize `DataPart { data: { kind, ... } }` wrappers around `ToolUseBlock` / `ToolResultBlock` shapes.
4. **Codex provider blocked.** Adding the reserved `codex` slot means a second set of impl-specific extractors spreading through `chat/util.ts`, not a single normalization step inside `providers/codex/`.

The Chat layer already converts to A2A `Part[]` immediately (`agentParts.push({text} as Part)` and `agentParts.push({data:{kind:"tool_use",...}} as Part)`); the daemon's canonical store (`messages-repo`) is A2A-shaped; `session-replay.walk()` round-trips A2A `Part[]`. The Provider boundary is the only place still emitting CC-shaped frames.

## Decision

`ProviderEvent` is now a discriminated union of A2A-shaped, delta-style events:

```ts
type ProviderEvent =
  | { type: "session"; sessionId: string }
  | { type: "parts"; role: Role; parts: Part[]; ts: number };
```

Run termination stays on `ProviderHandle.done`, which is already enumerated:

```ts
done: Promise<{ exitCode?: number; sessionId?: string; reason: "exit" | "cancel" | "timeout" | "error" }>;
```

`ProviderSpawnRequest` tightens at the same boundary:

```ts
interface ProviderSpawnRequest {
  runId: string;
  taskId: string;     // newly required; deletes the fake provider's `req as ... & {taskId, contextId}` widen hack
  contextId: string;  // newly required; canonical (chatId folded in — contextId IS chat-equivalent)
  prompt: string;
  cwd: string;
  resumeFrom?: string;
  timeouts?: { firstEventMs?: number; outputMs?: number; toolMs?: number };
  settings?: Record<string, unknown>;
}
```

Removed: `chatId` (use `contextId`), `kind` (today's only use is tagging `runs.kind`; lift into `settings.runKind` or default in impl).

### Why delta-style (`parts`) and not full-message (`{ type, message }`)

CC's `stream-json` emits multiple `assistant` events per logical Turn; `orchestrator` merges them via `mergeAdjacentTextParts` at terminal and assigns one `messageId` on `appendMessage`. A per-event `Message` carrying a `messageId` would be a lie — each event is a part-delta, not a `Message`. The delta shape models reality.

### Why pre-wrapped DataParts

`data.kind === "tool_use" | "tool_result"` is a void-os convention referenced at 5+ call sites (`messages-repo.walk()`, `ask-user-repo`, `session-replay`, `orchestrator`, `dispatch-child`). Emitting pre-wrapped `DataPart`s at the Provider boundary lets the consumer loop collapse to a single `agentParts.push(...evt.parts)` with no shape synthesis — the seam now does what the convention already implies.

### Why session-replay's CC-JSONL reader keeps the parsers

`chat/session-replay.ts:recordToEntries` still needs to parse CC's on-disk JSONL for the pre-VOS-80 legacy migration path. After the move, it imports `extractTurnText`/`extractToolUses`/`extractToolResults` from `providers/claude-code/cc-shape.ts` — the same parsers, by their actual nature: CC's wire format, parsed from disk vs. from spawn. Single owner. The two adapters (the impl's own normalizer + session-replay's legacy reader) make the seam real, not hypothetical.

## Layout after

```
daemon/src/providers/
  types.ts                     # ProviderEvent (canonical union), ProviderSpawnRequest (tightened)
  claude-code/
    cc-shape.ts                # NEW — owns CC wire format; exports extractTurnText/Uses/Results
    extract.ts                 # DELETED — was a 13-LOC re-export
    provider.ts                # normalizes on yield via cc-shape
    spawner.ts, parser.ts, ... # unchanged
  fake/
    index.ts                   # scripts stay CC-frame-shaped; normalize on yield (same code path as prod)

daemon/src/chat/
  util.ts                      # DELETED — CC vocabulary removed
  orchestrator.ts              # ~60-line event ladder shrinks to ~15; mergeAdjacentTextParts moves inline (only caller)
  dispatch-child.ts            # same shrinkage
  session-replay.ts            # imports cc-shape parsers for legacy JSONL path only
```

## Migration

Single PR. Surface is contained: ~4 live consumers + the fake provider script normalizer.

Order:
1. Add canonical `ProviderEvent` + `ProviderSpawnRequest` to `providers/types.ts`.
2. Create `providers/claude-code/cc-shape.ts` with the three extractors moved from `chat/util.ts`.
3. Normalize on yield in `providers/claude-code/provider.ts` (or whichever stage owns the iterator emit — likely `provider.ts` post-spawner) and in `providers/fake/index.ts`.
4. Rewrite consumer loops in `chat/orchestrator.ts` + `chat/dispatch-child.ts` against the canonical union.
5. Repoint `chat/session-replay.ts` imports to `providers/claude-code/cc-shape.ts`.
6. Move `mergeAdjacentTextParts` from `chat/orchestrator.ts:57` inline at its three callsites (only caller).
7. Delete `providers/claude-code/extract.ts` and `chat/util.ts`.
8. Move `chat/util.test.ts` cases under `providers/claude-code/__tests__/cc-shape.test.ts`.

### Fake provider scripts

Stay CC-frame-shaped (`{type:"assistant", message:{content:[...]}}` JSONL lines). The same normalizer runs on yield in both fake and prod paths — tests exercise the normalizer rather than bypass it. Higher fidelity to production.

## Consequences

**Positive:**
- **Locality.** CC wire format lives in one folder (`providers/claude-code/`). Adding `codex` = one normalizer in `providers/codex/`, zero edits to `chat/`.
- **Leverage.** Consumer loops shrink from ~60 lines of `else if (evt.type === "assistant") { ... }` ladders to ~15 lines that push pre-shaped `Part[]` onto a buffer.
- **Tests.** Orchestrator tests stop needing CC-shaped fixtures; they construct canonical events. Fake-provider tests gain coverage of the normalizer.
- **Unblocks RunDriver extraction.** The duplicated event loops in `orchestrator` + `dispatch-child` become structurally identical — a single `RunDriver` module becomes a small follow-up refactor.

**Negative / costs:**
- Single PR touches ~10 files. Contained, but not zero.
- Fake provider scripts gain a hidden coupling: their CC-shaped lines must remain valid input to the same normalizer prod uses. If CC's wire format changes upstream, both the prod normalizer and the fake fixtures need to track it. (Acceptable — that's already true today; the only change is the parser has one owner instead of two.)

**Reversibility:**
- Reversible by adding a `raw?: ProviderEvent` escape hatch on the canonical event and re-exporting the extractors. Not anticipated.

## Amendments

### 2026-05-16 — §"Why session-replay's CC-JSONL reader keeps the parsers" superseded by VOS-99

The second adapter (session-replay's legacy JSONL reader) was deleted because no live pre-VOS-80 chat data required preservation. `cc-shape.ts` now has a single consumer (`provider.ts`'s `normalizeCcEvent`). The cross-layer import from `chat/` into `providers/claude-code/*` is gone.
