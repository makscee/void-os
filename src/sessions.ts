// sessions.ts — list executions sorted by body.html mtime (VOS-190)
// Stateless: run state derived from executions table (ended_at / reason).
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { sessionsRoot, sessionDir, bodyPath, errorPath, stopPath, reapedPath, lastOpenedPath } from "./paths.ts";
import { getExecution, type ExecutionRow } from "./registry.ts";
import { attachCommand } from "./tmux.ts";

/** Status derived from filesystem markers + exec row — 6-state model (VOS-208). */
export type SessionStatus = "stopped" | "error" | "reaped" | "awaiting" | "working" | "complete";

/** Execution status derived from executions row (ended_at / reason). */
export type ExecStatus = "running" | "failed" | "complete";

export interface SessionInfo {
  uuid: string;
  title: string;
  mtimeMs: number;
  /** Timestamp of last activity (message sent, body.html updated, or session started). */
  lastActivityMs: number;
  /** True when the session was updated since the operator last opened it. */
  needsAttention: boolean;
  /** True when session is working but has had no new activity for >2 min (VOS-219). */
  idle: boolean;
  error: boolean;
  status: SessionStatus;
  skill: string;
  execStatus?: ExecStatus;  // execution status from registry (undefined when no execution exists)
  attach?: string;          // `tmux attach -t vos-run-<id>` (undefined when no execution exists)
}

/** Threshold: a working session with no activity for this long is considered idle (VOS-219). */
export const IDLE_MS = 120_000;

/**
 * True when a working session has had no activity for longer than IDLE_MS.
 * Only applies to "working" status — awaiting/stopped/etc are never idle in this sense.
 */
export function isIdle(status: SessionStatus, lastActivityMs: number, now: number): boolean {
  return status === "working" && (now - lastActivityMs) > IDLE_MS;
}

function extractTitle(html: string): string {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? m[1] : "";
}

/**
 * Derive status from filesystem markers + exec row by strict precedence (VOS-208).
 * stopped > error(error.txt|reason) > reaped(marker|ended+stranded-form) > awaiting(live+form) > working(live) > complete.
 * reaped.txt is gated on !liveExec so a resumed session (fresh live exec) is never stuck reaped.
 */
function deriveStatus(vault: string, uuid: string, html: string, exec: ExecutionRow | null): SessionStatus {
  if (existsSync(stopPath(vault, uuid))) return "stopped";
  if (existsSync(errorPath(vault, uuid)) || (exec != null && exec.reason != null)) return "error";
  const liveExec = exec != null && exec.ended_at == null;
  const ended = exec != null && exec.ended_at != null;
  const hasForm = html.includes("<form");
  // reaped: only when exec is not live (gate prevents resumed sessions being stuck reaped)
  if (!liveExec && (existsSync(reapedPath(vault, uuid)) || (ended && hasForm))) return "reaped";
  if (hasForm && !ended) return "awaiting";
  if (liveExec) return "working";
  return "complete";
}

/** Export for use in the /status route so SSE and dashboard always agree. */
export function statusFor(vault: string, uuid: string, html: string, db?: import("bun:sqlite").Database): SessionStatus {
  const exec = db ? getExecution(db, uuid) : null;
  return deriveStatus(vault, uuid, html, exec);
}

const GENERIC_TITLES = new Set(["session starting…", "working…", "void-os", ""]);

/**
 * Read the last-activity timestamp for a session.
 * Priority (mirrors reaper.ts readLastActivity):
 *  1. last-activity.txt mtime — written by /message route on each send-keys delivery.
 *  2. body.html mtime — updated whenever the REPL outputs; proxy for headless sessions.
 *  3. fallback: 0.
 */
function sessionLastActivity(vault: string, uuid: string, bodyMtimeMs: number): number {
  const dir = sessionDir(vault, uuid);
  const stamp = join(dir, "last-activity.txt");
  if (existsSync(stamp)) {
    try { return statSync(stamp).mtimeMs; } catch { /* fallthrough */ }
  }
  return bodyMtimeMs;
}

export function listSessions(vault: string, db?: Database): SessionInfo[] {
  const root = sessionsRoot(vault);
  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true });
  const sessions: SessionInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const uuid = entry.name;
    const body = bodyPath(vault, uuid);
    if (!existsSync(body)) continue;

    const stat = statSync(body);
    const html = readFileSync(body, "utf8");

    // Read skill name from session-meta.json if present
    let skill = "";
    const metaPath = join(sessionDir(vault, uuid), "session-meta.json");
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { skill?: string };
        skill = meta.skill ?? "";
      } catch {
        // ignore malformed meta
      }
    }

    const rawTitle = extractTitle(html);
    // Fallback title: if generic loading phrase, use skill name + short date
    const isGenericTitle = GENERIC_TITLES.has(rawTitle);
    const title = isGenericTitle && skill
      ? `${skill} — ${new Date(stat.mtimeMs).toLocaleDateString()}`
      : rawTitle || (skill ? skill : uuid.slice(0, 8));

    // Registry-derived execution status + attach command (VOS-190: executions table).
    let execStatus: ExecStatus | undefined;
    let attach: string | undefined;
    const exec = db ? getExecution(db, uuid) : null;
    if (exec) {
      execStatus = exec.ended_at == null ? "running" : exec.reason ? "failed" : "complete";
      attach = attachCommand(exec.tmux_session);
    }

    const lastActivityMs = sessionLastActivity(vault, uuid, stat.mtimeMs);

    // needsAttention: body was updated AFTER last-opened.txt was written (or last-opened.txt absent)
    let needsAttention = false;
    const loPath = lastOpenedPath(vault, uuid);
    if (existsSync(loPath)) {
      try {
        const loMtime = statSync(loPath).mtimeMs;
        needsAttention = lastActivityMs > loMtime;
      } catch { /* ignore */ }
    } else {
      // Never opened: attention only if session has completed output (not a fresh placeholder)
      needsAttention = stat.mtimeMs > 0 && !html.includes("session starting…");
    }

    const status = deriveStatus(vault, uuid, html, exec);
    sessions.push({
      uuid,
      title,
      mtimeMs: stat.mtimeMs,
      lastActivityMs,
      needsAttention,
      idle: isIdle(status, lastActivityMs, Date.now()),
      error: existsSync(errorPath(vault, uuid)),
      status,
      skill,
      execStatus,
      attach,
    });
  }

  // Sort newest first by body.html mtime
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
