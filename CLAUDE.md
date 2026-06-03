# void-os — agent instructions

void-os = stateless-agent OS (ADR-0003). Bun + TypeScript. Default branch `main`; per-task worktrees at `~/void-os-wt/<ID>/` (NOT `~/hub-wt/`). Design canon lives in `hub/vault/projects/void-os/` (glossary + ADRs), NOT in this repo — read it before any design/planning.

## Proof-script rules (load-bearing)

Proofs for void-os features run against a live daemon + real `claude`/`vc`/`tmux` processes. Two rules, both learned the hard way in VOS-206 (a feature that needed 4 master-run proof passes instead of 1 because the proof itself was unreliable):

1. **`exit 1` on every load-bearing assertion — never WARN-and-continue.** A proof that `echo "WARNING: ..."` on a missing core precondition then keeps going **exits 0 with hollow downstream PASSes** — a false-green. The reader cannot tell "feature works" from "precondition silently failed and the rest ran on garbage". WARN is permitted ONLY for genuinely informational/optional checks (e.g. an LLM-output-speed note). Every check the verdict depends on must hard-fail.

2. **Assert deterministic wiring, not LLM-output timing.** Do NOT gate a PASS on model output appearing within N seconds — Opus timing variance is large (VOS-206: same codebase rendered a form in 90s one run, >180s the next), so a fixed-wait assertion is inherently flaky and silently false-greens when the model is slow. Assert the mechanism the task actually changed:
   - exec-row count in `.void-os/registry.db`
   - tmux session live on the `-L vos` socket
   - correct argv flags in `cc-command.txt` (e.g. `vc --raw --` for interactive launch)
   - pane identity unchanged after a send (same `pane_pid` → send-keys hit the existing session, not a respawn)
   - the sent text / kickoff line appearing in `tmux capture-pane` (poll, bounded, hard-fail if absent)

   Operator-facing "the real LLM output looked right" evidence (a rendered form, a real reply) belongs in a separate `MASTER-PROOF.md` evidence doc captured by master — NOT as an automated assertion in the gating script.

**Baseline hygiene for "pre-existing failures" claims:** `git stash` leaves untracked/new test files in place, so a stashed baseline still carries new-file pollution and a real regression reads as "pre-existing". Verify a "these failures predate me" claim against a CLEAN checkout of origin/main, not a stash. (VOS-206 fix1 misdiagnosed 11 real regressions this way.)

**Reaper constraint:** the subagent sandbox SIGKILLs long-lived process trees at ~2–4 min. Any proof that spawns a live `claude`/`vc`/`tmux` session must be **master-run**, never run inside a dispatched subagent. Subagents do source + fast unit tests only.

## Core-flow regression guard (MANDATORY on every close-out)

`bun run e2e:core` (`scripts/e2e-core.ts` → `.e2e/core-flows.spec.ts`) is the standing regression gate for the
3 core void-os flows ANY change can silently break: (A) body.html write → SSE hot-reload re-renders the iframe
with no manual refresh; (B) onboarding form submit → POST `/s/:uuid/send` 302 + body advances; (C) kanban
`page.register` → server-side card render. It boots ONE real daemon on a fresh tmpdir vault + free port, drives
real Chromium, and asserts WIRING (no LLM dependence on the deterministic legs). The finalizer runs it on EVERY
void-os close-out — not just feature-touching tasks — because VOS-225/228 regressed A+B while their per-feature
proofs only checked the new surface (the gap VOS-231 closed). If you change render.ts, server.ts, the body/SSE
pipeline, or the `/p/:slug` path, run `bun run e2e:core` before claiming done.

## E2E gotchas (plugin/e2e harness)

Source: VOS-104 T8 (recorded 2026-05-20). **Verify against the current harness before relying on these — the plugin layout may have shifted.** Before writing a new spec in `plugin/e2e/`:

1. No reusable helpers (`createChatThatAsks` etc.) — copy the lower-level pattern from a working sibling spec, NOT from `ask-user.spec.ts` (was broken on master).
2. `VOS_FAKE_SCRIPT_maya` is hard-pinned globally; the agent picker doesn't route per-agent scripts at top level. Swap `plugin/e2e/fixtures/ask-agent/maya.jsonl` in `beforeEach` to drive a `vos_ask_user`.
3. ChatList `isEmpty` filter hides ask-only fixtures — emit a "thinking…" text turn first.
4. `Bun.serve` `idleTimeout` default 10s drops `/events` mid-`ask_user`; daemon sets 255.

Plans that touch `plugin/e2e/` must budget for these or sidestep by REST-driving the daemon directly. Do NOT assume placeholder helpers exist — inline the fixture-swap pattern or break out a real helper module in a dedicated task first.

## Skill conventions

### Input delivery

- **Print-mode skills** (no `interactive: true`): input arrives as `-p "<skill-cmd>\n\n<input>"` in the user prompt. There are no trailing arguments.
- **Interactive skills** (`interactive: true`): input arrives via the `$VOID_OS_INPUT_REF` environment variable. Read `process.env.VOID_OS_INPUT_REF` (in JS/TS) or `$VOID_OS_INPUT_REF` (in shell) to get the input file path. Do NOT rely on CLI trailing arguments — there are none in interactive mode.

### Output target: Edit, not Write

When `output_target: <path>` is declared in a skill's frontmatter, the Stop hook checks whether the target file's mtime advanced since session start (`wasMutatedSince`). If not:

1. First clean Stop → hook blocks and emits a nudge message.
2. Second Stop → hook gives up; session ends with `produced_change=false`.

Rule: **use Edit (not Write) on existing output-target files.** Write creates/overwrites a file — it can clobber content and does not reliably advance mtime on the existing file path. Edit is an in-place mutation that always advances mtime.

### Communication channel: transcript is primary, body.html is optional

The CC transcript (the `.jsonl` session file) is the **primary communication channel** between a skill and the operator. Every assistant turn in the REPL session is visible there.

`body.html` is **optional** and should only be written for content that genuinely requires a rendered surface: forms the operator must fill in, structured reports to act on, or rich decisions. Do NOT write `body.html` for conversational replies — the transcript is enough.
