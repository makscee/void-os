// resume.test.ts — unit tests for resume-on-demand (buildResumeArgv + respawnSession).
// VOS-205 T4: pure-function tests only; respawnSession integration uses mocked tmux.
import { test, expect } from "bun:test";
import { buildResumeArgv, ensureRawRunner } from "../src/resume.ts";

test("buildResumeArgv: --resume ccId, vault add-dir, bypass perms, NO -p (interactive)", () => {
  const argv = buildResumeArgv("cc-real-id", "/vault", { addDirs: [] });
  expect(argv).toEqual([
    "--resume", "cc-real-id",
    "--add-dir", "/vault",
    "--permission-mode", "bypassPermissions",
  ]);
  expect(argv).not.toContain("-p");
});

test("buildResumeArgv: extra addDirs are appended", () => {
  const argv = buildResumeArgv("cc-id-x", "/vault", { addDirs: ["/extra"] });
  expect(argv).toContain("--add-dir");
  expect(argv).toContain("/extra");
  expect(argv).not.toContain("-p");
});

test("buildResumeArgv: --resume is always the first arg (before --add-dir)", () => {
  const argv = buildResumeArgv("cc-id-y", "/vault", {});
  expect(argv[0]).toBe("--resume");
  expect(argv[1]).toBe("cc-id-y");
});

test("buildResumeArgv: empty addDirs yields minimal argv", () => {
  const argv = buildResumeArgv("cc-z", "/vault", {});
  expect(argv).toHaveLength(6); // --resume ccId --add-dir vault --permission-mode bypassPermissions
  expect(argv).toEqual(["--resume", "cc-z", "--add-dir", "/vault", "--permission-mode", "bypassPermissions"]);
});

// VOS-205 bugfix: ensureRawRunner injects --raw before -- so resume uses the REPL, not vc TUI menu.

test("ensureRawRunner: injects --raw before -- in plain runner (vc --)", () => {
  const toks = ensureRawRunner("vc --");
  expect(toks).toEqual(["vc", "--raw", "--"]);
  // --raw must appear before --
  const rawIdx = toks.indexOf("--raw");
  const sepIdx = toks.indexOf("--");
  expect(rawIdx).toBeLessThan(sepIdx);
});

test("ensureRawRunner: idempotent when --raw already present (vc --raw --)", () => {
  const toks = ensureRawRunner("vc --raw --");
  expect(toks).toEqual(["vc", "--raw", "--"]);
  expect(toks.filter((t) => t === "--raw")).toHaveLength(1); // not doubled
});

test("ensureRawRunner: no separator → tokens unchanged (pass-through)", () => {
  const toks = ensureRawRunner("vc");
  expect(toks).toEqual(["vc"]);
  expect(toks).not.toContain("--raw");
});

test("resume full argv assembly: --raw before --, --resume ccId after --", () => {
  // Simulate the token assembly in respawnSession to prove the full argv shape.
  const runnerToks = ensureRawRunner("vc --");
  const resumeArgv = buildResumeArgv("cc-abc", "/vault", {});
  const fullToks = [...runnerToks, ...resumeArgv];
  // vc --raw -- --resume cc-abc --add-dir /vault --permission-mode bypassPermissions
  expect(fullToks).toEqual([
    "vc", "--raw", "--",
    "--resume", "cc-abc",
    "--add-dir", "/vault",
    "--permission-mode", "bypassPermissions",
  ]);
  const rawIdx = fullToks.indexOf("--raw");
  const sepIdx = fullToks.indexOf("--");
  const resumeIdx = fullToks.indexOf("--resume");
  expect(rawIdx).toBeLessThan(sepIdx);    // --raw before --
  expect(resumeIdx).toBeGreaterThan(sepIdx); // --resume after --
});
