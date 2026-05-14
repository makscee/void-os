// CC spawner. Invokes `claudev claude ...` subprocess.
// T5: full wire-up — Bun.spawn + parser + watchdog + runs/events writes.

import type { Database } from "bun:sqlite";
import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventBus } from "../../events/index.js";
import { createStreamParser } from "./parser.js";
import { createWatchdog } from "./watchdog.js";

export interface CcSpawnRequest {
  prompt: string;
  agent: string;
  cwd: string;
  chatId?: string;
  kind?: "chat" | "skill" | "worker";
  resumeFrom?: string;
  outputTimeoutMs?: number;
  toolTimeoutMs?: number;
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

/**
 * Probe claudev by invoking `claudev claude --version`.
 * Returns structured result. Handles ENOENT (claudev not on PATH) gracefully.
 */
export const probeClaudev = async (
  binary = "claudev",
): Promise<ProbeResult> => {
  let proc: Awaited<ReturnType<typeof Bun.spawn>>;
  try {
    proc = Bun.spawn({
      cmd: [binary, "claude", "--version"],
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return {
      ok: false,
      error: e.code === "ENOENT" ? "claudev not found on PATH" : (e.message ?? String(err)),
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
}

export const createCcSpawner = (deps: CcSpawnerDeps): CcSpawner => {
  mkdirSync(deps.tracesDir, { recursive: true });
  const binary = deps.binary ?? "claudev";
  const tickMs = deps.watchdogTickMs ?? DEFAULT_WATCHDOG_TICK_MS;
  const now = deps.now ?? (() => Date.now());

  return {
    async spawn(req) {
      const runId = randomUUID();
      const started = now();
      const outputTimeoutMs = req.outputTimeoutMs ?? DEFAULT_OUTPUT_TIMEOUT_MS;
      const toolTimeoutMs   = req.toolTimeoutMs   ?? DEFAULT_TOOL_TIMEOUT_MS;

      const tracePath = join(deps.tracesDir, `${runId}.jsonl`);
      const traceStream = createWriteStream(tracePath, { flags: "a" });

      // Insert runs row up-front so 'running' is visible.
      deps.db.prepare(
        "INSERT INTO runs (id, chat_id, agent, kind, status, started_at, trace_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(runId, req.chatId ?? null, req.agent, req.kind ?? "chat", "running", started, tracePath);

      const args = [
        "-p", req.prompt,
        "--output-format", "stream-json",
        "--verbose",
        ...(req.resumeFrom ? ["--resume", req.resumeFrom] : []),
      ];
      let proc: Awaited<ReturnType<typeof Bun.spawn>>;
      try {
        proc = Bun.spawn([binary, ...args], {
          cwd: req.cwd,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          env: process.env as Record<string, string>,
        });
      } catch (err) {
        const e = err as { message?: string };
        deps.db.prepare(
          "UPDATE runs SET status='error', ended_at=?, error=? WHERE id=?",
        ).run(now(), e.message ?? String(err), runId);
        deps.bus.emit({ type: "run.error", runId, payload: { error: e.message ?? String(err) } });
        traceStream.end();
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
          traceStream.write(JSON.stringify(event) + "\n");
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
            traceStream.write(JSON.stringify({ _origin: "stderr", chunk }) + "\n");
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
        lastEventTs: () => parser.lastEventTs() || started,
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
        traceStream.end();
        clearInterval(wdHandle);
        const ended = now();
        // Map runtime reason → runs.status enum documented in 0001_init.sql
        // ("running" | "done" | "error" | "cancelled"). Granularity preserved
        // in kill_reason.
        const status =
          reason === "exited" ? "done" :
          reason === "timeout" ? "error" :
          /* killed */ "cancelled";
        const killReason =
          reason === "timeout" ? "timeout" :
          reason === "killed"  ? "killed"  : null;
        deps.db.prepare(
          "UPDATE runs SET status=?, ended_at=?, exit_code=?, kill_reason=? WHERE id=?",
        ).run(status, ended, exitCode, killReason, runId);
        deps.bus.emit({
          type: "run.end",
          runId,
          chatId: req.chatId,
          payload: { exitCode, durationMs: ended - started, reason },
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
