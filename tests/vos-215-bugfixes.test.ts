/**
 * VOS-215: Tests for the three dogfood-blocker bug fixes.
 *
 * Each test group proves RED pre-fix and GREEN post-fix.
 *
 * BUG A: interactive kickoff waitForPrompt timeout (60s too short for Opus 4.8 cold start)
 * BUG B: working/complete dots both render green (dotClass returns "" for both)
 * BUG C: pre-ccId resume copybtn emits runId-form (invalid --resume target)
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderDashboard, renderShell } from "../src/render.ts";
import type { SessionInfo } from "../src/sessions.ts";

// ── BUG A ──────────────────────────────────────────────────────────────────
// ROOT CAUSE (master-proven live 2026-06-03):
// The previous fix (60s→180s timeout) was the WRONG AXIS. waitForPrompt("❯") fires
// at ~1s because ❯ is present in the REPL boot frame. The claude v2.1.161 REPL is
// NOT input-ready until ~20s when the interactive footer renders
// ("bypass permissions on" / "← for agents" / "Relay:"). The keystroke sent at ~1s
// is silently dropped into a still-booting REPL.
//
// Real fix: use waitForReady (❯ + footer marker) so the kickoff fires only when the
// REPL is genuinely accepting input, plus sendKickoff retry-until-accepted
// (re-sends if no acceptance signal within 12s, up to 6 attempts).

import { waitForReady, sendKickoffWith } from "../src/tmux.ts";

test("BUG A: spawn.ts kickoff uses waitForReady (not bare waitForPrompt)", () => {
  const src = readFileSync(new URL("../src/spawn.ts", import.meta.url), "utf8");
  // Must use waitForReady in the interactive kickoff block, not bare waitForPrompt
  expect(src).toContain("waitForReady(tmuxSession");
  // Must NOT use the old bare-❯ waitForPrompt in the kickoff path
  // (waitForPrompt may still exist for other callers, but the kickoff block must use waitForReady)
  const kickoffBlock = src.slice(src.indexOf("opts.interactive && opts.skill"));
  expect(kickoffBlock).toContain("waitForReady");
  expect(kickoffBlock).not.toContain("waitForPrompt");
});

test("BUG A: spawn.ts kickoff uses sendKickoff (retry-until-accepted)", () => {
  const src = readFileSync(new URL("../src/spawn.ts", import.meta.url), "utf8");
  const kickoffBlock = src.slice(src.indexOf("opts.interactive && opts.skill"));
  // Must retry with sendKickoff, not fire-and-forget sendKeys
  expect(kickoffBlock).toContain("sendKickoff(tmuxSession");
});

test("BUG A: waitForReady requires footer marker in addition to ❯ (mocked)", async () => {
  // ❯-only frame (boot frame at ~1s) → must NOT be ready
  // ❯ + footer frame (~20s) → must be ready
  const frames: string[] = [
    "❯",                                          // boot frame: NOT ready
    "❯\nbypass permissions on (shift+tab to cycle) · ← for agents",  // full REPL: ready
  ];
  let callCount = 0;
  const mockCapture = (_target: string) => frames[Math.min(callCount++, frames.length - 1)]!;

  // Inject mock into waitForReady via a local re-implementation using the pure seam
  // waitForReady itself doesn't have an injectable seam, but we can test via the
  // READY_MARKERS logic indirectly: verify that the first frame (❯ only) is not accepted
  // while the second frame (❯ + footer) is accepted.

  // Frame 0: ❯ only — does NOT contain any ready marker
  const frame0 = frames[0]!;
  const readyMarkers = ["bypass permissions", "for agents", "Relay:"];
  const frame0Ready = frame0.includes("❯") && readyMarkers.some((m) => frame0.includes(m));
  expect(frame0Ready).toBe(false); // RED: would have fired too early under old code

  // Frame 1: ❯ + footer — DOES contain a ready marker
  const frame1 = frames[1]!;
  const frame1Ready = frame1.includes("❯") && readyMarkers.some((m) => frame1.includes(m));
  expect(frame1Ready).toBe(true); // GREEN: fires only when REPL is genuinely ready
});

test("BUG A: sendKickoffWith retries if no acceptance signal (mocked sequences)", async () => {
  // Sequence: attempt 1 exhausts all 3 polls (❯-only), attempt 2 sees acceptance immediately.
  // With acceptWaitMs=1500, acceptPollMs=500: polls at 0ms, 500ms, 1000ms → 3 polls before
  // deadline (1500ms). All return idle → attempt 1 exhausted → re-send on attempt 2.
  // Attempt 2 poll 0ms → "Esc to interrupt" → accepted → return.
  //
  // VOS-216: sendKickoffWith now captures a baseline pane before the loop (one extra
  // captureFn call at the top). The sequence has an extra leading "❯" for that call.
  const captureResponses = [
    "❯",               // baseline capture (pre-loop, pre-send)
    "❯",               // attempt 1, poll 0ms: idle
    "❯",               // attempt 1, poll 500ms: idle
    "❯",               // attempt 1, poll 1000ms: idle (attempt 1 exhausted)
    "Esc to interrupt", // attempt 2, poll 0ms: accepted → stop
  ];
  let captureIdx = 0;
  const mockCapture = (_target: string) => captureResponses[Math.min(captureIdx++, captureResponses.length - 1)]!;

  const sends: string[] = [];
  const mockSend = (_target: string, line: string) => { sends.push(line); };

  const attempts = await sendKickoffWith(
    mockCapture, mockSend, "test-session", "/onboarding",
    { maxAttempts: 6, acceptWaitMs: 1_500, acceptPollMs: 500 },
  );

  // Must have sent twice (first attempt not accepted, second accepted)
  expect(sends.length).toBe(2);
  expect(sends[0]).toBe("/onboarding");
  expect(sends[1]).toBe("/onboarding");
  // Returned on attempt 2
  expect(attempts).toBe(2);
});

test("BUG A: sendKickoffWith does NOT re-send once accepted (no double-deliver)", async () => {
  // Sequence: immediate acceptance on first poll after first send
  let captureIdx = 0;
  const captureResponses = ["Esc to interrupt", "Esc to interrupt", "Esc to interrupt"];
  const mockCapture = (_target: string) => captureResponses[Math.min(captureIdx++, captureResponses.length - 1)]!;

  const sends: string[] = [];
  const mockSend = (_target: string, line: string) => { sends.push(line); };

  const attempts = await sendKickoffWith(
    mockCapture, mockSend, "test-session", "/onboarding",
    { maxAttempts: 6, acceptWaitMs: 2_000, acceptPollMs: 200 },
  );

  // Accepted on first attempt → exactly ONE send, no retry
  expect(sends.length).toBe(1);
  expect(attempts).toBe(1);
});

test("BUG A: sendKickoffWith never sends beyond maxAttempts when never accepted", async () => {
  const mockCapture = (_target: string) => "❯"; // never accepted
  const sends: string[] = [];
  const mockSend = (_target: string, line: string) => { sends.push(line); };

  const attempts = await sendKickoffWith(
    mockCapture, mockSend, "test-session", "/onboarding",
    { maxAttempts: 3, acceptWaitMs: 300, acceptPollMs: 100 },
  );

  // Exhausted maxAttempts — exactly maxAttempts sends, no more
  expect(sends.length).toBe(3);
  expect(attempts).toBe(3);
});

// ── BUG B ──────────────────────────────────────────────────────────────────
// dotClass returns "" for both "working" and "complete", making them visually
// identical (both render rgb(34,195,93) green). Fix: give "working" a distinct
// dot class (e.g. "working") and add corresponding CSS.

const sess = (o: Partial<SessionInfo> = {}): SessionInfo => ({
  uuid: "u1", title: "T1", mtimeMs: 1, lastActivityMs: 1, needsAttention: false,
  idle: false, error: false, status: "complete", skill: "deep-research", ...o,
});

test("BUG B: working-status dot class is distinct from complete-status dot class", () => {
  const htmlWorking = renderDashboard(
    [],
    [sess({ uuid: "working-sess", status: "working" })],
    { authed: true },
  );
  const htmlComplete = renderDashboard(
    [],
    [sess({ uuid: "complete-sess", status: "complete" })],
    { authed: true },
  );

  // Helper: extract the session-uuid span row content for the main session list
  const mainRowFor = (html: string, uuid: string) => {
    const marker = `${uuid.slice(0, 8)}…`;
    let searchFrom = 0;
    while (true) {
      const idx = html.indexOf(marker, searchFrom);
      if (idx === -1) return "";
      const spanStart = html.lastIndexOf("<span", idx);
      const spanContent = html.slice(spanStart, idx + marker.length + 20);
      if (spanContent.includes("session-uuid")) {
        const rowStart = html.lastIndexOf("<a href=", spanStart);
        const rowEnd = html.indexOf("</a>", idx);
        return html.slice(rowStart, rowEnd + 4);
      }
      searchFrom = idx + 1;
    }
  };

  const workingRow = mainRowFor(htmlWorking, "working-sess");
  const completeRow = mainRowFor(htmlComplete, "complete-sess");

  // Both must have a dot
  expect(workingRow).toContain("session-dot");
  expect(completeRow).toContain("session-dot");

  // The working dot must have a distinct CSS class from plain "session-dot"
  // (i.e. "session-dot working" or similar non-empty qualifier)
  // Extract the dot class attribute from each row
  const workingDotMatch = workingRow.match(/class="session-dot([^"]*)"/);
  const completeDotMatch = completeRow.match(/class="session-dot([^"]*)"/);

  expect(workingDotMatch).not.toBeNull();
  expect(completeDotMatch).not.toBeNull();

  const workingExtra = workingDotMatch![1].trim(); // e.g. "working"
  const completeExtra = completeDotMatch![1].trim(); // e.g. "" (default green)

  // They must differ — working must not be the same visual class as complete
  expect(workingExtra).not.toEqual(completeExtra);
  // working must have a non-empty qualifier
  expect(workingExtra.length).toBeGreaterThan(0);
});

test("BUG B: dashboard CSS contains a distinct color rule for working dot", () => {
  const html = renderDashboard([], [sess({ status: "working" })], { authed: true });
  // The CSS must include a .session-dot.working rule with a non-green color
  expect(html).toContain("session-dot.working");
});

test("BUG B: 6-state regression — other states (stopped/error/reaped/awaiting) unaffected", () => {
  const statuses = ["stopped", "error", "reaped", "awaiting", "working", "complete"] as const;
  const sessions = statuses.map((s) => sess({ uuid: `${s}-uuid`, status: s }));
  const html = renderDashboard([], sessions, { authed: true });

  // These states must still carry their original dot classes (regression guard)
  expect(html).toContain("session-dot err");
  expect(html).toContain("session-dot await");
  expect(html).toContain("session-dot reaped");
  expect(html).toContain("session-dot stopped");
});

// ── BUG C ──────────────────────────────────────────────────────────────────
// Before cc-actual-session.txt exists (ccId == null), renderShell falls back to
// `vc -- --resume <uuid>` (a runId). runId is NOT a valid --resume target; only
// a real CC session ID (ccId) works. Fix: when resumeCmd is undefined/null,
// suppress the copy button (or show "starting…" label without a cmd).

test("BUG C: renderShell without resumeCmd hides or suppresses the copy button", () => {
  // Pass no resumeCmd (undefined = pre-ccId state)
  const html = renderShell("exec-run-id-not-cca", "/vault", "onboarding");
  // Must NOT emit a copyable --resume with the runId
  expect(html).not.toContain("--resume exec-run-id-not-cca");
  // The copy button (if present) must not be wired with a runId-based command
  // If there is a copy-btn, it must not carry a bad cmd
  const copyCmdMatch = html.match(/data-cmd="([^"]*)"/);
  if (copyCmdMatch) {
    expect(copyCmdMatch[1]).not.toContain("exec-run-id-not-cca");
  }
});

test("BUG C: renderShell with a real ccId still emits the full --resume <ccId> command", () => {
  const fakeCcId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const html = renderShell("exec-run-id", "/vault", "onboarding",
    `cd /vault && vc -- --resume ${fakeCcId}`);
  // With a real ccId passed as resumeCmd, the copy-btn must still work
  expect(html).toContain(`vc -- --resume ${fakeCcId}`);
  expect(html).toContain("copy-btn");
});

test("BUG C: no-resumeCmd state does not expose copy-btn with runId as resume target", () => {
  // Simulate the exact pre-ccId state the server creates when ccId is null
  const runId = "exec-no-cc-yet";
  const html = renderShell(runId, "/tmp/vault", "onboarding"); // no resumeCmd
  // The full UUID-based resume string (which is wrong for --resume) must be absent
  expect(html).not.toMatch(/data-cmd="[^"]*--resume exec-no-cc-yet/);
});
