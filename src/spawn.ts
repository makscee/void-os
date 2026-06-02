// spawn.ts — argv builders (Task 6) + spawnTurn fire-and-forget integration (Task 8)
// + spawnRun: create Run row + tmux session + per-Run hook settings
import { openSync, closeSync, existsSync, statSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";
import { sessionDir, errorPath, bodyPath, runLogPath, pidPath, stopPath, hookSettingsDir } from "./paths.ts";
import { createExecution } from "./registry.ts";
import { appendEvent } from "./events.ts";
import { newRunSession } from "./tmux.ts";
import { writeHookSettings } from "./hooks-endpoint.ts";

// Absolute paths to the helper scripts shipped with void-os.
const _repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Path to the CC command hook relay script (reads stdin JSON, POSTs to daemon). */
export const hookRelayScriptPath = join(_repoRoot, "scripts", "vos-hook-relay.sh");
/** Path to the tmux Run wrapper script (runs CC, fires ProcessExit on exit). */
export const runWrapperScriptPath = join(_repoRoot, "scripts", "vos-run-wrapper.sh");

const PERM = ["--permission-mode", "bypassPermissions"] as const;
const RENDER_PREAMBLE = "[render contract: rewrite body.html, no terminal reply]";

/** R4: max ms a spawned vc turn may run before we surface an error.
 * deep-research is a fan-out skill that legitimately runs ~7min (measured 415s on a
 * cold start); 300s killed it mid-research. 12min covers research + cold-start headroom
 * while still catching a truly hung vc (e.g. relay auth hang). */
const SPAWN_TIMEOUT_MS = 720_000; // 12 minutes

/**
 * Build argv suffix for a new session launch (no leading --; the runner command owns that).
 *
 * Shape: --session-id <uuid> -p /<skill> [text] --permission-mode bypassPermissions
 */
export function buildLaunchArgv(uuid: string, skill: string, text: string): string[] {
  const prompt = text ? `/${skill} ${text}` : `/${skill}`;
  return ["--session-id", uuid, "-p", prompt, ...PERM];
}

/**
 * Read the ACTUAL CC session ID for a given execution.
 *
 * Primary source: cc-actual-session.txt — written by hooks-endpoint.ts on the first
 * SessionStart hook. This contains the real CC session UUID (the file name in
 * ~/.claude/projects/<proj>/<uuid>.jsonl) which Claude assigns independently of the
 * --session-id hint passed at launch. This is the only reliable source for --resume.
 *
 * Fallback: cc-command.txt — the --session-id value passed at launch. Claude's
 * internal session ID differs, so this fallback only works if CC respects --session-id
 * (which is not guaranteed; kept for compatibility).
 *
 * Returns null if neither file is present or the pattern is not found.
 */
export function readCcSessionId(vault: string, execId: string): string | null {
  const actualPath = join(sessionDir(vault, execId), "cc-actual-session.txt");
  if (existsSync(actualPath)) {
    const id = readFileSync(actualPath, "utf8").trim();
    if (/^[0-9a-f-]{36}$/.test(id)) return id;
  }
  // Fallback: parse the --session-id hint from cc-command.txt
  const ccCmdPath = join(sessionDir(vault, execId), "cc-command.txt");
  if (!existsSync(ccCmdPath)) return null;
  const text = readFileSync(ccCmdPath, "utf8");
  const m = text.match(/--session-id\s+([0-9a-f-]{36})/);
  return m ? m[1] : null;
}

/**
 * Build argv suffix for resuming a session and injecting an answer.
 * Prompt is the render-contract preamble + newline + the user-supplied text.
 *
 * ccSessionId: the Claude session ID (from --session-id at launch, readable via readCcSessionId).
 * Falls back to execId if ccSessionId is not available (legacy / hand-launched sessions).
 *
 * Shape: --resume <ccSessionId> -p <preamble\ntext> --permission-mode bypassPermissions
 */
export function buildAnswerArgv(execId: string, text: string, ccSessionId?: string | null): string[] {
  const resumeId = ccSessionId ?? execId;
  const prompt = `${RENDER_PREAMBLE}\n${text}`;
  return ["--resume", resumeId, "-p", prompt, ...PERM];
}

/** Split a runner command prefix into argv tokens (whitespace-separated). */
export function tokenizeCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/** Return the next run index (1-based) for this session's run-N.log files. */
export function nextRunIndex(vault: string, uuid: string): number {
  const dir = sessionDir(vault, uuid);
  if (!existsSync(dir)) return 1;
  const used = readdirSync(dir).filter((f) => /^run-\d+\.log$/.test(f)).length;
  return used + 1;
}

/**
 * Fire-and-forget: spawn `<command> <argv>` in the vault, pipe output to run-<n>.log,
 * and on exit write error.txt iff the process failed OR exited without advancing
 * body.html (R5: compare mtime BEFORE spawn, not after placeholder write).
 *
 * R4: a SPAWN_TIMEOUT_MS watchdog kills the process and writes an error if it hangs.
 *
 * Uses node:child_process spawn with detached:true so the child leads its own process
 * group (pgid == pid). This lets the stop route kill the whole tree (vc + claude
 * descendants) via process.kill(-pid, signal) — no orphan "finishes anyway".
 *
 * @param command - The runner command prefix (e.g. "vc --" or "claude_artem"), tokenized on whitespace.
 */
export function spawnTurn(vault: string, uuid: string, argv: string[], command: string): void {
  const n = nextRunIndex(vault, uuid);
  const logFd = openSync(runLogPath(vault, uuid, n), "a");
  const bp = bodyPath(vault, uuid);

  // R5: snapshot mtime BEFORE spawning — placeholder write already happened upstream
  // (server.ts writes placeholder before calling spawnTurn for launch).
  // For resume/answer turns body.html already exists with real content.
  const beforeMtime = existsSync(bp) ? statSync(bp).mtimeMs : 0;

  const toks = tokenizeCommand(command);
  // detached:true makes the child its own session/process-group leader (pgid == pid).
  // process.kill(-pid, sig) then signals the whole group (vc + claude descendants).
  const proc = spawn(toks[0], [...toks.slice(1), ...argv], {
    cwd: vault,
    env: { ...process.env, VOID_OS_SESSION: uuid },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  // Persist the child pid so the Stop route can kill the whole group.
  // proc.pid is defined when spawn succeeds; guard against spawn failure.
  if (proc.pid != null) {
    writeFileSync(pidPath(vault, uuid), String(proc.pid));
  }

  // R4: timeout watchdog — kills the whole group and surfaces error if vc hangs
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    try { process.kill(-(proc.pid!), "SIGKILL"); } catch { /* already gone */ }
    writeFileSync(
      errorPath(vault, uuid),
      `timeout after ${SPAWN_TIMEOUT_MS / 1000}s — vc process killed`,
    );
  }, SPAWN_TIMEOUT_MS);

  proc.on("exit", (code) => {
    clearTimeout(watchdog);
    try { closeSync(logFd); } catch { /* ignore */ }
    // Clear the pid file — process has exited.
    try { rmSync(pidPath(vault, uuid)); } catch { /* already gone */ }
    // If the watchdog already killed + recorded the timeout, keep that clearer message
    // rather than clobbering it with the generic SIGTERM exit below.
    if (timedOut) return;
    // Race guard: a Stop wrote stopped.txt — this is a LATE natural completion of an
    // already-killed turn. Do NOT write error.txt or touch body.html; stopped is terminal.
    if (existsSync(stopPath(vault, uuid))) return;
    const afterMtime = existsSync(bp) ? statSync(bp).mtimeMs : 0;
    // R5: advanced means body.html mtime strictly increased from the pre-spawn snapshot
    const advanced = afterMtime > beforeMtime;
    // Only surface an error when body.html was NOT advanced — a non-zero exit code with
    // an updated body.html means the skill finished work and the process exited non-cleanly
    // (e.g. CC SIGTERM after the turn), which is acceptable output.
    if (!advanced) {
      const logFile = runLogPath(vault, uuid, n);
      const tail = existsSync(logFile)
        ? readFileSync(logFile, "utf8").split("\n").slice(-15).join("\n")
        : "";
      writeFileSync(
        errorPath(vault, uuid),
        `exit ${code}; body.html NOT updated\n---\n${tail}`,
      );
    }
  });
}

export interface SpawnRunOpts {
  db: Database;
  vault: string;
  daemonUrl: string;    // e.g. "http://127.0.0.1:4317"
  skill: string | null; // slash-command to pass (omit for raw interactive)
  agent: string | null; // agent label
  runnerCommand: string;
  now?: number;
  inputRef?: string | null;    // file-level input reference (inbox line ref for trigger-fired)
  triggerId?: string | null;   // set for trigger-fired executions
  stepCeiling?: number | null; // set for trigger-fired executions
  outputTarget?: string | null; // declared output target (vault-relative path/glob), from the skill
  forcePrint?: boolean | null;  // override print-mode decision (true = force print, false = force interactive)
  // Agent-launch extras (VOS-200): all optional; absent = no change to existing behavior.
  addDirs?: string[];              // extra --add-dir per agent folder (enforced scope)
  mcpConfigPath?: string | null;   // --mcp-config path (agent-restricted MCP servers)
  appendSystemPrompt?: string;     // STABLE identity → --append-system-prompt (system tier, cached)
  bodyMessage?: string;            // VOLATILE memory → injected into the -p user prompt (messages tier)
}

/**
 * Build the CC argv array for a spawnRun launch (pure function, no side effects).
 * Exported for unit testing. Used internally by spawnRun.
 *
 * Cache split (VOS-200):
 *   - appendSystemPrompt → --append-system-prompt (system tier, cacheable prefix)
 *   - bodyMessage        → included in the -p user prompt (messages tier, volatile)
 * Editing the body does NOT change --append-system-prompt bytes → cache hit.
 */
export function buildSpawnArgv(
  ccSeed: string,
  settingsPath: string,
  vault: string,
  o: {
    skill: string | null;
    isPrint: boolean;
    addDirs?: string[];
    mcpConfigPath?: string | null;
    appendSystemPrompt?: string;
    bodyMessage?: string;
  },
): string[] {
  const skillArg = o.skill ? (o.skill.startsWith("/") ? o.skill : `/${o.skill}`) : null;
  const argv: string[] = [
    "--session-id", ccSeed,
    "--settings", settingsPath,
    "--permission-mode", "bypassPermissions",
    "--add-dir", vault,
  ];
  // Extra dirs from agent folder scope (each one an additional --add-dir)
  for (const d of o.addDirs ?? []) argv.push("--add-dir", d);
  // MCP restriction: only those servers loaded for this agent
  if (o.mcpConfigPath) argv.push("--mcp-config", o.mcpConfigPath, "--strict-mcp-config");
  // STABLE identity → system tier (cacheable prefix). Body MUST NOT appear here.
  if (o.appendSystemPrompt) argv.push("--append-system-prompt", o.appendSystemPrompt);
  // Prompt: agent body (+ optional skill) OR skill alone → -p user message (volatile tier).
  // Falls back to today's skill-only behavior when no body.
  const userPrompt = o.bodyMessage
    ? (skillArg ? `${skillArg}\n\n${o.bodyMessage}` : o.bodyMessage)
    : skillArg;
  if (o.isPrint && userPrompt) argv.push("-p", userPrompt);
  else if (!o.isPrint && userPrompt) argv.push(userPrompt);
  return argv;
}

export interface SpawnRunResult {
  runId: string;
  tmuxSession: string;
}

/**
 * Create an executions row + a named tmux session containing a live CC/vc subprocess.
 * Stateless (ADR-0003): always fresh --session-id, never --resume.
 * Writes per-execution hook settings so CC fires `type:"command"` hooks to the relay
 * script, which POSTs lifecycle events to /hook?run=<runId>.
 *
 * Also appends the `start` event to the file-level event log so the executions
 * table is rebuildable from files (files-first requirement).
 *
 * The tmux session name is `vos-run-<runId>`.
 */
export function spawnRun(opts: SpawnRunOpts): SpawnRunResult {
  const now = opts.now ?? Date.now();
  const runId = `exec-${randomUUID()}`;
  const ccSeed = randomUUID(); // fresh CC thread every time — NO --resume (ADR-0003 §1)

  // Write per-execution hook settings file (type:"command" hooks → relay script → daemon).
  const settingsPath = writeHookSettings(
    hookSettingsDir(opts.vault),
    hookRelayScriptPath,
    opts.daemonUrl,
    runId,
  );

  // Trigger-fired executions use print mode (-p): CC runs the skill as a headless turn and exits.
  // Print mode skips the workspace trust dialog, fires all hooks, and exits cleanly.
  // --settings scopes hooks to this execution. --add-dir vault: pre-authorize the vault directory.
  const skillArg = opts.skill ? (opts.skill.startsWith("/") ? opts.skill : `/${opts.skill}`) : null;
  // Trigger-fired executions with a skill use print mode (-p) by default.
  // forcePrint allows callers to override (e.g. interactive proof runs that need Stop to fire).
  // Agent launches with a bodyMessage also use print mode (body is a -p prompt; no skill needed).
  const hasPrompt = !!(skillArg || opts.bodyMessage);
  const isPrint = opts.forcePrint != null
    ? !!(opts.forcePrint && hasPrompt)
    : !!(opts.triggerId && skillArg);
  const argv = buildSpawnArgv(ccSeed, settingsPath, opts.vault, {
    skill: opts.skill,
    isPrint,
    addDirs: opts.addDirs,
    mcpConfigPath: opts.mcpConfigPath,
    appendSystemPrompt: opts.appendSystemPrompt,
    bodyMessage: opts.bodyMessage,
  });
  const toks = tokenizeCommand(opts.runnerCommand);
  // Build shell-safe command string for tmux. JSON.stringify wraps args with spaces in double
  // quotes, but backtick characters inside double-quoted strings ARE interpreted by sh as
  // command substitution (even inside double quotes). Escape backticks to prevent expansion.
  const ccCommand = [...toks, ...argv].map((a) => {
    if (!a.includes(" ") && !a.includes("`")) return a;
    // Double-quote the arg; escape backticks and $ to prevent sh/bash expansion.
    const escaped = a.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }).join(" ");

  // Wrap in vos-run-wrapper.sh so ProcessExit fires after CC exits.
  const fullCommand = [
    `"${runWrapperScriptPath}"`,
    `"${opts.daemonUrl}"`,
    `"${runId}"`,
    ccCommand,
  ].join(" ");

  const tmuxSession = `vos-run-${runId}`;

  // Persist the assembled CC argv for files-first observability + proof scripts (VOS-200).
  // Written before the session starts so proofs can assert on the actual command line.
  const execDir = sessionDir(opts.vault, runId);
  try {
    mkdirSync(execDir, { recursive: true });
    writeFileSync(join(execDir, "cc-command.txt"), ccCommand + "\n", "utf8");
  } catch { /* non-fatal — proof asserts it exists; any write failure must not abort the spawn */ }

  const pid = newRunSession(tmuxSession, opts.vault, fullCommand, {
    VOID_OS_SESSION: runId,
    VOS_RUN_ID: runId,
    VOID_OS_INPUT_REF: opts.inputRef ?? "",
    VOID_OS_REPO: _repoRoot,
  });

  // Write to executions table (runtime read-model)
  createExecution(opts.db, {
    id: runId, agent: opts.agent, skill: opts.skill, inputRef: opts.inputRef ?? null,
    tmuxSession, now, triggerId: opts.triggerId ?? null, stepCeiling: opts.stepCeiling ?? null,
  });

  // Append start event to file log (files-first source of truth — makes table rebuildable)
  appendEvent(opts.vault, runId, {
    type: "start", agent: opts.agent, skill: opts.skill,
    input_ref: opts.inputRef ?? null, tmux_session: tmuxSession, at: now,
    trigger_id: opts.triggerId ?? null, step_ceiling: opts.stepCeiling ?? null,
    output_target: opts.outputTarget ?? null,
  });

  return { runId, tmuxSession };
}

/**
 * Awaitable spawn of one runner turn. Returns the exit code. Unlike spawnTurn
 * (fire-and-forget, cwd=vault), this lets the drain runner await each iteration
 * and run it in an arbitrary cwd (the worktree). State I/O still resolves under
 * the vault via sessionDir — cwd and vault are independent.
 *
 * Also uses detached:true + persists pid so the Stop route can kill drain turns.
 * @param cwd - working dir for the spawned vc (the worktree for drains).
 */
export async function runTurn(
  cwd: string,
  vault: string,
  uuid: string,
  argv: string[],
  command: string,
): Promise<number> {
  const n = nextRunIndex(vault, uuid);
  const logFd = openSync(runLogPath(vault, uuid, n), "a");
  const toks = tokenizeCommand(command);
  const proc = spawn(toks[0], [...toks.slice(1), ...argv], {
    cwd,
    env: { ...process.env, VOID_OS_SESSION: uuid },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  if (proc.pid != null) {
    writeFileSync(pidPath(vault, uuid), String(proc.pid));
  }
  const watchdog = setTimeout(() => {
    try { process.kill(-(proc.pid!), "SIGKILL"); } catch { /* already gone */ }
  }, SPAWN_TIMEOUT_MS);
  const code: number = await new Promise((res) => proc.on("exit", (c) => res(c ?? -1)));
  clearTimeout(watchdog);
  try { closeSync(logFd); } catch { /* ignore */ }
  try { rmSync(pidPath(vault, uuid)); } catch { /* already gone */ }
  return code;
}
