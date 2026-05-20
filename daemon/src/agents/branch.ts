// VOS-162: branch verb — fork a running (or recently-ended) agent into a
// new git worktree.
//
// VOS-155 frozen decision (2026-05-20T11:16:59Z): "branch action → new
// worktree per branch via existing `~/hub-wt/<NEW-ID>/` pattern. Branch
// from parent's HEAD (clean state); operator stashes parent WIP if needed.
// Reuses `git worktree add` + teardown infra → zero new mechanism."
//
// What "branch a running agent" produces, concretely:
//   The agent runs with a `cwd` that is a git repo (the daemon's vault /
//   chat cwd). Branching the agent = creating a fresh `git worktree` of
//   that repo at the repo's CURRENT HEAD, on a new branch. The operator
//   gets a clean, isolated checkout to take the work in a new direction —
//   no WIP carryover (the worktree is from HEAD, not the dirty tree).
//
// Why this is NOT in control.ts: pause/kill/resume address a *live run
// handle* — they only work while the agent is running. Branch operates on
// *git state*, so it works for any agent the inspector knows about
// (running OR within the ended-grace window). The 404 boundary is "the
// inflight registry has never seen this agent_id", not "no live handle".

import { mkdirSync } from "node:fs";
import * as path from "node:path";

export interface BranchResult {
  agent_id: string;
  /** Absolute path of the freshly-created worktree. */
  worktree_path: string;
  /** The new branch name the worktree is checked out on. */
  branch: string;
  /** The HEAD SHA the branch was forked from. */
  base_sha: string;
}

export interface BranchAgentDeps {
  /** The git repo to branch — the daemon's chat cwd / vault root. */
  repoRoot: string;
  /**
   * Spawn a `git` subprocess. Defaults to Bun.spawn; tests inject a stub.
   * Resolves to { stdout, stderr, exitCode }.
   */
  runGit?: (
    args: string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Override the worktree-parent directory. Defaults to `<repoRoot>-wt`. */
  worktreeParent?: string;
  /** Disambiguator appended to the branch name; defaults to Date.now(). */
  nonce?: () => string;
}

async function defaultRunGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Short, filesystem-safe slug from an agent id (first 8 alnum chars). */
function shortId(agentId: string): string {
  const cleaned = agentId.replace(/[^a-zA-Z0-9]/g, "");
  return (cleaned.slice(0, 8) || "agent").toLowerCase();
}

/**
 * Create a new git worktree forked from the agent's repo HEAD.
 *
 * Throws on any git failure (caller maps to a 500). A non-git repoRoot
 * surfaces as a thrown error from the `rev-parse HEAD` step.
 */
export async function branchAgent(
  agentId: string,
  deps: BranchAgentDeps,
): Promise<BranchResult> {
  const runGit = deps.runGit ?? defaultRunGit;
  const repoRoot = deps.repoRoot;

  // 1. Resolve the repo's current HEAD — the clean fork point.
  const head = await runGit(["rev-parse", "HEAD"], repoRoot);
  if (head.exitCode !== 0) {
    throw new Error(
      `branch: cannot resolve HEAD in ${repoRoot}: ${head.stderr.trim()}`,
    );
  }
  const baseSha = head.stdout.trim();

  // 2. Compose a unique branch + worktree path. The nonce keeps repeated
  //    branches of the same agent collision-free.
  const nonce = (deps.nonce ?? (() => String(Date.now())))();
  const slug = `${shortId(agentId)}-${nonce}`;
  const branch = `branch/${slug}`;
  const worktreeParent =
    deps.worktreeParent ?? `${repoRoot.replace(/\/$/, "")}-wt`;
  mkdirSync(worktreeParent, { recursive: true });
  const worktreePath = path.join(worktreeParent, slug);

  // 3. `git worktree add -b <branch> <path> <base_sha>` — fork from the
  //    resolved HEAD, NOT the working tree, so no dirty-state carryover.
  const add = await runGit(
    ["worktree", "add", "-b", branch, worktreePath, baseSha],
    repoRoot,
  );
  if (add.exitCode !== 0) {
    throw new Error(
      `branch: git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`,
    );
  }

  return {
    agent_id: agentId,
    worktree_path: worktreePath,
    branch,
    base_sha: baseSha,
  };
}
