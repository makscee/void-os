// src/chat.ts — chat-as-file semantics (ADR-0003 §4). A chat thread is a markdown
// history file at <vault>/chat/<thread>.md. Pure + filesystem helpers only — no spawn,
// no DB. The file IS the chat agent's memory; the executions row stays rebuildable.
import { existsSync, mkdirSync, appendFileSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { chatThreadPath } from "./paths.ts";

export interface ChatEvent { thread: string; text: string; at: number; }

/**
 * Parse a kind:"chat" inbound-bus JSONL line into a ChatEvent, or null if not a valid chat line.
 * Bus line format: {channel: "file"|"tg"|"web", kind: "chat", payload: "<text>",
 *                   routing: {thread: "<id>"}, ...}
 * Falls back to legacy format: {kind: "chat", thread: "<id>", text: "<text>", at: <ms>}
 */
export function parseChatEvent(line: string): ChatEvent | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (o.kind !== "chat") return null;

  // Bus format: payload + routing.thread
  const routing = (o.routing ?? {}) as Record<string, unknown>;
  const busThread = typeof routing.thread === "string" ? routing.thread : "";
  const busText = typeof o.payload === "string" ? o.payload : "";

  // Legacy format: thread + text fields (plan-spec compat + test compat)
  const legacyThread = typeof o.thread === "string" ? o.thread : "";
  const legacyText = typeof o.text === "string" ? o.text : "";

  const thread = busThread || legacyThread;
  const text = busText || legacyText;

  if (!thread || !text) return null;
  const at = typeof o.at === "number" ? o.at : (typeof o.ts === "number" ? o.ts : Date.now());
  return { thread, text, at };
}

function ensureDir(path: string): void { mkdirSync(dirname(path), { recursive: true }); }

/** Append a user turn to the thread history file (creates it if absent). */
export function appendUserMessage(vault: string, thread: string, text: string, at: number): void {
  const path = chatThreadPath(vault, thread);
  ensureDir(path);
  appendFileSync(path, `\n## user (${new Date(at).toISOString()})\n\n${text}\n`);
}

/** Append an assistant reply to the thread history file. */
export function appendReply(vault: string, thread: string, text: string, at: number): void {
  const path = chatThreadPath(vault, thread);
  ensureDir(path);
  appendFileSync(path, `\n## assistant (${new Date(at).toISOString()})\n\n${text}\n`);
}

/** Read the full running transcript of a thread; "" if no file yet. */
export function readTranscript(vault: string, thread: string): string {
  const path = chatThreadPath(vault, thread);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Cold-context budget observability: file size in bytes + a rough token estimate (~bytes/4). */
export function chatColdContext(vault: string, thread: string): { bytes: number; tokenEstimate: number } {
  const path = chatThreadPath(vault, thread);
  if (!existsSync(path)) return { bytes: 0, tokenEstimate: 0 };
  const bytes = statSync(path).size;
  return { bytes, tokenEstimate: Math.ceil(bytes / 4) };
}

/**
 * Pre-spawn hook for a chat bus line: deposit the user's turn into the thread history
 * file and return the input_ref (= the thread file path) for the chat execution.
 * Returns null if the line is not a chat event (caller falls through to other handlers).
 *
 * In the live daemon flow, `line` may be the already-decoded payload string (from drainInbox)
 * rather than raw JSON. In that case this returns null and the caller uses the thread file
 * path derived from reading the inputRef file (the persisted BusLine).
 */
export function chatPreSpawn(vault: string, line: string): { thread: string; inputRef: string } | null {
  const ev = parseChatEvent(line);
  if (!ev) return null;
  appendUserMessage(vault, ev.thread, ev.text, ev.at);
  return { thread: ev.thread, inputRef: chatThreadPath(vault, ev.thread) };
}
