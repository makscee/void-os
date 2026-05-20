# Operator-journey E2E (VOS-163)

`operator-journey.spec.ts` is ONE long-running staged Playwright
walkthrough that imitates the operator installing and using void-os
end-to-end. It is deliberately NOT a pile of small isolated specs — it is
a single continuous journey, decomposed into named, individually-runnable
stages.

## Running

```bash
cd plugin

# whole journey (all 6 stages)
bun run e2e:journey

# one stage
bun run e2e:journey -- --grep "S4"

# a range of stages
bun run e2e:journey -- --grep "S3|S4|S5"

# regenerate screenshot baselines (after an INTENTIONAL UI change)
bun run e2e:journey -- --update-snapshots
```

The journey runs as its own Playwright project `journey` with its own
daemon + Obsidian (`globalSetup-journey.ts`), so it never contends with
the baseline `main` specs.

## Stages

| # | Stage id | What it does |
|---|----------|--------------|
| S1 | `fresh-install` | Asserts clean-boot: plugin loads, status pill reaches `connected`, daemon `/agents` + `/chats` reachable. |
| S2 | `open-chat` | Opens the chat view via the ribbon icon; asserts `vos-chat-root` mounts and the agent rail renders. |
| S3 | `chat-tinker` | Clicks an agent row → Draft pane, types a message, sends; asserts the chat goes Active. |
| S4 | `create-agent` | Authors an `agents/<name>/agent.md` file; asserts the daemon scanner + chat rail pick it up. |
| S5 | `start-task` | Dispatches a run over REST (a multi-event "task"); asserts the chat list shows the conversation. |
| S6 | `debug-trace` | Opens the InspectorView; asserts an in-flight agent row appears and clicking it expands the step-by-step trace. |

"tinker" — the operator's dogfood vault has a default `tinker` agent. The
e2e fixture seeds `maya` / `journaler` / `deep`, and the fake provider is
hard-pinned to the `maya` script. So **`maya` is the in-harness stand-in
for `tinker`**; S3 chats with `maya`.

## Resumability

Every stage **self-seeds** its own daemon state — it mints its own chat,
dispatches its own run, or authors its own files. Consequently:

- **Every stage is cold-resumable.** `--grep "S<N>"` runs that stage alone
  against a fresh harness; no warm predecessor is required.
- The journey is **NOT `test.describe.serial`** — a failing stage does
  **not** skip the stages after it. When a stage surfaces a bug, the
  journey keeps testing further (the operator wants the journey to run in
  parallel with the milestone burndown, not block on each fix).
- When a fix for a surfaced bug lands, re-test just the affected stage:
  `bun run e2e:journey -- --grep "S4"`.

## Layout-drift check

Each stage runs two complementary guards:

1. **`assertBox`** (structural) — the surface is visible, has a non-zero
   box, and sits inside the viewport. Runs for every stage; this is the
   first-run / no-baseline guard and catches gross breakage (collapsed or
   off-screen panes).
2. **`toHaveScreenshot`** (pixel) — a committed baseline under
   `specs/operator-journey.spec.ts-snapshots/` is pixel-diffed with a
   tolerance (`maxDiffPixelRatio` 0.02) that absorbs font / AA noise.

S6 (the inspector) uses `shotMode: "structural-only"` — its panel
auto-sizes to variable-length agent / task ids, so a pixel diff would be
run-to-run noise rather than layout drift. The structural guard alone is
the layout check there.

After an INTENTIONAL UI change, regenerate baselines with
`--update-snapshots` and commit the updated PNGs.

## Per-stage report

After every run an `afterAll` hook writes
`test-results/operator-journey-report.json` and prints a table:

```
── operator-journey report ──
  PASS  S1-fresh-install   layout=ok        .../journey-shots/S1-fresh-install.png
  ...
```

Each row = stage id + screenshot path + layout verdict (`ok` /
`first-run` / `drift`) + pass/fail. Per-stage screenshots land in
`test-results/journey-shots/`.

## Surfaced issues

A stage **FAIL is a product issue**, not a test-harness defect — file a
separate `VOS-*` task for it, ship the fix on that task, then re-run just
the affected stage. The journey itself is the regression check for the
fix.

Known surfaced issue (first run, 2026-05-20):

- **S4** fails — the daemon runs `scanVaultAgents` once at boot
  (`daemon/src/index.ts`) with no vault watcher / runtime rescan, so an
  agent file authored after the daemon started is invisible to
  `GET /agents` until a daemon restart. S4 stays in the journey as the
  regression check for a future "rescan agents on vault change" task.
