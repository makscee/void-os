// sessions.ts — list sessions sorted by body.html mtime (Task 5)
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { sessionsRoot, sessionDir, bodyPath, errorPath } from "./paths.ts";

export interface SessionInfo {
  uuid: string;
  title: string;
  mtimeMs: number;
  error: boolean;
}

function extractTitle(html: string): string {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  return m ? m[1] : "";
}

export function listSessions(vault: string): SessionInfo[] {
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
    const errFile = errorPath(vault, uuid);

    sessions.push({
      uuid,
      title: extractTitle(html),
      mtimeMs: stat.mtimeMs,
      error: existsSync(errFile),
    });
  }

  // Sort newest first by body.html mtime
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
