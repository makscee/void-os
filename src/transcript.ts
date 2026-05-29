// transcript.ts — locate + parse + render the Claude Code JSONL transcript for a session.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { esc } from "./render.ts";

const UUID_RE = /^[0-9a-f-]{36}$/;

/**
 * Locate a session's JSONL transcript by uuid. fs-only (no shell), uuid-guarded.
 * @param uuid session uuid to search for
 * @param projectsDir defaults to ~/.claude/projects; injectable for tests
 * @returns absolute path to the first matching <uuid>.jsonl, or null
 */
export function locateTranscript(
  uuid: string,
  projectsDir: string = join(homedir(), ".claude", "projects"),
): string | null {
  if (!UUID_RE.test(uuid)) return null;
  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const sub of entries) {
    const p = join(projectsDir, sub, `${uuid}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Parse a Claude Code JSONL transcript into a flat list of user/assistant turns.
 * Deliberately dumb: per-line try/catch, text-only extraction, everything else skipped.
 */
export function parseTranscript(jsonl: string): Turn[] {
  const turns: Turn[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type !== "user" && o?.type !== "assistant") continue;
    const content = o.message?.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("");
    }
    text = text.trim();
    if (!text) continue;
    turns.push({ role: o.type, text });
  }
  return turns;
}

/** Render turns as an escaped HTML fragment (no surrounding document). */
export function renderTranscript(turns: Turn[]): string {
  return turns
    .map((t) => {
      const label = t.role === "user" ? "you:" : "claude:";
      return `<div class="turn role-${t.role}"><span class="who">${label}</span>${esc(t.text)}</div>`;
    })
    .join("");
}
