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

/** Event kind for a single turn block (VOS-219: tagged transcript for filter support). */
export type TurnKind = "text" | "thinking" | "tool_use" | "tool_result" | "meta";

/** A single rendered turn block — one per content block (not one per JSONL line). */
export interface Turn {
  role: "user" | "assistant" | "system";
  kind: TurnKind;
  text: string;
}

/** Meta event types emitted by the Claude Code harness (not user/assistant content). */
const META_TYPES = new Set([
  "system", "attachment", "file-history-snapshot", "mode",
  "permission-mode", "agent-name", "queue-operation", "last-prompt", "ai-title",
]);

/**
 * Parse a Claude Code JSONL transcript into tagged turn blocks.
 * Emits one Turn per content block (not one per JSONL line) so filters have data to act on.
 * Per-line try/catch + skip-on-parse-error discipline preserved.
 * VOS-219: expanded from text-only to full event taxonomy (chat/tool/thinking/meta).
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
    const type = o?.type;
    if (!type) continue;

    // Meta events (harness bookkeeping)
    if (META_TYPES.has(type)) {
      const text = typeof o.content === "string" ? o.content : JSON.stringify(o.content ?? o);
      turns.push({ role: "system", kind: "meta", text: `[${type}] ${text}`.trim() });
      continue;
    }

    if (type !== "user" && type !== "assistant") continue;
    const role = type as "user" | "assistant";
    const content = o.message?.content;

    if (typeof content === "string") {
      const t = content.trim();
      if (t) turns.push({ role, kind: "text", text: t });
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") {
        const t = b.text.trim();
        if (t) turns.push({ role, kind: "text", text: t });
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        const t = b.thinking.trim();
        if (t) turns.push({ role, kind: "thinking", text: t });
      } else if (b.type === "tool_use") {
        const summary = `${b.name ?? "tool"} ${JSON.stringify(b.input ?? {})}`.slice(0, 2000);
        turns.push({ role, kind: "tool_use", text: summary });
      } else if (b.type === "tool_result") {
        const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        turns.push({ role, kind: "tool_result", text: c.slice(0, 4000) });
      }
    }
  }
  return turns;
}

/** Render tagged turns as an escaped HTML fragment (no surrounding document).
 * Each turn carries data-kind and data-role attributes for client-side filter JS (VOS-219).
 */
export function renderTranscript(turns: Turn[]): string {
  return turns
    .map((t) => {
      const label = t.kind === "thinking" ? "thinking:"
        : t.kind === "tool_use" ? "tool →"
        : t.kind === "tool_result" ? "tool ←"
        : t.kind === "meta" ? "·"
        : t.role === "user" ? "you:" : "claude:";
      return `<div class="turn role-${t.role} kind-${t.kind}" data-role="${t.role}" data-kind="${t.kind}"><span class="who">${label}</span>${esc(t.text)}</div>`;
    })
    .join("");
}
