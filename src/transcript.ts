// transcript.ts — locate + parse + render the Claude Code JSONL transcript for a session.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
