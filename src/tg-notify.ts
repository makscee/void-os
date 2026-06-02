// tg-notify.ts — THIN Telegram surface STUB (PoC). ADR-0003 §9 requires a pending Decision be
// surfaced on all channels (web + Telegram). The web surface is the dashboard (Task 4). This is
// the Telegram side: a stub that records the notification to <vault>/.void-os/tg-outbox.jsonl
// + logs it — NO real Telegram client. Same deferred-adapter posture as VOS-192's reference
// adapters.
//
// SEAM — real TG adapter (deferred): replace the file-append below with a Telegram Bot API
// sendMessage call (token + chat_id from config). The inbound reply side already exists: an
// operator replies via the VOS-192 bus with channel="tg", kind="decision-reply" (a future TG
// receiver appends that bus line); no change to this file is needed for the inbound path.
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { tgOutboxPath } from "./paths.ts";
import type { Decision } from "./decision.ts";

export function notifyDecision(vault: string, d: Decision): void {
  const text = `Decision ${d.id}: ${d.question}` +
    (d.options.length ? ` — options: ${d.options.join(" / ")}` : "") +
    ` (reply via bus: kind=decision-reply, routing.decisionRef=${d.id})`;
  const line = { channel: "tg-stub", decisionId: d.id, text, at: Date.now() };
  const path = tgOutboxPath(vault);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + "\n");
  console.log(`[tg-stub] ${text}`);
}
