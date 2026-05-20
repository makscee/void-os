# VOS-155 — Live state inspector (spec + phasing proposal)

## One-liner

Operator opens the vault, sees every in-flight agent's current activity in real time, and can pause / kill / resume / branch each one — without flooding the main session context.

## Constraints (frozen by operator 2026-05-20)

1. **Union event source.** Aggregate (A) Claude Code harness hooks (`PreToolUse` / `PostToolUse` + subagent stdout/status) and (B) void-os daemon agent runtime (`ask_agent` dispatch, MCP tool calls). One unified stream powers one view.
2. **Two pause verbs.** `pause` = soft (let current tool return, halt at next checkpoint). `kill` = hard (interrupt + record abort). Resume only works on paused, not killed.
3. **Branch = new worktree.** New task ID, branch from parent HEAD (clean state — no WIP carryover). Reuse `tools/worktree/wt up <NEW-ID>` + teardown.
4. **Schema: impl proposes.** v1 baseline `{ts, agent_id, parent_id, kind, summary}`. Extend only if union-source needs more.

## Surface map (discovery, 2026-05-20)

### Source B already exists (daemon runtime)

- `daemon/src/events/index.ts` — `createEventBus({db})`, types `DaemonEvent`.
- Daemon already emits: `chat.token`, `chat.tool_use`, `chat.tool_result`, `run_end`, `task.state_changed`, `message.appended`.
- Fan-out paths today: WS broadcast (plugin) + SSE `/chat/:id/stream` (CLI). Bus is per-process, in-memory.
- `dispatch-child.ts` — spawns ask_agent children with chatId.
- `providers/claude-code/parser.ts` — parses stream-json from `claude --output-format stream-json`. Already gives us tool_use / tool_result per turn.
- `trace/writer.ts` — JSONL trace writer (per-chat events to disk).
- `tools/handoff-log/hl` (hub-side, VOS-156 shipped) — dispatch+return provenance log on disk.

### Source A does NOT exist (CC harness hooks)

- No `.claude/hooks/` in the project; CC hooks are global at `~/.claude/hooks/` (if at all).
- This source would require new infra: `PreToolUse` / `PostToolUse` hook scripts that POST to the daemon's new ingestion endpoint, OR JSONL tail.
- Risk: subagents dispatched via Claude Code (CC) run under operator's CC instance, not under daemon — daemon has no direct visibility. Hooks are the only seam.

### Inspector surface (does NOT exist)

- Plugin today has only `ChatView` (single chat focus). Inspector wants multi-agent live overview.
- Options: new `InspectorView` (`ItemView` like ChatView), or daemon-served HTML page. Plugin view is more native (WS already wired).
- New plugin view: list pane + detail pane. Subscribes to bus via WS, requests `GET /agents/inflight` snapshot on mount, applies events incrementally.

### Verb backend (does NOT exist)

- `pause` requires run-driver cooperation: a checkpoint after each tool_result where the driver checks a "paused?" flag (per-chat) before continuing the conversation turn.
- `kill` ≈ existing abort: `dispatch-child` can be wired to SIGTERM the CC subprocess and emit `run_end{reason:"aborted"}`.
- `resume` flips paused flag → false, driver proceeds.
- For CC subagents not owned by daemon (Source A), pause/kill require harness cooperation — likely out of scope for v1 unless operator wants a hook-side stop file.

### Branch verb (mostly exists)

- `tools/worktree/wt up <NEW-ID>` already creates hub + workspace worktrees on `task/<NEW-ID>` branch from canonical HEAD.
- Need: glue that mints a new task ID (`tools/task-new`?), copies parent agent's bundle, dispatches new agent. Operator stashes parent WIP manually (frozen decision).

## Proposed phasing (NEEDS_DECISION)

This is too large for one session. Three plausible phasings:

### Option A — substrate-first (recommended)
1. **Phase 1 (this task / VOS-155):** Event substrate — add `agent.event` topic to event bus, emit from existing void-os runtime hooks (dispatch-child spawn, run_driver tool boundaries, run_end). Persist to JSONL via trace/writer extension. Add `GET /agents/inflight` API. **No UI, no verbs, no Source A, no branch.** Acceptance: dispatching a child writes events; curl shows live list.
2. **Phase 2 (new task VOS-15X):** Inspector view in plugin — `InspectorView` `ItemView` subscribing to agent.event topic. Render list + detail. Acceptance bullets 1, 2, 5, 6 of VOS-155 met.
3. **Phase 3 (new task VOS-15Y):** Verbs — pause/resume/kill on daemon side (run-driver checkpoint flag + abort). Acceptance bullet 3.
4. **Phase 4 (new task VOS-15Z):** Branch verb (worktree glue) + CC harness hook ingestion (Source A). Acceptance bullets 4 + full union view.

### Option B — vertical slice
1. Build minimal end-to-end pipe: 1 event kind (tool_use) → daemon → plugin view → 1 verb (kill). Then iterate.
2. Risk: vertical slice still touches all layers — same total LOC, no real session-size win.

### Option C — close VOS-155 with reduced scope
1. Operator descopes VOS-155 to substrate + read-only view only (no verbs, no branch, no Source A). File 3 follow-up tasks for the rest.
2. Honest acceptance match: 3 of 6 bullets fully, 3 deferred.

**Subagent recommends Option A** — Phase 1 is genuinely one session of work (event topic + emission points + API + JSONL trace), unblocks Phase 2 (UI) cleanly, and matches the operator's frozen "union source" decision because Source A and Source B don't have to land together.

## v1 event schema (proposed)

```ts
type AgentEvent = {
  ts: string;            // ISO8601 UTC
  agent_id: string;      // chatId for daemon-side; uuid for CC-hook-side
  parent_id: string | null;
  kind:
    | "spawn"            // child dispatched
    | "tool_use"         // tool call started
    | "tool_result"      // tool call returned
    | "text"             // assistant text chunk (summary, not raw)
    | "pause" | "resume" | "kill"
    | "end";             // run terminated
  summary: string;       // ≤200 char human-readable
  // Optional extensions (kept thin to stay cheap on the bus):
  tool?: string;         // for tool_use/tool_result
  parent_chat_id?: string;
  source?: "daemon" | "cc-hook";
};
```

Storage: JSONL at `vault/work/agents/events.jsonl` (rotated by day or size — TBD). In-memory snapshot keyed by `agent_id` for `GET /agents/inflight`.

## Open questions for operator

1. **Phasing pick** — A / B / C above.
2. **If A:** confirm Phase 1 acceptance = "substrate only, no UI" so the orchestrator can file VOS-15X / 15Y / 15Z follow-ups before this task closes.
3. **CC harness hooks (Source A) location** — global `~/.claude/hooks/` (affects all sessions) or project-scoped `hub/.claude/hooks/` (only when working in hub)?
4. **Pause checkpoint granularity** — between tool calls only, or also between text-only turns (longer wait but more responsive)?
