// sessions.ts — list executions sorted by body.html mtime (VOS-190)
// Stateless: run state derived from executions table (ended_at / reason).
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { sessionsRoot, sessionDir, bodyPath, errorPath, stopPath } from "./paths.ts";
import { getExecution } from "./registry.ts";
import { attachCommand } from "./tmux.ts";

/** Status derived purely from filesystem state — no process lookup needed. */
export type SessionStatus = "error" | "stopped" | "awaiting" | "complete";

/** Execution status derived from executions row (ended_at / reason). */
export type ExecStatus = "running" | "failed" | "complete";

export interface SessionInfo {
  uuid: string;
  title: string;
  mtimeMs: number;
  error: boolean;
  status: SessionStatus;
  skill: string;
  execStatus?: ExecStatus;  // execution status from registry (undefined when no execution exists)
  attach?: string;          // `tmux attach -t vos-run-<id>` (undefined when no execution exists)
}

function extractTitle(html: string): string {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? m[1] : "";
}

/** Derive status from filesystem: stopped.txt → stopped; error.txt → error; body has <form → awaiting; else complete. */
function deriveStatus(vault: string, uuid: string, html: string): SessionStatus {
  if (existsSync(stopPath(vault, uuid))) return "stopped";
  if (existsSync(errorPath(vault, uuid))) return "error";
  if (html.includes("<form")) return "awaiting";
  return "complete";
}

const GENERIC_TITLES = new Set(["session starting…", "working…", "void-os", ""]);

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
    if (db) {
      const exec = getExecution(db, uuid);
      if (exec) {
        execStatus = exec.ended_at == null ? "running" : exec.reason ? "failed" : "complete";
        attach = attachCommand(exec.tmux_session);
      }
    }

    sessions.push({
      uuid,
      title,
      mtimeMs: stat.mtimeMs,
      error: existsSync(errorPath(vault, uuid)),
      status: deriveStatus(vault, uuid, html),
      skill,
      execStatus,
      attach,
    });
  }

  // Sort newest first by body.html mtime
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
