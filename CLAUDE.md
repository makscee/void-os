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

## E2E gotchas (plugin/e2e harness)

Source: VOS-104 T8 (recorded 2026-05-20). **Verify against the current harness before relying on these — the plugin layout may have shifted.** Before writing a new spec in `plugin/e2e/`:

1. No reusable helpers (`createChatThatAsks` etc.) — copy the lower-level pattern from a working sibling spec, NOT from `ask-user.spec.ts` (was broken on master).
2. `VOS_FAKE_SCRIPT_maya` is hard-pinned globally; the agent picker doesn't route per-agent scripts at top level. Swap `plugin/e2e/fixtures/ask-agent/maya.jsonl` in `beforeEach` to drive a `vos_ask_user`.
3. ChatList `isEmpty` filter hides ask-only fixtures — emit a "thinking…" text turn first.
4. `Bun.serve` `idleTimeout` default 10s drops `/events` mid-`ask_user`; daemon sets 255.

Plans that touch `plugin/e2e/` must budget for these or sidestep by REST-driving the daemon directly. Do NOT assume placeholder helpers exist — inline the fixture-swap pattern or break out a real helper module in a dedicated task first.
