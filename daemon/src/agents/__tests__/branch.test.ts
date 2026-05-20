// VOS-162: tests for branchAgent — the git-worktree fork primitive.
//
// Covers:
//   - branch forks from the resolved HEAD sha (rev-parse, not the dirty tree)
//   - the branch name + worktree path are unique per nonce
//   - a rev-parse failure (non-git cwd) throws
//   - a worktree-add failure throws with the git stderr

import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { branchAgent, pruneBranchWorktrees } from "../branch.ts";

// branchAgent mkdir-s the worktree parent before driving git. Tests point
// it at a real, writable tmpdir so that step succeeds and the (faked) git
// calls are what the assertions actually exercise.
const TMP_WT = path.join(os.tmpdir(), "vos162-branch-test-wt");

/** Records git invocations; canned responses keyed by the first arg. */
function fakeGit(opts: { headSha?: string; failOn?: string } = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  return {
    calls,
    run: async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      if (opts.failOn && args[0] === opts.failOn) {
        return { stdout: "", stderr: "fatal: simulated failure", exitCode: 1 };
      }
      if (args[0] === "rev-parse") {
        return { stdout: (opts.headSha ?? "c".repeat(40)) + "\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

describe("VOS-162: branchAgent", () => {
  test("forks from the resolved HEAD sha", async () => {
    const git = fakeGit({ headSha: "d".repeat(40) });
    const result = await branchAgent("agent-xyz", {
      repoRoot: "/repo",
      runGit: git.run,
      worktreeParent: TMP_WT,
      nonce: () => "42",
    });
    expect(result.base_sha).toBe("d".repeat(40));
    expect(result.branch).toBe("branch/agentxyz-42");
    expect(result.worktree_path).toBe(path.join(TMP_WT, "agentxyz-42"));
    // worktree add must reference the resolved HEAD sha, not "HEAD".
    const addCall = git.calls.find((c) => c.args[0] === "worktree");
    expect(addCall?.args).toContain("d".repeat(40));
    expect(addCall?.args).toContain("-b");
    expect(addCall?.args).toContain("branch/agentxyz-42");
  });

  test("the nonce disambiguates repeated branches of one agent", async () => {
    const git = fakeGit();
    let n = 0;
    const a = await branchAgent("agent-1", {
      repoRoot: "/repo",
      runGit: git.run,
      worktreeParent: TMP_WT,
      nonce: () => String(++n),
    });
    const b = await branchAgent("agent-1", {
      repoRoot: "/repo",
      runGit: git.run,
      worktreeParent: TMP_WT,
      nonce: () => String(++n),
    });
    expect(a.branch).not.toBe(b.branch);
    expect(a.worktree_path).not.toBe(b.worktree_path);
  });

  test("a rev-parse failure (non-git cwd) throws", async () => {
    const git = fakeGit({ failOn: "rev-parse" });
    await expect(
      branchAgent("agent-1", {
        repoRoot: "/not-a-repo",
        runGit: git.run,
        worktreeParent: TMP_WT,
        nonce: () => "1",
      }),
    ).rejects.toThrow(/cannot resolve HEAD/);
  });

  test("a worktree-add failure throws with the git stderr", async () => {
    const git = fakeGit({ failOn: "worktree" });
    await expect(
      branchAgent("agent-1", {
        repoRoot: "/repo",
        runGit: git.run,
        worktreeParent: TMP_WT,
        nonce: () => "1",
      }),
    ).rejects.toThrow(/git worktree add failed/);
  });
});

// ---------------------------------------------------------------------------
// VOS-165: pruneBranchWorktrees — teardown / GC for the worktrees the branch
// verb accumulates.
// ---------------------------------------------------------------------------

/**
 * A fake git runner for prune tests. `worktree list --porcelain` returns the
 * canned `listOutput`; `worktree remove` records the removed path and 0-exits
 * unless its path is in `failRemove`.
 */
function fakePruneGit(opts: {
  listOutput: string;
  listFails?: boolean;
  failRemove?: string[];
}) {
  const removed: string[] = [];
  return {
    removed,
    run: async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        if (opts.listFails) {
          return { stdout: "", stderr: "fatal: not a git repository", exitCode: 1 };
        }
        return { stdout: opts.listOutput, stderr: "", exitCode: 0 };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        const target = args[args.length - 1];
        if (opts.failRemove?.includes(target)) {
          return { stdout: "", stderr: "fatal: worktree is dirty", exitCode: 1 };
        }
        removed.push(target);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

/** Compose a `git worktree list --porcelain` blob from (path, branch) pairs. */
function porcelain(entries: Array<{ path: string; branch?: string }>): string {
  return entries
    .map((e) => {
      const lines = [`worktree ${e.path}`, "HEAD " + "0".repeat(40)];
      if (e.branch) lines.push(`branch refs/heads/${e.branch}`);
      else lines.push("detached");
      return lines.join("\n");
    })
    .join("\n\n") + "\n";
}

describe("VOS-165: pruneBranchWorktrees", () => {
  test("removes only worktrees on a branch/* branch", async () => {
    const git = fakePruneGit({
      listOutput: porcelain([
        { path: "/repo", branch: "main" }, // the daemon's own checkout
        { path: "/repo-wt/agent1-1", branch: "branch/agent1-1" },
        { path: "/repo-wt/agent2-2", branch: "branch/agent2-2" },
        { path: "/repo-wt/manual", branch: "feature/manual" }, // hand-made
      ]),
    });
    const report = await pruneBranchWorktrees({ repoRoot: "/repo", runGit: git.run });
    expect(report.pruned.map((w) => w.path).sort()).toEqual([
      "/repo-wt/agent1-1",
      "/repo-wt/agent2-2",
    ]);
    expect(git.removed.sort()).toEqual(["/repo-wt/agent1-1", "/repo-wt/agent2-2"]);
    expect(report.kept).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
  });

  test("the TTL filter keeps worktrees touched more recently than the cutoff", async () => {
    const git = fakePruneGit({
      listOutput: porcelain([
        { path: "/repo-wt/old", branch: "branch/old-1" },
        { path: "/repo-wt/fresh", branch: "branch/fresh-2" },
      ]),
    });
    const NOW = 1_000_000_000_000;
    const report = await pruneBranchWorktrees({
      repoRoot: "/repo",
      runGit: git.run,
      olderThanMs: 60_000, // 1 minute
      now: () => NOW,
      mtimeOf: (p) => (p.endsWith("fresh") ? NOW - 1_000 : NOW - 120_000),
    });
    expect(report.pruned.map((w) => w.path)).toEqual(["/repo-wt/old"]);
    expect(report.kept.map((w) => w.path)).toEqual(["/repo-wt/fresh"]);
    expect(git.removed).toEqual(["/repo-wt/old"]);
  });

  test("a per-worktree remove failure is recorded, the sweep continues", async () => {
    const git = fakePruneGit({
      listOutput: porcelain([
        { path: "/repo-wt/dirty", branch: "branch/dirty-1" },
        { path: "/repo-wt/clean", branch: "branch/clean-2" },
      ]),
      failRemove: ["/repo-wt/dirty"],
    });
    const report = await pruneBranchWorktrees({ repoRoot: "/repo", runGit: git.run });
    expect(report.pruned.map((w) => w.path)).toEqual(["/repo-wt/clean"]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].path).toBe("/repo-wt/dirty");
    expect(report.failed[0].error).toMatch(/dirty/);
  });

  test("a worktree-list failure (non-git repoRoot) throws", async () => {
    const git = fakePruneGit({ listOutput: "", listFails: true });
    await expect(
      pruneBranchWorktrees({ repoRoot: "/not-a-repo", runGit: git.run }),
    ).rejects.toThrow(/cannot list worktrees/);
  });

  test("with no branch/* worktrees, the report is empty", async () => {
    const git = fakePruneGit({
      listOutput: porcelain([{ path: "/repo", branch: "main" }]),
    });
    const report = await pruneBranchWorktrees({ repoRoot: "/repo", runGit: git.run });
    expect(report.pruned).toHaveLength(0);
    expect(report.kept).toHaveLength(0);
    expect(report.failed).toHaveLength(0);
    expect(git.removed).toHaveLength(0);
  });
});
