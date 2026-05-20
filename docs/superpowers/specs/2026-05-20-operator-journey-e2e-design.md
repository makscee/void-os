# VOS-163 — Operator-Journey E2E: install-to-debug walkthrough

Design spec. 2026-05-20.

## Why

The operator is about to start using void-os daily (milestone
`dogfood-void-os-workflow`). Before that, they want a single long-running
Playwright scenario that *imitates their real first-use path* —
fresh-install → connect Obsidian → open vault → chat with the tinker agent →
create agents → start a task → debug an agent trace in the InspectorView.

It is explicitly **one continuous journey**, not a pile of isolated specs.
At every stage it screenshots and asserts layout has not drifted. When the
journey surfaces a bug, that bug becomes a separate task; the journey then
*re-tests just the affected stage* once a fix lands — running in parallel
with the milestone burndown.

## Constraints discovered

- The void-os e2e harness lives in `plugin/e2e/` (Playwright). `globalSetup`
  spawns ONE daemon (fake provider) + ONE Obsidian (CDP) and persists a
  `state.json` sidecar. `connect.spec.ts` confirmed green on this worktree.
- Harness traps (workspace/void-os/CLAUDE.md): ribbon clicks must go through
  `page.evaluate(el => el.click())`; `VOS_FAKE_SCRIPT_maya` is hard-pinned —
  all top-level chats run the maya script regardless of agent name; child
  ask_agent dispatches use per-agent envs; ChatList `isEmpty` filter hides
  text-less rows.
- Inspector substrate (VOS-155/160/161) is on main `e031e10`: event
  substrate, `InspectorRoot.tsx`, VerbBar (`inspector-verb-bar`,
  `inspector-verb-kill`). VOS-162 (branch verb + Source-A) is in-flight on a
  separate branch — out of scope here.
- Plugin commands: `void-os:open-chat-view`, `void-os:new-chat-with-agent`,
  `void-os:open-inspector-view`. Ribbon icon `void-os chat`.
- Existing testids: `vos-status-bar`, `vos-chat-root`, `agent-list`,
  `agent-row`, `draft-label`, `draft-composer`, `draft-send`, `chat-active`,
  `chat-list`, `chat-row-*`, `vos-inspector-root`, `inspector-agent-row`,
  `inspector-trace`, `inspector-trace-event`, `inspector-empty`,
  `inspector-verb-bar`.

## Non-goals

- Fixing bugs the journey surfaces — each becomes a separate VOS-* task.
- A literal OS-level "fresh install" (downloading Obsidian, running the
  `void-os` CLI installer). The Playwright harness already *is* a clean
  install each run: fresh tmpdir, fresh user-data-dir, fresh DB, plugin
  freshly built into a throwaway vault. "Fresh install" stage = asserting
  that clean-boot state, not re-running the CLI installer.
- VOS-162 branch-verb / Source-A surfaces.

## Architecture

### One spec file, staged

A single new spec: `plugin/e2e/specs/operator-journey.spec.ts`, run as its
own Playwright project `journey` (its own daemon + Obsidian, like
`ask-user`). The journey is a `test.describe.serial(...)` block; each STAGE
is one `test(...)` inside it. `serial` mode guarantees in-order execution
and **skips later stages if an earlier one fails** — exactly the
checkpoint-on-failure behaviour the operator wants.

Because `globalSetup` spawns the daemon + Obsidian ONCE for the whole
project run, every stage observes the cumulative side-effects of earlier
stages within a single run. That gives natural state-persistence: stage 5
(debug trace) sees the chats stage 4 created without re-running stage 4.

### Stages

| # | Stage id | What it does | Resumable from cold? |
|---|----------|--------------|----------------------|
| 1 | `fresh-install` | Assert clean-boot: plugin loads, status pill reaches `connected`, daemon `/agents` reachable, no stray chats. Screenshot the empty workspace. | yes |
| 2 | `open-chat` | Open chat view via ribbon click; assert `vos-chat-root` mounts, agent rail (`agent-list`) renders the seeded agents. Screenshot. | yes |
| 3 | `chat-tinker` | Click an agent row → Draft pane; type a message in `draft-composer`; send; assert the chat goes Active and an assistant turn renders. Screenshot the live chat. | yes (cold-clean) |
| 4 | `create-agent` | Drive the agent-creation surface. **OPEN QUESTION below** — see Risks. Screenshot. | yes |
| 5 | `start-task` | Mint + send a second chat that produces a multi-event run, simulating "start working on a task". Screenshot. | yes |
| 6 | `debug-trace` | Open InspectorView via command; assert in-flight agent row appears; click → trace expands with ≥1 `inspector-trace-event`. Screenshot the inspector. | needs stages 3/5 OR a fresh run (inspector inflight registry has a 10s grace window — see Risks) |

Stage 6's inspector depends on a recent run still being in the inflight
registry. The registry lingers ~10s after a run ends. So stage 6 either runs
right after stage 5 (warm), OR dispatches its own fresh run at the start of
the stage (cold-clean). The spec does the latter — each stage that needs
daemon state mints its own — so any stage is independently runnable, with
stages 3/5/6 self-seeding.

### Single-stage / range running

Each `test(...)` title is prefixed with its stage id, e.g.
`"[S1 fresh-install] ..."`. Operator runs:

- Whole journey: `bun run e2e:journey`
- One stage: `bun run e2e:journey -- --grep "S4"`
- A range: `--grep "S3|S4|S5"`

`--grep` is Playwright-native; no custom runner needed. New package.json
script `e2e:journey` = `bunx playwright test --config e2e/playwright.config.ts --project=journey`.

A README (`plugin/e2e/JOURNEY.md`) documents stage ids, the grep recipes,
and which stages are cold-resumable vs. need a warm predecessor.

### Layout-drift check

Two complementary mechanisms, both cheap:

1. **`expect(locator).toHaveScreenshot()`** per stage on the primary
   surface container (workspace / chat-root / inspector-root). First run
   writes baselines under `operator-journey.spec.ts-snapshots/`; later runs
   pixel-diff. Tolerances: `maxDiffPixelRatio: 0.02` to absorb font/AA
   noise. Baselines are committed so drift is caught in CI / reruns.
2. **Bounding-box assertion** — a `assertLayout(page, testid)` helper grabs
   `boundingClientRect` of the stage's key container and asserts
   `width > 0 && height > 0` and that it sits within the viewport (no
   off-screen / collapsed surface). This catches gross layout breakage even
   on the very first run before a baseline exists.

`toHaveScreenshot` is the regression gate; the bbox check is the first-run /
no-baseline guard. Both screenshots (the explicit `page.screenshot(...)`
artifact + the snapshot) land in a per-stage path the report references.

### Per-stage report

A module-level `stageReport: StageResult[]` array, appended in each stage.
`StageResult = { stage, screenshotPath, layoutVerdict: "ok"|"drift"|"first-run", pass }`.
An `afterAll` hook writes `test-results/operator-journey-report.json` and
prints a table to stdout. On a first full run the report's failing /
drift rows ARE the surfaced-issues list the orchestrator turns into tasks.

### Surfaced-issues capture

The journey is expected to surface bugs on first run. Any stage that fails
is NOT a test-harness defect to fix here — it is a product issue. The spec
uses `test.fail()`-free design: a stage failing genuinely fails, but the
`afterAll` report still emits, so the operator gets the full list. The
subagent's Work Log documents every surfaced issue as a one-line entry the
orchestrator can mint a task from.

## Risks / open questions

- **R1 — agent-creation surface (stage 4).** Discovery found a chat-side
  agent *rail* and a *picker* (`new-chat-with-agent`), but no confirmed
  in-plugin "create a new agent" UI. Agents are seeded from vault
  frontmatter files. If no creation UI exists, stage 4 degrades to:
  "create an agent" = write an `agents/<name>/agent.md` into the vault and
  assert the daemon's scanner picks it up + the rail re-renders. This is
  still faithful to the operator's manual path (they author agent files).
  The plan's stage-4 task will confirm against the repo and pick the real
  surface; if a creation UI is found, it drives that instead.
- **R2 — inspector inflight grace window.** ~10s lingering registry. Stage
  6 mints its own run to stay deterministic rather than depending on stage
  5's timing.
- **R3 — screenshot baseline churn.** Obsidian theme / font AA differs
  across machines. Mitigated by `maxDiffPixelRatio` tolerance and by
  committing baselines generated on the operator's mac (the only machine
  that runs this). If CI ever runs it, baselines regenerate there once.
- **R4 — heavy run.** Six stages × (Obsidian boot shared once) ≈ one daemon
  boot + ~6 stage bodies. Project `globalTimeout` bumped; each stage
  `test.setTimeout(120_000)`.

## Acceptance

1. `plugin/e2e/specs/operator-journey.spec.ts` exists: a single
   `test.describe.serial` journey with 6 named stages (S1 fresh-install →
   S6 debug-trace), each a `test(...)` whose title is stage-id-prefixed.
2. New Playwright project `journey` + `globalSetup-journey.ts` /
   `globalTeardown-journey.ts` give the journey its own daemon + Obsidian.
3. `bun run e2e:journey` runs the whole journey; `--grep "S<N>"` runs a
   single stage or range. `serial` mode skips downstream stages on failure.
4. Every stage takes an explicit screenshot AND runs the layout-drift check
   (`toHaveScreenshot` regression + `boundingClientRect` first-run guard).
5. Stages that need daemon state self-seed (mint their own chat/run) so any
   stage is independently runnable from a cold harness; `JOURNEY.md`
   documents which stages are cold-resumable vs warm-only.
6. An `afterAll` hook writes `test-results/operator-journey-report.json` —
   per-stage screenshot path + layout verdict + pass/fail.
7. First full run executed; every surfaced issue documented as a one-line
   entry in the task Work Log for the orchestrator to file as a task.
8. The journey reuses the existing harness (`getVaultPage`, globalSetup
   parameterisation) and heeds all documented harness traps.
