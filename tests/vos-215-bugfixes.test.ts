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
// The waitForPrompt timeout in spawnRun is hardcoded in spawn.ts.
// Opus 4.8 cold starts via void-relay regularly exceed 60s — the 60s cap
// causes waitForPrompt to return false BEFORE ❯ appears, leaving the REPL idle.
// Fix: increase to 180s (matches "still working" stage in placeholder body).

test("BUG A: spawn.ts kickoff waitForPrompt timeout is >= 180s (cold-start safe)", () => {
  const src = readFileSync(new URL("../src/spawn.ts", import.meta.url), "utf8");
  // Find the waitForPrompt call in the interactive kickoff block
  // Match numeric literals with optional underscores (e.g. 180_000 or 180000)
  const kickoffMatch = src.match(/waitForPrompt\(tmuxSession,\s*"[^"]*",\s*([\d_]+)/);
  expect(kickoffMatch).not.toBeNull();
  const timeoutMs = parseInt(kickoffMatch![1].replace(/_/g, ""), 10);
  // Must be >= 180_000 ms to survive Opus 4.8 cold starts through void-relay
  expect(timeoutMs).toBeGreaterThanOrEqual(180_000);
});

// ── BUG B ──────────────────────────────────────────────────────────────────
// dotClass returns "" for both "working" and "complete", making them visually
// identical (both render rgb(34,195,93) green). Fix: give "working" a distinct
// dot class (e.g. "working") and add corresponding CSS.

const sess = (o: Partial<SessionInfo> = {}): SessionInfo => ({
  uuid: "u1", title: "T1", mtimeMs: 1, lastActivityMs: 1, needsAttention: false,
  error: false, status: "complete", skill: "deep-research", ...o,
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
