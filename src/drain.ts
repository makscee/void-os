// src/drain.ts — generic server-side Issue-drain runner. The RUNNER owns the loop:
// it assigns a Box, spawns a fresh skill session to work it, then runs the Box's
// gate itself (auto: runs the check + reads the exit code; human: parks). The skill
// only edits files. `skill` is a parameter — orchestration never hardcodes "ralph".
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sessionDir, bodyPath } from "./paths.ts";
import { runTurn } from "./spawn.ts";
import { parseBoxes, nextOpenBox, allChecked, checkBox, type Box } from "./issue.ts";

export interface DrainOpts {
  vault: string;
  worktree: string;            // ~/void-os-wt/issue-<N>/
  issueNum: number;
  runner: string;              // "vc --"
  skill?: string;              // Decision B: the drainable skill; defaults to "ralph"
  skillPath?: string;          // Absolute path to the skill's SKILL.md — when set, passed as --append-system-prompt-file instead of /skill slash-command
  max: number;                 // MANDATORY backstop
  autoRetries?: number;        // N inline re-spawns on a red auto gate (default 3)
  fetchBody: () => Promise<string>;                 // gh issue view --json body -q .body (re-fetch each iter)
  writeBody: (body: string) => Promise<void>;       // gh issue edit --body-file - (targeted, after checkBox)
  runGate: (check: string) => Promise<number>;      // runner runs the auto check in the worktree; returns exit code
  commit: (message: string) => Promise<void>;       // git add -A && git commit -m <message> in the worktree
  commentDrained?: () => Promise<void>;             // gh issue comment "drained locally, unpushed" — Issue stays OPEN
  /** When set: the continuation drain treats this human box as accepted (verdict-aware path A).
   *  The runner does the checkBox write + commit for that box without re-spawning, then loops. */
  acceptHumanBox?: string;    // the `box.raw` of the human box that was accepted
}

export interface DrainResult {
  status: "complete" | "parked-human" | "failed" | "max-reached" | "stalled" | "dirty-worktree" | "stopped";
  parkedUuid?: string;         // session awaiting a human verdict
  failedBox?: string;          // the auto box that stayed red after autoRetries
  iterations: number;
}

/** Tail progress.txt: inject only the last ~maxLines lines (or since the last `DONE:`)
 *  — protects the ~2–8k budget + the stable-prefix cache. progress.txt stays append-only. */
export function tailProgress(progress: string, maxLines = 40): string {
  if (!progress.trim()) return "(empty)";
  const lines = progress.split("\n");
  const lastDone = lines.map((l, i) => (l.startsWith("DONE:") ? i : -1)).filter((i) => i >= 0).pop();
  const start = lastDone !== undefined
    ? Math.min(lastDone, Math.max(0, lines.length - maxLines))
    : Math.max(0, lines.length - maxLines);
  return lines.slice(start).join("\n");
}

/** Build the launch prompt for the ONE assigned Box + the progress tail. */
export function buildDrainPrompt(issueNum: number, box: Box, progress: string): string {
  return [
    `Issue #${issueNum}. Your assigned Box (work ONLY this one):`,
    box.raw,
    `--- progress.txt (recent tail) ---`,
    tailProgress(progress),
  ].join("\n");
}

export async function drain(opts: DrainOpts): Promise<DrainResult> {
  const skill = opts.skill ?? "ralph";
  const retries = opts.autoRetries ?? 3;
  const progressPath = join(opts.worktree, "progress.txt");
  // NOTE: do NOT pre-create progress.txt here — creating it would make the worktree dirty
  // before the clean-tree guard runs on iteration 1. appendProgress creates it lazily.

  for (let i = 1; i <= opts.max; i++) {
    // Stop control: if a Stop was issued for this drain, halt — do NOT auto-advance.
    // The stopped box stays unchecked; a manual re-trigger resumes (idempotent: checked boxes skipped).
    if (existsSync(join(opts.worktree, "drain.stop"))) {
      return { status: "stopped", iterations: i - 1 };
    }

    // Clean-tree guard: each Box starts from a committed tree so the runner's
    // `git add -A` captures only its own changes — never stray scratch from a crash.
    // Exception: skip the guard on the first iteration of an acceptHumanBox continuation —
    // the skill made reviewable changes (expected dirty tree) and the runner commits them via checkBox.
    const skipDirtyGuard = i === 1 && !!opts.acceptHumanBox;
    if (!skipDirtyGuard && (await gitPorcelain(opts.worktree)).trim() !== "") {
      return { status: "dirty-worktree", iterations: i - 1 };
    }

    const body = await opts.fetchBody();          // re-fetch each iter (idempotent)
    const boxes = parseBoxes(body);
    if (allChecked(boxes)) return await finishComplete(i - 1);
    const box = nextOpenBox(boxes);
    if (!box) return { status: "stalled", iterations: i - 1 };

    // Verdict-aware path A: if this box was accepted by the operator (human verdict),
    // the runner does the checkBox write + commit for it WITHOUT re-spawning, then loops.
    if (opts.acceptHumanBox && box.raw === opts.acceptHumanBox) {
      const fresh = await opts.fetchBody();
      const target = parseBoxes(fresh).find((b) => b.raw === box.raw) ?? box;
      await opts.writeBody(checkBox(fresh, target));
      appendProgress(progressPath, `DONE: ${box.title} (human accepted)`);
      await opts.commit(box.title);
      // Clear the acceptHumanBox flag after consuming it — don't apply to next boxes
      opts = { ...opts, acceptHumanBox: undefined };
      continue;
    }

    const uuid = randomUUID();
    mkdirSync(sessionDir(opts.vault, uuid), { recursive: true });
    // Persist drain context so POST /s/:uuid/send can resume + re-invoke drain() after a human verdict.
    const baseMeta = {
      skill,
      launchedAt: Date.now(),
      text: `drain #${opts.issueNum}`,
      runner: opts.runner,
      drainIssue: opts.issueNum,
      worktree: opts.worktree,
      max: opts.max,
    };

    if (box.gate.kind === "human") {
      // Store the parked box raw in meta so POST /s/:uuid/send can pass acceptHumanBox to the continuation.
      writeFileSync(
        join(sessionDir(opts.vault, uuid), "session-meta.json"),
        JSON.stringify({ ...baseMeta, parkedBoxRaw: box.raw }),
      );
      // Spawn once so the skill renders the artifact + <form> into body.html, then park.
      const progress = existsSync(progressPath) ? readFileSync(progressPath, "utf8") : "";
      await spawnBox(uuid, box, progress);
      return { status: "parked-human", parkedUuid: uuid, iterations: i };
    }

    writeFileSync(
      join(sessionDir(opts.vault, uuid), "session-meta.json"),
      JSON.stringify(baseMeta),
    );

    // auto gate — RUNNER runs the check after the skill exits; bounded inline recovery.
    const check = box.gate.check;
    let green = false;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const progress = existsSync(progressPath) ? readFileSync(progressPath, "utf8") : "";
      await spawnBox(uuid, box, progress, attempt > 1
        ? `Previous attempt left the gate RED. Fix the cause.` : undefined);
      const code = await opts.runGate(check);       // runner runs the gate
      if (code === 0) { green = true; break; }
      appendProgress(progressPath, `RETRY ${attempt}: ${box.title} — gate red (exit ${code})`);
    }
    if (!green) {
      appendProgress(progressPath, `FAILED: ${box.title} — auto gate red after ${retries} attempts`);
      // Commit the FAILED progress line so the tree is clean for any re-run (no checkbox flip).
      await opts.commit(`progress: ${box.title} FAILED (auto gate red)`);
      return { status: "failed", failedBox: box.title, iterations: i };
    }

    // Green: runner owns the checkbox write (re-fetch immediately before — lost-update safe) + commit.
    const fresh = await opts.fetchBody();
    const target = parseBoxes(fresh).find((b) => b.raw === box.raw) ?? box;
    await opts.writeBody(checkBox(fresh, target));
    appendProgress(progressPath, `DONE: ${box.title}`);
    await opts.commit(box.title);
    // loop
  }
  return { status: "max-reached", iterations: opts.max };

  // --- helpers ---
  async function spawnBox(uuid: string, box: Box, progress: string, extra?: string): Promise<void> {
    const base = buildDrainPrompt(opts.issueNum, box, progress);
    const prompt = extra ? `${base}\n--- note ---\n${extra}` : base;
    // If skillPath is provided, inject the SKILL.md as a system prompt appendage and pass the
    // drain prompt directly as -p <text>. This avoids the /skill slash-command mechanism which
    // requires a Claude Code plugin registration — the void-os catalog format (SKILL.md) is not
    // a Claude Code plugin. Decision B: the skill parameter is still threaded through for labeling.
    const argv = opts.skillPath
      ? ["--session-id", uuid, "--append-system-prompt-file", opts.skillPath, "-p", prompt, "--permission-mode", "bypassPermissions"]
      : ["--session-id", uuid, "-p", `/${skill} ${prompt}`, "--permission-mode", "bypassPermissions"];
    await runTurn(opts.worktree, opts.vault, uuid, argv, opts.runner);
  }

  async function finishComplete(iterations: number): Promise<DrainResult> {
    const fresh = parseBoxes(await opts.fetchBody());
    if (allChecked(fresh)) {
      await opts.commentDrained?.();            // comment — Issue stays OPEN
      if (existsSync(progressPath)) rmSync(progressPath);
      return { status: "complete", iterations };
    }
    return { status: "stalled", iterations };   // a box re-opened mid-flight
  }
}

function appendProgress(path: string, line: string): void {
  writeFileSync(path, (existsSync(path) ? readFileSync(path, "utf8") : "") + line + "\n");
}

/** `git status --porcelain` in the worktree — empty string = clean tree.
 *  Non-repo dir (`git status` errors) → treat as clean (the guard is a scratch-leak net). */
async function gitPorcelain(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd, stdout: "pipe", stderr: "ignore" });
  if ((await proc.exited) !== 0) return "";
  return await new Response(proc.stdout).text();
}
