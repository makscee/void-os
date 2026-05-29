# Configurable Claude Code runner + `smoke-test` skill — design

Date: 2026-05-29
Status: approved (brainstorming) — pending spec review → writing-plans

## Problem

void-os hardcodes `vc` as the Claude Code runner (`Bun.spawn(["vc", ...argv])` in
`src/spawn.ts`). The operator wants to run sessions under different local identities
(e.g. a wrapper that inlines a different OAuth token), settable as a **default** and
**overridable per session** at launch time.

Separately, the only way to test the flow cheaply today is a `TEST:` short-circuit
hack baked into `deep-research/SKILL.md` (commit d4b401b). That couples test logic to
one skill. Replace it with a dedicated cheap skill.

## Constraints discovered

- `Bun.spawn` does **not** go through a shell, so shell aliases in `~/.zshrc` do not
  resolve. The runner must be an executable/script on `PATH`. The operator will turn
  their alias into a script (e.g. `~/bin/claude_artem` that exports a token and
  `exec claude "$@"`).
- `vc` and plain `claude` have **different argv prefixes**: `vc` forwards everything
  after `--` to claude (`vc -- --session-id …`), whereas plain `claude` takes the args
  directly (`claude --session-id …`) and would mis-parse a leading `--`. The design
  must absorb this difference without special-casing per binary.
- A session's runner must persist across turns: a session launched under one runner
  must **resume** under the same one, or `--resume` could switch identity/token and
  fail.

## Design

### 1. Config — extend `void-os.json` (no new file)

`VoidOsConfig` (in `src/paths.ts`) gains two fields:

```jsonc
{
  // …existing: vault, onboarded, skills, answers, port
  "runners": [
    { "label": "vc (relay)", "command": "vc --" },
    { "label": "artem",       "command": "claude_artem" }
  ],
  "defaultRunner": "vc (relay)"
}
```

- `command` is the **argv prefix**, tokenized on whitespace and prepended to the
  claude-side args. `vc --` → `["vc", "--"]`; `claude_artem` → `["claude_artem"]`.
  One model covers both binary conventions; the `--` (or its absence) lives in the
  command string, not in code.
- `label` is the unique display name and the value posted by the launch form.
- **Back-compat:** when `runners`/`defaultRunner` are absent, `readConfig` returns an
  in-memory default of `[{ label: "vc (relay)", command: "vc --" }]` with
  `defaultRunner: "vc (relay)"`. Every existing vault keeps working unchanged.
- `init` seeds these two fields into new vaults' `void-os.json`.

A helper `resolveRunner(config, label?)` returns the matching runner's `command`,
falling back to `defaultRunner`'s command when `label` is missing/unknown.

### 2. argv refactor — `src/spawn.ts`

Move the `--` separator **out** of the argv builders and into the runner command.

- `buildLaunchArgv(uuid, skill, text)` → emits only the claude-side suffix:
  `["--session-id", uuid, "-p", prompt, "--permission-mode", "bypassPermissions"]`
  (no leading `--`).
- `buildAnswerArgv(uuid, text)` → `["--resume", uuid, "-p", prompt, ...PERM]`.
- `spawnTurn(vault, uuid, argv, command)` gains a `command: string` param. It
  tokenizes `command` on whitespace and spawns `[...cmdTokens, ...argv]`.
  - vc: `["vc","--", "--session-id", …]`
  - claude_artem: `["claude_artem", "--session-id", …]`

All existing watchdog / mtime / error-surfacing logic is unchanged.

### 3. Per-session persistence — `session-meta.json`

`session-meta.json` already stores `{ skill, launchedAt, text }`. Add `runner` (the
resolved **command** string, not the label, so a later config edit can't break an
in-flight session).

- `POST /launch` resolves the posted runner label → command, writes it into
  `session-meta.json`, and passes it to `spawnTurn`.
- `POST /s/:uuid/send` reads `session-meta.json`, recovers the stored `runner`
  command, and passes the same one to `spawnTurn` on resume. Missing/legacy meta →
  fall back to the config default (preserves old sessions).

### 4. UI — `src/render.ts` dashboard

Each skill chip is its own `<form action="/launch">`. Add:

- A single **"Run as" `<select id="runner-select">`** in the dashboard top bar,
  populated from `config.runners`, with `defaultRunner` pre-selected. Hidden when only
  one runner exists (no clutter for the common case).
- Each chip form gets a hidden `<input name="runner">`. A small `onchange` handler on
  the select writes its value into every chip form's hidden `runner` input (and it is
  initialised to the default on load).
- `renderDashboard` signature gains the runner list + default. `/launch` reads
  `body.runner` and calls `resolveRunner`.

### 5. `smoke-test` catalog skill — `catalog/skills/smoke-test/SKILL.md`

A real but minimal session (no WebSearch, no WebFetch, no sub-agents) that exercises
the full render loop at cold-start cost only:

- **Turn 1 (launch):** write `body.html` — heading "smoke-test ✓ session live", echo
  any launch input text, and a one-field answer-back form: a text input named `echo`
  and a submit button posting to the session's send endpoint (same render contract the
  other skills follow).
- **Turn 2 (resume, prompt contains `echo: <value>`):** rewrite `body.html` —
  "round-trip ✓ you sent: \<value\>".

This proves launch → render → SSE reload → form → `/send` → resume → render
end-to-end, cheaply, and is the canonical primitive for verifying the runner feature
(launch under a non-default runner, confirm spawn argv via the run log).

### 6. Remove old test hacks

- Delete the `### Test mode — short-circuit (TEST:)` section from
  `catalog/skills/deep-research/SKILL.md` (commit d4b401b).
- Rewrite memory `feedback_cheap_test_mode_for_expensive_skills.md` to describe the
  `smoke-test` skill instead of the `TEST:` prefix; update its `MEMORY.md` line.

## Scope guard (YAGNI)

Out of scope: per-runner env editor, add-runner-from-UI, token storage/management,
runner health/preflight checks. The operator edits `void-os.json` by hand. The feature
is: label + command + default + per-session dropdown, plus the `smoke-test` skill.

## Testing

Unit (bun test):
- `readConfig` back-compat: missing `runners` → vc default; present → parsed.
- `resolveRunner`: known label → its command; unknown/missing label → default command.
- argv builders no longer contain `--`.
- `spawnTurn` command tokenization: `"vc --"` and `"claude_artem"` produce the correct
  argv head (inject a spawn spy).
- session-meta round-trip: `/launch` writes `runner`; `/send` reads it back.

E2E (Playwright, run by the master personally — per VOS-181 standard):
- Seed a config with two runners. Load dashboard, confirm the "Run as" select renders
  with the default selected.
- Pick the non-default runner, launch `smoke-test`, confirm the run log's spawned argv
  leads with the chosen command, and the round-trip body renders after a form submit.

## Sequencing

This stacks on `task/VOS-181` (tip 933d2a6): it edits the same files (`spawn.ts`,
`server.ts`, `render.ts`) and removes the `TEST:` hack that exists only on that branch.
The implementation branch forks from VOS-181's tip; the whole lane
(176/177/178/180/181 + this) merges to `main` together.
