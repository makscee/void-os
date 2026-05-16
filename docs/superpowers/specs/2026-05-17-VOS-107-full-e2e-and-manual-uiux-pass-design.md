# VOS-107 — Full e2e Playwright + manual UI/UX feedback pass

Date: 2026-05-17
Task: [VOS-107](../../../../../vault/work/tasks/active/VOS-107-full-e2e-and-manual-uiux-pass.md)
Milestone: `vos-v1-router`

## Purpose

Final closer for `vos-v1-router`. Two artifacts:

1. **Automated e2e:** full Playwright Electron suite (audit existing + fill gaps + fix broken) covering every PoC surface listed in VOS-107 acceptance.
2. **Manual UI/UX pass:** operator drives each surface by hand, captures friction inline, files follow-up tasks for blocker-grade issues.

## Surfaces in scope

| # | Surface | Tickets |
|---|---|---|
| S1 | Agent picker modal on new chat | VOS-92 |
| S2 | `ask_user` inline rendering + option buttons | VOS-90 |
| S3 | `ask_agent` child-Task collapsible sub-thread | VOS-89, VOS-91 |
| S4 | Chat list `INPUT_REQUIRED` indicator + cost column | VOS-104 |
| S5 | Cost meter (per-Task + per-day) | VOS-87 |
| S6 | Starter agents — scoped read/write + MCP allowlist | VOS-103, VOS-106 |
| S7 | Permission engine — cross-scope write deny | VOS-85 |
| S0 | Daemon round-trip (`TASK_STATE_INPUT_REQUIRED`) | VOS-88 |

## Approach — phase-gated

### Phase 1 — Baseline smoke

One subagent runs the 7 existing specs as-is:
- `connect.spec.ts`
- `chat-roundtrip.spec.ts`
- `chat-list-polish.spec.ts`
- `ask-agent.spec.ts`
- `ask-agent-subthread.spec.ts`
- `ask-agent-nested.spec.ts`
- `ask-agent-reload.spec.ts`

`ask-user.spec.ts` is **excluded** from baseline (known broken on master per void-os CLAUDE.md).

Gate: baseline must report all-green, or list flake/red with reproduction notes. Phase 2 does not dispatch on red baseline; instead a stabilisation pass runs first.

### Phase 2 — Build (parallel subagents)

Independent streams, dispatched in one parallel batch:

| Stream | Owner | Scope |
|---|---|---|
| AUDIT | 1 agent | Re-read 7 baseline specs; expand thin assertions; commit per-spec |
| FIX | 1 agent | Fix `ask-user.spec.ts` — overwrite `plugin/e2e/fixtures/ask-agent/maya.jsonl` in `beforeEach`, restore in `afterEach`; emit ≥1 assistant text turn before `vos_ask_user` so chat row renders |
| NEW-picker | 1 agent | `agent-picker.spec.ts` |
| NEW-cost | 1 agent | `cost-meter.spec.ts` |
| NEW-starter | 1 agent | `starter-agents.spec.ts` |
| NEW-permission-api | 1 agent | `permission-deny.spec.ts` (daemon HTTP) |
| NEW-permission-ui | 1 agent | `permission-deny-ui.spec.ts` (UI surface) |

Conventions every subagent follows:
- `workers: 1` (already enforced by `playwright.config.ts`)
- REST drive via `request.post(/chats)` + `request.post(/chat/:id/message)` when picker not under test
- Fixture mutation only in `beforeEach`/`afterEach` — restore from git pristine copy in teardown
- Daemon `idleTimeout: 255` preserved
- Emit ≥1 assistant text turn before any `vos_ask_user` to defeat ChatList `isEmpty` filter
- Commit on `task/VOS-107` inside worktree, never push

### Phase 3 — Full green run

Orchestrator subagent runs the full plugin/e2e suite (existing + audited + new + fixed). Output:
- summary table of pass/fail per spec
- on red: stop phase 4; loop back to phase 2 with surgical fix
- on green: record commit SHA of the green run for `## Acceptance` evidence

### Phase 4 — Manual UI/UX pass

Generated checklist file: `vault/work/tasks/active/VOS-107-manual-uiux-notes.md` (state-plane, committed via `sw`).

Per surface section:
```
## Surface: <name> (VOS-XX)
### Must-touch checklist
- [ ] action 1
- [ ] action 2
...

### Friction notes
- (free-form)

### Blocker-grade items (file follow-up)
- [ ] short title → <task ID after `/task-new VOS …`>
```

Closing block:
```
## Summary
- specs added/fixed: <SHAs>
- friction items filed: <task IDs>
- regressions detected: yes/no + detail
```

Operator drives. Subagents do not stub manual notes.

## Spec-by-spec assertion outlines

### `agent-picker.spec.ts` (NEW, surface S1)

- click "new chat" → picker modal visible
- list contains ≥2 starter agents from manifest
- select agent → modal closes, chat created with `agent_name` field set
- assert chat row records selected agent name (picker does not actually re-route top-level script per void-os CLAUDE.md gotcha — assert intent storage, not routing)

### `cost-meter.spec.ts` (NEW, surface S5)

- create chat, send 1 message, wait assistant turn → chat row cost > 0
- send second message → chat row cost monotonically increases
- header per-day total = sum across visible chats stamped today
- inject second chat with yesterday stamp → not included in today total

### `starter-agents.spec.ts` (NEW, surface S6)

- boot daemon with starter manifest path
- `GET /agents` returns expected starter set
- each agent: `read_scopes`, `write_scopes`, `mcp_allowlist` non-empty matching manifest
- invariant: `write_scopes ⊆ read_scopes`

### `permission-deny.spec.ts` (NEW, daemon HTTP, surface S7)

- start daemon with agent scoped to `vault/journal/`
- POST tool-call writing `vault/secrets/foo.md` → denied response (`403` or `{denied:true,reason}`)
- POST tool-call writing `vault/journal/foo.md` → allowed
- matrix: read-only path attempted write → denied

### `permission-deny-ui.spec.ts` (NEW, UI, surface S7)

- chat with scoped agent, fake-cc script attempts forbidden write
- assert turn renders denial pill / error text
- chat remains responsive (no crash)

### `ask-user.spec.ts` (FIX, surface S2)

Root cause: top-level script hard-pinned via `VOS_FAKE_SCRIPT_maya`; picker doesn't re-route. Fix:
- in `beforeEach`, overwrite `plugin/e2e/fixtures/ask-agent/maya.jsonl` with the ask-user variant
- emit ≥1 assistant text turn ("thinking…") before `vos_ask_user` so chat row passes `isEmpty` filter
- in `afterEach`, restore `maya.jsonl` from `git show :plugin/e2e/fixtures/ask-agent/maya.jsonl` or a stashed copy
- assert option buttons render; click one → daemon receives answer → `TASK_STATE_INPUT_REQUIRED` clears

### Audit pass for 7 existing specs

For each spec, AUDIT agent checks:
- all surface bullets from VOS-107 acceptance row covered by ≥1 assertion
- assertions go beyond "modal visible" — assert content, side-effects, state transitions
- no skipped/xfail without comment + follow-up task

If a spec is thin, agent expands assertions in a single commit per spec.

## Acceptance mapping

| VOS-107 bullet | Evidence |
|---|---|
| Playwright suite covers all surfaces; green run committed | Phase 3 green-run SHA in Work Log |
| Manual UI/UX walkthrough notes appended to Work Log | `VOS-107-manual-uiux-notes.md` finalised + summary appended to task `## Work Log` |
| Blocker-grade friction filed as separate backlog tasks | Follow-up IDs listed in summary block |
| No regression in `vos-v1-router` "Done when" criteria | Baseline + final green runs match; manual pass yields no "regression" entries |

## Constraints / non-goals

- Do NOT rewrite or restructure existing specs beyond expanding assertions.
- Do NOT add reusable helpers — sibling specs build inline per void-os CLAUDE.md.
- Do NOT introduce new test framework / runner.
- Do NOT push from subagents. Orchestrator handles `/done` push via task/<ID> merge.

## Risks

- Permission-deny UI surface may not yet render denial visibly — fallback: spec asserts daemon error reaches plugin via `/events`, even if visual treatment is plain text.
- `cost-meter` per-day reset behaviour may depend on local clock — use injected fixture timestamps, not wallclock.
- Parallel subagents on same branch: each must scope `git add` to spec it owns (per hub feedback `parallel_agents_git_add_hygiene`).
