// resume.test.ts — unit tests for resume-on-demand (buildResumeArgv + respawnSession).
// VOS-205 T4: pure-function tests only; respawnSession integration uses mocked tmux.
import { test, expect } from "bun:test";
import { buildResumeArgv } from "../src/resume.ts";

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
