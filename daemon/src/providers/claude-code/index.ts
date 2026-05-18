// CC spawner. Invokes `claudev claude ...` subprocess.
// T5: full wire-up — Bun.spawn + parser + watchdog + runs/events writes.

import type { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventBus, UsageTurn } from "../../events/index.js";
import { createStreamParser, classifyToolEvents } from "./parser.js";
import { createWatchdog } from "./watchdog.js";
import { parseUsageFromAssistantEvent } from "./usage-extract.js";
import { TraceWriter } from "../../trace/writer";
import type { AgentDefn, PermissionEngine } from "../../permissions/engine.js";
import { resolveSystemDeny } from "../../permissions/engine.js";
import {
  buildSpawnSettings,
  ALLOWED_TOOLS,
  SETTING_SOURCES_ARGS,
} from "./spawn-settings.ts";
import { readAgentPersonaBody } from "./persona.ts";

export interface CcSpawnRequest {
  prompt: string;
  agent: string;
  cwd: string;
  chatId?: string;
  // VOS-112: per-spawn runtime ids forwarded into mcp.json env so the stdio
  // bridge can stamp `_meta.task_id` on every `tools/call` POST to /mcp.
  taskId: string;
  contextId: string;
  kind?: "chat" | "skill" | "worker";
  resumeFrom?: string;
  outputTimeoutMs?: number;
  toolTimeoutMs?: number;
  /** VOS-80 fix: pre-first-event ceiling. Caps how long the user can wait
   *  for the indicator to unstick when CC --resume hangs in claudev
   *  auth/setup (the bug — produces banner noise only, no stream-json).
   *  Defaults to DEFAULT_FIRST_EVENT_TIMEOUT_MS. */
  firstEventTimeoutMs?: number;
  settings?: unknown;
}

export interface KillOpts {
  /** Fast-path cancel: skip SIGTERM grace; send SIGINT immediately, then
   *  SIGKILL after FAST_KILL_GRACE_MS. CC traps SIGTERM and gracefully
   *  flushes the in-flight stream (so the response continues to arrive
   *  for ~5s), but SIGINT mimics Ctrl-C and aborts immediately. Used by
   *  the user-initiated cancel (POST /chat/:id/cancel). Watchdog kills
   *  still go through the default SIGTERM-then-SIGKILL path. */
  fast?: boolean;
}

export interface CcProcess {
  runId: string;
  pid: number;
  sessionId(): Promise<string>;
  kill(opts?: KillOpts): Promise<void>;
  wait(): Promise<{
    exitCode: number;
    sessionId?: string;
    reason: "exited" | "timeout" | "killed";
  }>;
}

export interface CcSpawner {
  spawn(req: CcSpawnRequest): Promise<CcProcess>;
}

export interface ProbeResult {
  ok: boolean;
  version?: string;
  output?: string;
  error?: string;
  code: number;
}

export const DEFAULT_OUTPUT_TIMEOUT_MS = 120_000;
export const DEFAULT_TOOL_TIMEOUT_MS   = 1_800_000;
/** VOS-80 fix: pre-first-event watchdog ceiling. Picked to comfortably exceed
 *  normal cold-start latency (claudev auth + CC SDK init: typically <5s) while
 *  unsticking the indicator quickly in the resume-hang failure mode. The
 *  original idle threshold (120s) is preserved for the post-first-event
 *  phase (mid-stream token gaps), so a slow model response is unaffected. */
export const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 15_000;
export const KILL_GRACE_MS             = 5_000;
/** Fast-cancel grace: SIGINT → wait this long → SIGKILL. Short because the
 *  user has explicitly asked to stop, so we trade graceful-flush for
 *  immediate termination. */
export const FAST_KILL_GRACE_MS        = 250;
export const DEFAULT_WATCHDOG_TICK_MS  = 5_000;

export class NoSessionError extends Error {
  constructor(public runId: string) {
    super(`run ${runId} ended before session_id was captured`);
  }
}

const VERSION_RE = /(\d+\.\d+(?:\.\d+)?)\s*\(Claude Code\)/;
const FALLBACK_VERSION_RE = /\b(\d+\.\d+\.\d+)\b/;

/** VOS-134: env var to point at a non-PATH `claudev` (or replacement wrapper).
 *  Fresh-user fix — `~/.claudev/bin/claudev` is NOT on default PATH; instead
 *  of forcing every operator to edit their shell rc, the daemon reads this
 *  env var first and falls back to "claudev" (PATH lookup). */
export const CC_BIN_ENV_VAR = "VOID_OS_CC_BIN";
export const DEFAULT_CC_BIN = "claudev";

/**
 * VOS-134: resolve the CC wrapper binary for spawn + probe.
 * Precedence:
 *   1. Explicit `binary` arg (test-injected / deps-override)
 *   2. `process.env.VOID_OS_CC_BIN`
 *   3. "claudev" (PATH lookup)
 */
export function resolveCcBin(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit !== undefined && explicit !== "") return explicit;
  const fromEnv = env[CC_BIN_ENV_VAR];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return DEFAULT_CC_BIN;
}

/** VOS-134: PATH search for a bare-name binary. Returns the absolute path of
 *  the first executable named `name` on PATH, or null if none found. Used by
 *  the daemon's pre-flight check to surface "claudev missing" BEFORE the
 *  HTTP server binds — instead of the deferred "Executable not found in $PATH"
 *  buried in the first spawn attempt. */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // Absolute / relative path with separator: check directly.
  if (name.includes("/") || isAbsolute(name)) {
    return existsSync(name) ? name : null;
  }
  const pathVar = env.PATH ?? "";
  if (!pathVar) return null;
  for (const dir of pathVar.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface CcBinCheckArgs {
  /** Override env (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface CcBinCheckResult {
  ok: boolean;
  /** Effective CC binary name/path used for spawn — what resolveCcBin returned. */
  binary: string;
  /** Absolute path if resolution found a file; null otherwise. */
  resolvedPath: string | null;
  /** Actionable error string (set when ok===false). */
  reason?: string;
}

/**
 * VOS-134: daemon-startup pre-flight check. Resolves the CC wrapper via
 * env var → PATH → default, and verifies it exists. Returns a structured
 * result; the caller is responsible for log + exit. Fail-fast so the user
 * sees a clear message before any HTTP traffic is accepted.
 */
export function checkCcBinAvailable(args: CcBinCheckArgs = {}): CcBinCheckResult {
  const env = args.env ?? process.env;
  const binary = resolveCcBin(undefined, env);
  // Absolute path: must exist on disk.
  if (binary.includes("/") || isAbsolute(binary)) {
    if (existsSync(binary)) {
      return { ok: true, binary, resolvedPath: binary };
    }
    return {
      ok: false,
      binary,
      resolvedPath: null,
      reason:
        `void-os daemon: CC wrapper not found at ${binary} ` +
        `(from ${env[CC_BIN_ENV_VAR] ? CC_BIN_ENV_VAR : "default"}). ` +
        `Set ${CC_BIN_ENV_VAR} to your Claude Code wrapper path, ` +
        `or ensure '${DEFAULT_CC_BIN}' is on PATH. ` +
        `Then retry 'void-os daemon start'.`,
    };
  }
  // Bare name: PATH lookup.
  const found = findOnPath(binary, env);
  if (found) {
    return { ok: true, binary, resolvedPath: found };
  }
  const path = env.PATH ?? "";
  const pathPreview = path.length > 200 ? path.slice(0, 200) + "…" : path;
  // VOS-134 I2: when PATH is unset the preview is empty — render "<unset>"
  // instead of leaving a useless lone "." in the message.
  const pathDisplay = pathPreview || "<unset>";
  return {
    ok: false,
    binary,
    resolvedPath: null,
    reason:
      `void-os daemon: CC wrapper not found. ` +
      `Set ${CC_BIN_ENV_VAR} to your Claude Code wrapper path ` +
      `(e.g. ~/.claudev/bin/claudev), ` +
      `or ensure '${DEFAULT_CC_BIN}' is on PATH. ` +
      `Current PATH: ${pathDisplay}. ` +
      `Then retry 'void-os daemon start'.`,
  };
}

/**
 * Probe claudev by invoking `claudev claude --version`.
 * Returns structured result. Handles ENOENT (claudev not on PATH) gracefully.
 * VOS-134: when called with no args, honours `VOID_OS_CC_BIN` env var before
 * falling back to "claudev". Tests can still pass an explicit binary string.
 */
export const probeClaudev = async (
  binary?: string,
): Promise<ProbeResult> => {
  const effectiveBinary = resolveCcBin(binary);
  let proc: Awaited<ReturnType<typeof Bun.spawn>>;
  try {
    proc = Bun.spawn({
      cmd: [effectiveBinary, "claude", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // VOS-134 I1: name the binary we actually tried to spawn. The previous
    // hard-coded "claudev not found on PATH" lied when the binary came from
    // VOID_OS_CC_BIN or an explicit absolute-path argument.
    return {
      ok: false,
      error:
        e.code === "ENOENT"
          ? `'${effectiveBinary}' not found (ENOENT)`
          : (e.message ?? String(err)),
      code: -1,
    };
  }

  const stdoutStream = proc.stdout as ReadableStream<Uint8Array>;
  const stderrStream = proc.stderr as ReadableStream<Uint8Array>;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(stdoutStream).text(),
    new Response(stderrStream).text(),
    proc.exited,
  ]);

  const output = (stdout + stderr).trim();

  if (exitCode !== 0) {
    return {
      ok: false,
      output,
      error: `claudev exited with code ${exitCode}`,
      code: exitCode,
    };
  }

  const match = output.match(VERSION_RE) ?? output.match(FALLBACK_VERSION_RE);
  if (!match) {
    return {
      ok: false,
      output,
      error: "could not parse version from claudev output",
      code: exitCode,
    };
  }

  return {
    ok: true,
    version: match[1],
    output,
    code: exitCode,
  };
};

interface CcSpawnerDeps {
  bus: EventBus;
  db: Database;
  tracesDir: string;
  binary?: string;             // defaults to "claudev"
  watchdogTickMs?: number;     // defaults to DEFAULT_WATCHDOG_TICK_MS
  now?: () => number;
  // VOS-106
  engine: PermissionEngine;
  daemonBase: string;
  hookScriptPath: string;
  loadAgentDefn: (name: string) => AgentDefn;
  /** Test seam: override `Bun.spawn`. Defaults to the real Bun.spawn. */
  spawnFn?: (cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => ReturnType<typeof Bun.spawn>;
}

export const createCcSpawner = (deps: CcSpawnerDeps): CcSpawner => {
  mkdirSync(deps.tracesDir, { recursive: true });
  // VOS-134: honour `VOID_OS_CC_BIN` env var when deps.binary is unset, so
  // operators can point at `~/.claudev/bin/claudev` without editing PATH.
  // Explicit deps.binary (test injection) still wins.
  const binary = resolveCcBin(deps.binary);
  const tickMs = deps.watchdogTickMs ?? DEFAULT_WATCHDOG_TICK_MS;
  const now = deps.now ?? (() => Date.now());

  return {
    async spawn(req) {
      const runId = randomUUID();
      const started = now();
      const outputTimeoutMs = req.outputTimeoutMs ?? DEFAULT_OUTPUT_TIMEOUT_MS;
      const toolTimeoutMs   = req.toolTimeoutMs   ?? DEFAULT_TOOL_TIMEOUT_MS;
      const firstEventTimeoutMs = req.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;

      const tracePath = join(deps.tracesDir, `${runId}.jsonl`);
      const trace = TraceWriter.open(tracePath);
      trace.write("turn.start", {
        runId,
        chatId: req.chatId ?? null,
        agent: req.agent,
        kind: req.kind ?? "chat",
        userMessage: req.prompt,
      });

      // VOS-87 T4: accumulate per-turn usage from CC `assistant` events.
      // Consumed at finalize and emitted on `run.end` so the cost subscriber
      // (cost/index.ts) can record per-turn rows. Pre-VOS-87 the spawner
      // never extracted usage and the subscriber always hit the
      // `cost.missing_usage` warn branch — silent prod bug (VOS-81).
      const usageTurns: UsageTurn[] = [];

      // Insert runs row up-front so 'running' is visible.
      deps.db.prepare(
        "INSERT INTO runs (id, chat_id, agent, kind, status, started_at, trace_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(runId, req.chatId ?? null, req.agent, req.kind ?? "chat", "running", started, tracePath);

      // VOS-106 T6: resolve scopes per agent, write per-run settings + mcp
      // config to disk, extend argv + env. If scope resolution fails we
      // surface as a synchronous spawn error (run.error before exit).
      let settingsPath: string;
      let mcpConfigPath: string;
      let hookEnv: Record<string, string>;
      try {
        const agentDefn = deps.loadAgentDefn(req.agent);
        const scopes = deps.engine.resolveScopes(agentDefn);
        // VOS-106 T11.3: SYSTEM_DENY_FOR_WRITE is expanded via the engine's
        // own `resolveSystemDeny` helper, using the engine's vaultRoot/homeRoot
        // (NOT `req.cwd` / `process.env.HOME` — those can diverge under
        // worker/dispatch contexts). This guarantees the hook env sees the
        // exact same expanded deny list the engine's canWrite() checks against.
        const expandedDeny = resolveSystemDeny({
          vaultRoot: deps.engine.vaultRoot,
          homeRoot: deps.engine.homeRoot,
        });
        const built = buildSpawnSettings({
          agentName: req.agent,
          scopes,
          systemDeny: expandedDeny,
          vaultRoot: deps.engine.vaultRoot,
          daemonBase: deps.daemonBase,
          runId,
          taskId:    req.taskId,
          contextId: req.contextId,
          settingsDir: deps.tracesDir,
          hookScriptPath: deps.hookScriptPath,
        });
        settingsPath = built.settingsPath;
        mcpConfigPath = built.mcpConfigPath;
        hookEnv = built.env;
      } catch (err) {
        const e = err as { message?: string };
        deps.db
          .prepare("UPDATE runs SET status='error', ended_at=?, error=? WHERE id=?")
          .run(now(), e.message ?? String(err), runId);
        deps.bus.emit({ type: "run.error", runId, payload: { error: e.message ?? String(err) } });
        trace.write("turn.end", { status: "error", durationMs: now() - started, exitCode: null });
        trace.close();
        throw err;
      }

      // VOS-106 T10.B: persona injection. Read agent.md body at spawn time
      // and append it to CC's default system prompt via
      // `--append-system-prompt`. Without this the model never sees the
      // routing/voice/hard-rule instructions from agent.md — scope-gating
      // alone is not enough to make e.g. maya emit `ask_agent(...)`. We
      // tolerate missing/empty/malformed agent.md by skipping the flag and
      // tracing the reason so operators can distinguish "no persona" from
      // "persona broken".
      const persona = readAgentPersonaBody(req.cwd, req.agent);
      if (persona.reason === "truncated") {
        // VOS-106 T11.4: truncation is operationally distinct from "no
        // persona" — body still flows to CC, just capped at PERSONA_BODY_LIMIT.
        // Trace it separately so operators can tell "agent.md grew huge" from
        // "agent.md missing".
        trace.write("persona.truncated", {
          agent: req.agent,
          bytes: Buffer.byteLength(persona.body, "utf8"),
        });
      } else if (persona.reason !== "ok") {
        trace.write("persona.missing", { agent: req.agent, reason: persona.reason });
      }

      const args = [
        "-p", req.prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--strict-mcp-config",
        ...SETTING_SOURCES_ARGS,
        "--tools", ALLOWED_TOOLS.join(","),
        "--settings", settingsPath,
        "--mcp-config", mcpConfigPath,
        ...(persona.body ? ["--append-system-prompt", persona.body] : []),
        ...(req.resumeFrom ? ["--resume", req.resumeFrom] : []),
      ];
      const spawnFn = deps.spawnFn ?? Bun.spawn;
      let proc: Awaited<ReturnType<typeof Bun.spawn>>;
      try {
        proc = spawnFn([binary, ...args], {
          cwd: req.cwd,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: { ...(process.env as Record<string, string>), ...hookEnv },
        });
      } catch (err) {
        const e = err as { message?: string };
        deps.db.prepare(
          "UPDATE runs SET status='error', ended_at=?, error=? WHERE id=?",
        ).run(now(), e.message ?? String(err), runId);
        deps.bus.emit({ type: "run.error", runId, payload: { error: e.message ?? String(err) } });
        trace.write("turn.end", { status: "error", durationMs: now() - started, exitCode: null });
        trace.close();
        throw err;
      }

      // sessionId promise — resolves on first system event with session_id;
      // rejects (NoSessionError) if wait() resolves before capture.
      let sessionId: string | undefined;
      let resolveSid: ((id: string) => void) | undefined;
      let rejectSid:  ((err: Error) => void) | undefined;
      const sidPromise = new Promise<string>((res, rej) => { resolveSid = res; rejectSid = rej; });
      sidPromise.catch(() => {}); // swallow unhandled rejection if caller only awaits wait()

      const parser = createStreamParser({
        onEvent: (event) => {
          trace.write("cc.event", event);
          // VOS-84: synthesize tool.call / tool.result envelopes alongside
          // raw cc.event so downstream consumers (replay, audit) can read
          // tool pairing without re-parsing CC's nested block shape.
          for (const cls of classifyToolEvents(event)) {
            if (cls.kind === "tool.call") {
              trace.write("tool.call", { toolUseId: cls.toolUseId, name: cls.name, input: cls.input });
            } else {
              trace.write("tool.result", { toolUseId: cls.toolUseId, content: cls.content, isError: cls.isError });
            }
          }
          // VOS-87 T4: extract per-turn usage from `assistant` events
          // before the bus fan-out. Pure helper returns null when no
          // usage block is present (e.g. tool_use-only partials), so
          // the array only grows for accountable turns.
          const turn = parseUsageFromAssistantEvent(event);
          if (turn) usageTurns.push(turn);
          deps.bus.emit({
            type: "cc.event",
            runId,
            chatId: req.chatId,
            payload: { eventType: event.type, event },
          });
        },
        onNoise: (line) => {
          deps.bus.emit({
            type: "cc.stdout_noise",
            runId,
            payload: { preview: line.slice(0, 200) },
          });
        },
        onSession: (id) => {
          sessionId = id;
          deps.db.prepare("UPDATE runs SET session_id=? WHERE id=?").run(id, runId);
          deps.bus.emit({ type: "run.session", runId, chatId: req.chatId, payload: { sessionId: id } });
          resolveSid?.(id);
        },
        onWarning: (w) => {
          deps.bus.emit({ type: "cc.parser_warning", runId, payload: w });
        },
      });

      // Reader loops — stdout drives the parser, stderr is logged separately.
      const stdoutDone = (async () => {
        const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            parser.feed(Buffer.from(value));
          }
          parser.flush();
        } finally {
          reader.releaseLock();
        }
      })();

      const stderrDone = (async () => {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value).toString("utf8");
            trace.write("cc.stderr", { chunk });
            deps.bus.emit({ type: "cc.stderr", runId, payload: { chunk } });
          }
        } finally {
          reader.releaseLock();
        }
      })();

      // run.start *after* spawn succeeds.
      deps.bus.emit({
        type: "run.start",
        runId,
        chatId: req.chatId,
        payload: { agent: req.agent, resumeFrom: req.resumeFrom, pid: proc.pid },
      });

      // Watchdog.
      let timedOut = false;
      let killed = false;
      const wd = createWatchdog({
        now,
        outputTimeoutMs,
        toolTimeoutMs,
        firstEventTimeoutMs,
        startedAt: started,
        // Raw parser timestamp (0 until the first parsed event). The
        // watchdog itself handles the pre-first-event branch using
        // `startedAt` + `firstEventTimeoutMs` — no fallback collapse here.
        lastEventTs: () => parser.lastEventTs(),
        inToolCall: () => parser.inToolCall(),
        onTimeout: (info) => {
          timedOut = true;
          deps.bus.emit({
            type: "run.timeout",
            runId,
            payload: {
              lastEventType: parser.lastEventType(),
              idleMs: info.idleMs,
              threshold: info.threshold,
              // VOS-80 fix: surface which timeout phase fired so traces +
              // tests can tell a resume-hang ("first_event") apart from a
              // mid-stream stall ("output") or a stuck tool call ("tool").
              phase: info.phase,
            },
          });
          proc.kill("SIGTERM");
          setTimeout(() => {
            try {
              process.kill(proc.pid, 0);
              proc.kill("SIGKILL");
              deps.bus.emit({ type: "run.kill_escalated", runId, payload: {} });
            } catch { /* already gone */ }
          }, KILL_GRACE_MS);
        },
      });
      const wdHandle = setInterval(() => wd.tick(), tickMs);

      const finalize = async (reason: "exited" | "timeout" | "killed", exitCode: number) => {
        await stdoutDone;
        await stderrDone;
        clearInterval(wdHandle);
        const ended = now();
        // Map runtime reason → runs.status enum documented in 0001_init.sql
        // ("running" | "done" | "error" | "cancelled"). Granularity preserved
        // in kill_reason.
        const status =
          reason === "exited" ? "done" :
          reason === "timeout" ? "error" :
          /* killed */ "cancelled";
        // VOS-84: emit terminal trace envelope before closing the writer.
        // Status mirrors the SQLite runs.status value so trace replay and
        // SQLite agree on terminal disposition.
        trace.write("turn.end", { status, durationMs: ended - started, exitCode });
        trace.close();
        const killReason =
          reason === "timeout" ? "timeout" :
          reason === "killed"  ? "killed"  : null;
        deps.db.prepare(
          "UPDATE runs SET status=?, ended_at=?, exit_code=?, kill_reason=? WHERE id=?",
        ).run(status, ended, exitCode, killReason, runId);
        // VOS-87 T4: resolve task_id off the runs row (may be null for
        // chats without a parent task — orchestrator sets it during
        // dispatch). Carried on run.end so cost subscriber can stamp
        // costs.task_id per row.
        const taskRow = deps.db
          .prepare("SELECT task_id FROM runs WHERE id = ?")
          .get(runId) as { task_id: string | null } | undefined;
        const taskId = taskRow?.task_id ?? null;
        // VOS-87 T4: full RunEndPayload (agent, endedAt, usageTurns,
        // taskId) per events/index.ts. Legacy fields (exitCode,
        // durationMs, reason) kept additively so existing consumers
        // (status flips, e2e tests) keep working — additive payload
        // extension was chosen over a separate `run.usage` event to
        // avoid event-fan churn.
        deps.bus.emit({
          type: "run.end",
          runId,
          chatId: req.chatId,
          payload: {
            agent: req.agent,
            endedAt: ended,
            usageTurns,
            taskId,
            exitCode,
            durationMs: ended - started,
            reason,
          },
        });
        if (sessionId === undefined && rejectSid) {
          rejectSid(new NoSessionError(runId));
        }
      };

      const exitPromise = (async () => {
        const exitCode = await proc.exited;
        const reason: "exited" | "timeout" | "killed" =
          timedOut ? "timeout" : killed ? "killed" : "exited";
        await finalize(reason, exitCode);
        return { exitCode, sessionId, reason };
      })();

      const ccProc: CcProcess = {
        runId,
        pid: proc.pid,
        sessionId: () => sidPromise,
        async kill(opts?: KillOpts) {
          killed = true;
          // Fast-cancel: SIGINT (Ctrl-C semantics, CC aborts immediately),
          // 250ms grace, then SIGKILL. Default: SIGTERM, 5s grace, SIGKILL
          // (used by the watchdog where graceful drain is acceptable).
          // VOS-80 fix: CC traps SIGTERM and flushes the in-flight response
          // before exiting, so SIGTERM lets the entire reply finish even
          // though the user pressed ESC. SIGINT bypasses that handler.
          const initialSignal = opts?.fast ? "SIGINT" : "SIGTERM";
          const grace = opts?.fast ? FAST_KILL_GRACE_MS : KILL_GRACE_MS;
          proc.kill(initialSignal);
          const escalation = setTimeout(() => {
            try {
              process.kill(proc.pid, 0);          // alive?
              proc.kill("SIGKILL");
              deps.bus.emit({ type: "run.kill_escalated", runId, payload: {} });
            } catch { /* already gone */ }
          }, grace);
          try {
            await exitPromise;
          } finally {
            clearTimeout(escalation);
          }
        },
        wait: () => exitPromise,
      };
      return ccProc;
    },
  };
};

export { makeClaudeCodeProvider } from "./provider.ts";
export type { CcIter, MakeClaudeCodeProviderDeps } from "./provider.ts";

import { makeCcSpawnerIter } from "./spawner.ts";
import { makeClaudeCodeProvider } from "./provider.ts";
import type { Provider } from "../types.ts";

// Production factory: composes createCcSpawner + makeCcSpawnerIter into a Provider.
// Deps shape mirrors app.ts wiring — bus/db typed via Parameters<typeof createCcSpawner>[0].
export interface ClaudeCodeProviderDeps {
  bus: Parameters<typeof createCcSpawner>[0]["bus"];
  db: Parameters<typeof createCcSpawner>[0]["db"];
  tracesDir: string;
  agent: string;
  cwd: string;
  // VOS-106
  engine: PermissionEngine;
  daemonBase: string;
  hookScriptPath: string;
  loadAgentDefn: (name: string) => AgentDefn;
}

export function makeClaudeCodeProviderComposed(
  deps: ClaudeCodeProviderDeps,
): Provider {
  const cc = createCcSpawner({
    bus: deps.bus,
    db: deps.db,
    tracesDir: deps.tracesDir,
    engine: deps.engine,
    daemonBase: deps.daemonBase,
    hookScriptPath: deps.hookScriptPath,
    loadAgentDefn: deps.loadAgentDefn,
  });
  const iter = makeCcSpawnerIter({
    cc,
    bus: deps.bus,
    agent: deps.agent,
    cwd: deps.cwd,
  });
  return makeClaudeCodeProvider({ iter });
}
