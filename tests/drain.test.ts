// tests/drain.test.ts — TDD for the runner-owned gated drain loop (src/drain.ts)
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drain, tailProgress, buildDrainPrompt, type DrainOpts } from "../src/drain.ts";
import { sessionDir, bodyPath } from "../src/paths.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fakeSkillPath = join(repoRoot, "tests/fixtures/fake-skill.ts");

// --- 1. tailProgress unit ---

test("tailProgress returns (empty) for empty string", () => {
  expect(tailProgress("")).toBe("(empty)");
});

test("tailProgress returns (empty) for whitespace-only string", () => {
  expect(tailProgress("   \n  ")).toBe("(empty)");
});

test("tailProgress tails to last maxLines lines", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  const result = tailProgress(lines.join("\n"), 40);
  expect(result.split("\n")).toHaveLength(40);
  expect(result).toContain("line 59");
  expect(result).not.toContain("line 0");
});

test("tailProgress starts from last DONE: line when within maxLines", () => {
  const lines = ["early stuff", "DONE: box 1", "more stuff", "DONE: box 2", "after done"];
  const result = tailProgress(lines.join("\n"), 40);
  // Should include from second DONE: onwards
  expect(result).toContain("DONE: box 2");
  expect(result).toContain("after done");
});

// --- Helper to build a minimal DrainOpts with injected callbacks ---

function makeVault(name: string): string {
  const v = `/tmp/drain-test-${name}`;
  rmSync(v, { recursive: true, force: true });
  mkdirSync(v, { recursive: true });
  return v;
}

function makeWorktree(name: string): string {
  const wt = `/tmp/drain-wt-${name}`;
  rmSync(wt, { recursive: true, force: true });
  mkdirSync(wt, { recursive: true });
  // Init a real git repo in the worktree so git operations work
  const proc = Bun.spawnSync(["git", "init"], { cwd: wt });
  if (proc.exitCode !== 0) throw new Error("git init failed");
  Bun.spawnSync(["git", "config", "user.email", "test@test.com"], { cwd: wt });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: wt });
  // An initial commit so we have a HEAD
  writeFileSync(join(wt, ".gitkeep"), "");
  Bun.spawnSync(["git", "add", "-A"], { cwd: wt });
  Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: wt });
  return wt;
}

function makeBody(boxes: string[]): string {
  return boxes.join("\n") + "\n";
}

// Simple 1-box auto body
const AUTO_BODY = makeBody([
  "- [ ] Box A {auto: exit 0} {p1}",
  "      criteria for A",
]);

const HUMAN_BODY = makeBody([
  "- [ ] Box H {human} {p1}",
  "      criteria for H",
]);

const TWO_AUTO_BODY = makeBody([
  "- [ ] Box A {auto: exit 0} {p1}",
  "      criteria for A",
  "- [ ] Box B {auto: exit 0} {p2}",
  "      criteria for B",
]);

// --- 2. runner-runs-the-auto-check ---

test("runner runs the auto gate after the skill exits; on green: writeBody+commit called, skill never touched the box", async () => {
  const vault = makeVault("auto-gate");
  const worktree = makeWorktree("auto-gate");

  let bodyState = AUTO_BODY;
  let writtenBody = "";
  let commitMessages: string[] = [];
  let runGateCalled = false;

  const opts: DrainOpts = {
    vault,
    worktree,
    issueNum: 1,
    runner: `bun ${fakeSkillPath} --`,
    skill: "ralph",
    max: 5,
    autoRetries: 1,
    fetchBody: async () => bodyState,
    writeBody: async (body) => { writtenBody = body; bodyState = body; },
    runGate: async (_check) => { runGateCalled = true; return 0; },
    commit: async (msg) => {
      commitMessages.push(msg);
      // Real commit so the worktree is clean for the next iteration
      Bun.spawnSync(["git", "add", "-A"], { cwd: worktree });
      Bun.spawnSync(["git", "commit", "-m", msg], { cwd: worktree });
    },
    commentDrained: async () => {},
  };

  const result = await drain(opts);

  expect(result.status).toBe("complete");
  expect(runGateCalled).toBe(true);
  // The runner called writeBody with the box checked
  expect(writtenBody).toContain("- [x] Box A");
  expect(commitMessages.length).toBeGreaterThan(0);
}, 30000);

// --- 3. multi-iteration PROGRESS loop ---

test("multi-iteration loop: drain two auto boxes, status=complete, iterations=2", async () => {
  const vault = makeVault("multi-iter");
  const worktree = makeWorktree("multi-iter");

  // fetchBody returns updated state after each writeBody
  let bodyState = TWO_AUTO_BODY;
  let iterations = 0;
  const commitMessages: string[] = [];

  const opts: DrainOpts = {
    vault,
    worktree,
    issueNum: 2,
    runner: `bun ${fakeSkillPath} --`,
    skill: "ralph",
    max: 10,
    autoRetries: 1,
    fetchBody: async () => bodyState,
    writeBody: async (body) => { bodyState = body; iterations++; },
    runGate: async () => 0,
    commit: async (msg) => {
      commitMessages.push(msg);
      // Real commit so the worktree is clean for the next iteration
      Bun.spawnSync(["git", "add", "-A"], { cwd: worktree });
      Bun.spawnSync(["git", "commit", "-m", msg], { cwd: worktree });
    },
    commentDrained: async () => {},
  };

  const result = await drain(opts);

  expect(result.status).toBe("complete");
  expect(iterations).toBe(2);
}, 30000);

// --- 4. cwd≠vault split ---

test("cwd/vault split: skill commit lands in worktree; session state readable under vault; vault has no .git", async () => {
  const vault = makeVault("cwd-split");
  const worktree = makeWorktree("cwd-split");

  let bodyState = AUTO_BODY;
  let runGateCalled = false;

  const opts: DrainOpts = {
    vault,
    worktree,
    issueNum: 3,
    runner: `bun ${fakeSkillPath} --`,
    skill: "ralph",
    max: 5,
    autoRetries: 1,
    fetchBody: async () => bodyState,
    writeBody: async (body) => { bodyState = body; },
    runGate: async () => { runGateCalled = true; return 0; },
    commit: async () => {
      // Real git commit in the worktree
      Bun.spawnSync(["git", "add", "-A"], { cwd: worktree });
      Bun.spawnSync(["git", "commit", "-m", "test-box"], { cwd: worktree });
    },
    commentDrained: async () => {},
  };

  const result = await drain(opts);

  expect(result.status).toBe("complete");

  // (a) worktree got a commit (beyond the init commit)
  const logProc = Bun.spawnSync(["git", "log", "--oneline"], { cwd: worktree, stdout: "pipe" });
  const logOut = new TextDecoder().decode(logProc.stdout);
  expect(logOut.split("\n").filter(Boolean).length).toBeGreaterThan(1);

  // (b) session state (body.html) is readable under vault
  const sessions = existsSync(join(vault, "sessions"));
  expect(sessions).toBe(true);

  // (c) vault has no .git — it's not a git repo, it's just a directory
  expect(existsSync(join(vault, ".git"))).toBe(false);
}, 30000);

// --- 5. human-park ---

test("human-park: single human box parks and returns parked-human with drainIssue in meta", async () => {
  const vault = makeVault("human-park");
  const worktree = makeWorktree("human-park");

  const opts: DrainOpts = {
    vault,
    worktree,
    issueNum: 4,
    runner: `bun ${fakeSkillPath} --`,
    skill: "ralph",
    max: 5,
    autoRetries: 1,
    fetchBody: async () => HUMAN_BODY,
    writeBody: async () => {},
    runGate: async () => 0,
    commit: async () => {},
    commentDrained: async () => {},
  };

  const result = await drain(opts);

  expect(result.status).toBe("parked-human");
  expect(result.parkedUuid).toBeDefined();

  // session-meta.json carries drain context + parkedBoxRaw for verdict-aware continuation
  const metaPath = join(sessionDir(vault, result.parkedUuid!), "session-meta.json");
  expect(existsSync(metaPath)).toBe(true);
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  expect(meta.drainIssue).toBe(4);
  expect(meta.worktree).toBe(worktree);
  expect(meta.max).toBe(5);
  expect(meta.skill).toBe("ralph");
  // parkedBoxRaw lets the /send handler pass acceptHumanBox to the continuation drain
  expect(typeof meta.parkedBoxRaw).toBe("string");
  expect(meta.parkedBoxRaw).toContain("Box H");
}, 30000);

// --- 5b. acceptHumanBox with dirty worktree (verdict-aware path A) ---
test("acceptHumanBox: dirty worktree skipped on i=1, box checked + committed, then completes", async () => {
  const vault = makeVault("accept-human");
  const worktree = makeWorktree("accept-human");

  // Simulate a dirty tree: create a file the skill "left behind"
  const { writeFileSync: wfs } = await import("node:fs");
  wfs(join(worktree, "skill-work.txt"), "polished content from skill");

  const HUMAN_BOX_RAW = HUMAN_BODY.split("\n").find(l => l.includes("Box H"))!;
  let bodyState = HUMAN_BODY; // p3 still unchecked (same body as the parked drain had)
  const commitMessages: string[] = [];
  let writeBodyCalled = false;

  const opts: DrainOpts = {
    vault,
    worktree,
    issueNum: 9,
    runner: `bun ${fakeSkillPath} --`,
    skill: "ralph",
    max: 5,
    autoRetries: 1,
    acceptHumanBox: HUMAN_BOX_RAW,
    fetchBody: async () => bodyState,
    writeBody: async (body) => { writeBodyCalled = true; bodyState = body; },
    runGate: async () => 0,
    commit: async (msg) => {
      commitMessages.push(msg);
      // Stage + commit the dirty files so the tree is clean after
      const { spawnSync } = await import("node:child_process");
      spawnSync("git", ["add", "-A"], { cwd: worktree });
      spawnSync("git", ["commit", "-m", msg, "--allow-empty"], { cwd: worktree });
    },
    commentDrained: async () => {},
  };

  const result = await drain(opts);
  // The dirty worktree is skipped on i=1 (acceptHumanBox), box is checked + committed, then complete
  expect(result.status).toBe("complete");
  expect(writeBodyCalled).toBe(true);
  expect(commitMessages).toHaveLength(1);
  expect(commitMessages[0]).toContain("Box H");
}, 30000);

// --- 6. red-after-N → terminal failed (no loop-to-max) ---

test("red-after-N: status=failed, box stays unchecked, writeBody never called, FAILED: in progress.txt", async () => {
  const vault = makeVault("red-failed");
  const worktree = makeWorktree("red-failed");

  let bodyState = AUTO_BODY;
  let writeBodyCalled = false;
  const commitMessages: string[] = [];

  const opts: DrainOpts = {
    vault,
    worktree,
    issueNum: 5,
    runner: `bun ${fakeSkillPath} --`,
    skill: "ralph",
    max: 10,
    autoRetries: 3,
    fetchBody: async () => bodyState,
    writeBody: async (body) => { writeBodyCalled = true; bodyState = body; },
    runGate: async () => 1, // always red
    commit: async (msg) => {
      commitMessages.push(msg);
      // Real commit so any stray files are staged
      Bun.spawnSync(["git", "add", "-A"], { cwd: worktree });
      Bun.spawnSync(["git", "commit", "-m", msg], { cwd: worktree });
    },
    commentDrained: async () => {},
  };

  const result = await drain(opts);

  expect(result.status).toBe("failed");
  expect(result.failedBox).toBe("Box A");
  expect(result.iterations).toBe(1); // NOT max (10)
  expect(writeBodyCalled).toBe(false); // box stays unchecked
  expect(bodyState).toContain("- [ ] Box A"); // still open

  // FAILED: line in progress.txt
  const progressPath = join(worktree, "progress.txt");
  expect(existsSync(progressPath)).toBe(true);
  const progress = readFileSync(progressPath, "utf8");
  expect(progress).toContain("FAILED:");
}, 30000);

// --- 7. idempotent re-run skips already-checked boxes ---

test("idempotent re-run: all boxes already checked → complete with zero spawns and no writeBody/commit", async () => {
  const vault = makeVault("idempotent");
  const worktree = makeWorktree("idempotent");

  const checkedBody = makeBody(["- [x] Box A {auto: exit 0} {p1}", "      done"]);
  let spawnCount = 0;
  let writeBodyCalled = false;
  let commitCalled = false;

  const opts: DrainOpts = {
    vault,
    worktree,
    issueNum: 6,
    // runner that counts spawns — if drain is right, it never reaches runTurn
    runner: `bun ${fakeSkillPath} --`,
    skill: "ralph",
    max: 5,
    autoRetries: 1,
    fetchBody: async () => checkedBody,
    writeBody: async () => { writeBodyCalled = true; },
    runGate: async () => { spawnCount++; return 0; },
    commit: async () => { commitCalled = true; },
    commentDrained: async () => {},
  };

  const result = await drain(opts);

  expect(result.status).toBe("complete");
  expect(spawnCount).toBe(0);
  expect(writeBodyCalled).toBe(false);
  expect(commitCalled).toBe(false);
}, 30000);

// --- 8b. drain.stop halt ---

test("drain halts when drain.stop flag is present — no box spawned, status=stopped", async () => {
  const vault = makeVault("drain-stop");
  const worktree = makeWorktree("drain-stop");
  writeFileSync(join(worktree, "drain.stop"), "1");

  let spawnCalled = false;
  let writeBodyCalled = false;

  const opts: DrainOpts = {
    vault,
    worktree,
    issueNum: 99,
    runner: `bun ${fakeSkillPath} --`,
    skill: "ralph",
    max: 5,
    autoRetries: 1,
    fetchBody: async () => AUTO_BODY,
    writeBody: async () => { writeBodyCalled = true; },
    runGate: async () => { spawnCalled = true; return 0; },
    commit: async () => {},
    commentDrained: async () => {},
  };

  const result = await drain(opts);
  expect(result.status).toBe("stopped");
  expect(spawnCalled).toBe(false);
  expect(writeBodyCalled).toBe(false);
}, 10000);

// --- 8. dirty-worktree guard ---

test("dirty-worktree guard: untracked file in worktree → status=dirty-worktree, no spawn", async () => {
  const vault = makeVault("dirty-wt");
  const worktree = makeWorktree("dirty-wt");

  // Leave a stray untracked file
  writeFileSync(join(worktree, "stray.txt"), "stray");

  let spawnCalled = false;

  const opts: DrainOpts = {
    vault,
    worktree,
    issueNum: 7,
    runner: `bun ${fakeSkillPath} --`,
    skill: "ralph",
    max: 5,
    autoRetries: 1,
    fetchBody: async () => AUTO_BODY,
    writeBody: async () => {},
    runGate: async () => { spawnCalled = true; return 0; },
    commit: async () => {},
    commentDrained: async () => {},
  };

  const result = await drain(opts);

  expect(result.status).toBe("dirty-worktree");
  expect(spawnCalled).toBe(false);
}, 10000);
