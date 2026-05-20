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

import { mkdirSync, statSync } from "node:fs";
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

// VOS-165: teardown / GC for the worktrees the branch verb accumulates.
//
// `branchAgent` mints a worktree per call and never removes it. Left
// unattended they pile up under `<repoRoot>-wt/`. There is no agent
// lifecycle hook to clean them on completion (branch operates on git
// state, not the live run — the branched checkout outlives the agent), so
// the GC is operator-driven: a prune sweep.
//
// The sweep is namespace-scoped — it only touches worktrees whose checked
// -out branch is in the `branch/*` namespace the verb mints, so a hand-
// made worktree or the daemon's own checkout is never removed.

/** One pruned (or kept) worktree in a prune report. */
export interface BranchWorktree {
  /** Absolute worktree path. */
  path: string;
  /** The branch the worktree is checked out on (e.g. `branch/agent1-42`). */
  branch: string;
}

export interface PruneReport {
  /** Worktrees successfully removed. */
  pruned: BranchWorktree[];
  /** `branch/*` worktrees skipped (TTL not reached). */
  kept: BranchWorktree[];
  /** Worktrees a `git worktree remove` failed on, with the git error. */
  failed: Array<BranchWorktree & { error: string }>;
}

export interface PruneBranchWorktreesDeps {
  /** The git repo whose worktrees are enumerated — same repoRoot as branchAgent. */
  repoRoot: string;
  /** Spawn a `git` subprocess. Defaults to Bun.spawn; tests inject a stub. */
  runGit?: (
    args: string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /**
   * If set, a `branch/*` worktree whose directory mtime is newer than
   * `Date.now() - olderThanMs` is kept (the operator may still be using
   * it). Unset = prune every `branch/*` worktree.
   */
  olderThanMs?: number;
  /** Test seam: override the mtime lookup. Defaults to `statSync(p).mtimeMs`. */
  mtimeOf?: (worktreePath: string) => number;
  /** Test seam: override the wall clock. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Parse `git worktree list --porcelain` into (path, branch) records.
 *
 * Porcelain blocks are blank-line separated; each has a `worktree <path>`
 * line and (for an attached worktree) a `branch refs/heads/<name>` line.
 */
function parseWorktreeList(
  porcelain: string,
): Array<{ path: string; branch: string | null }> {
  const out: Array<{ path: string; branch: string | null }> = [];
  let cur: { path: string; branch: string | null } | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice("worktree ".length).trim(), branch: null };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Prune the git worktrees the branch verb has accumulated.
 *
 * Only worktrees on a `branch/*` branch are candidates — that is the
 * namespace `branchAgent` mints, so the daemon's own checkout and any
 * hand-made worktree are untouched. With `olderThanMs` set, a candidate
 * whose directory mtime is newer than the cutoff is kept.
 *
 * Throws if `git worktree list` itself fails (a non-git repoRoot). A
 * per-worktree `git worktree remove` failure does NOT abort the sweep —
 * it is recorded in `report.failed` and the remaining worktrees still get
 * a chance.
 */
export async function pruneBranchWorktrees(
  deps: PruneBranchWorktreesDeps,
): Promise<PruneReport> {
  const runGit = deps.runGit ?? defaultRunGit;
  const repoRoot = deps.repoRoot;

  const list = await runGit(["worktree", "list", "--porcelain"], repoRoot);
  if (list.exitCode !== 0) {
    throw new Error(
      `prune: cannot list worktrees in ${repoRoot}: ${list.stderr.trim()}`,
    );
  }

  const candidates = parseWorktreeList(list.stdout).filter(
    (w): w is { path: string; branch: string } =>
      w.branch != null && w.branch.startsWith("branch/"),
  );

  const cutoff =
    deps.olderThanMs != null
      ? (deps.now ?? Date.now)() - deps.olderThanMs
      : null;
  const mtimeOf =
    deps.mtimeOf ?? ((p: string) => statSync(p).mtimeMs);

  const report: PruneReport = { pruned: [], kept: [], failed: [] };

  for (const w of candidates) {
    if (cutoff != null) {
      let mtime: number;
      try {
        mtime = mtimeOf(w.path);
      } catch {
        // Directory already gone — treat as nothing to prune.
        continue;
      }
      if (mtime > cutoff) {
        report.kept.push({ path: w.path, branch: w.branch });
        continue;
      }
    }
    const rm = await runGit(
      ["worktree", "remove", "--force", w.path],
      repoRoot,
    );
    if (rm.exitCode === 0) {
      report.pruned.push({ path: w.path, branch: w.branch });
    } else {
      report.failed.push({
        path: w.path,
        branch: w.branch,
        error: rm.stderr.trim() || rm.stdout.trim(),
      });
    }
  }

  return report;
}
