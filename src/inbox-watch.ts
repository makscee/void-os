// src/inbox-watch.ts — drain event-inbox JSONL files, firing the bound event Trigger per new line.
// One responsibility: inbox tail → fire callback. Offset state is caller-owned (in-memory Map).
// PoC: offsets are in-memory; a restart re-reads from 0 (de-dup on restart is deferred).
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { listTriggers } from "./registry.ts";
import { inboxPath } from "./paths.ts";

/**
 * For every enabled event Trigger, read newly-appended lines from its inbox JSONL and
 * call `fire(triggerName, line)` once per non-blank line. `offsets` maps inbox name → bytes
 * already consumed (mutated in place). PoC: offsets are in-memory; a restart re-reads from 0.
 */
export function drainInbox(
  db: Database,
  vault: string,
  offsets: Map<string, number>,
  fire: (triggerName: string, input: string) => void,
): void {
  const eventTriggers = listTriggers(db).filter((t) => t.kind === "event" && t.enabled === 1 && t.inbox);
  for (const t of eventTriggers) {
    const inbox = t.inbox!;
    const path = inboxPath(vault, inbox);
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    const from = offsets.get(inbox) ?? 0;
    if (size <= from) { offsets.set(inbox, size); continue; }
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      const text = buf.toString("utf8");
      // Only consume up to the last newline so a partially-written line is re-read next tick.
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) continue; // no complete line yet
      const complete = text.slice(0, lastNl);
      for (const line of complete.split("\n")) {
        if (line.trim() === "") continue;
        fire(t.name, line);
      }
      // Advance offset by bytes consumed + the consumed newline.
      offsets.set(inbox, from + Buffer.byteLength(complete, "utf8") + 1);
    } finally {
      closeSync(fd);
    }
  }
}
