// src/inbox-watch.ts — drain event-inbox JSONL bus files, routing each line to the bound Trigger.
// One responsibility: inbox tail → parse → route → fire callback. Offset state is caller-owned.
// PoC: offsets are in-memory; a restart re-reads from 0 (de-dup on restart is deferred).
import { existsSync, statSync, openSync, readSync, closeSync, mkdirSync, writeFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { listTriggers } from "./registry.ts";
import { inboxPath, busDir, busLinePath } from "./paths.ts";
import { parseBusLine } from "./bus-line.ts";
import { routeBusLine, type RoutableTrigger } from "./bus-route.ts";

/**
 * For every enabled event Trigger, read newly-appended bus lines from its inbox JSONL and
 * call `fire(triggerName, payload, inputRef)` once per routed line.
 * - `payload` is the parsed BusLine.payload (clean text, not raw JSON).
 * - `inputRef` is the path to the per-line file persisted under .void-os/bus/.
 * Malformed or unroutable lines are logged and skipped (no crash).
 * `offsets` maps inbox name → bytes already consumed (mutated in place).
 */
export function drainInbox(
  db: Database,
  vault: string,
  offsets: Map<string, number>,
  fire: (triggerName: string, input: string, inputRef: string | null) => void,
): void {
  // Build the full set of routable event triggers once per drain call.
  const allEventTriggers: RoutableTrigger[] = listTriggers(db)
    .filter((t) => t.kind === "event" && t.enabled === 1 && t.inbox)
    .map((t) => ({
      name: t.name,
      inbox: t.inbox,
      kind: t.event_kind ?? null,
      skill: t.skill,
      agent: t.agent,
      enabled: t.enabled,
    }));

  // Collect distinct inbox names to drain (each inbox is read once, not once-per-trigger).
  const inboxNames = new Set(allEventTriggers.map((t) => t.inbox as string));

  for (const inbox of inboxNames) {
    const path = inboxPath(vault, inbox);
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    const from = offsets.get(inbox) ?? 0;
    if (size <= from) { offsets.set(inbox, size); continue; }
    const fd = openSync(path, "r");
    let complete: string;
    let consumed: number;
    try {
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      const text = buf.toString("utf8");
      // Only consume up to the last newline so a partially-written line is re-read next tick.
      const lastNl = text.lastIndexOf("\n");
      if (lastNl === -1) continue; // no complete line yet
      complete = text.slice(0, lastNl);
      consumed = Buffer.byteLength(complete, "utf8") + 1; // +1 for the consumed newline
    } finally {
      closeSync(fd);
    }

    for (const raw of complete.split("\n")) {
      if (raw.trim() === "") continue;
      // Parse the bus line — skip malformed lines.
      let parsed;
      try {
        parsed = parseBusLine(raw);
      } catch (e) {
        console.error(`[bus] skipping malformed line on inbox "${inbox}": ${(e as Error).message}`);
        continue;
      }
      // Route by kind — skip unroutable lines.
      const route = routeBusLine(parsed, inbox, allEventTriggers);
      if (!route) {
        console.error(`[bus] no trigger for kind="${parsed.kind}" on inbox="${inbox}"; skipping`);
        continue;
      }
      // Persist the parsed line as a per-line input-ref file (files-first).
      mkdirSync(busDir(vault), { recursive: true });
      const refPath = busLinePath(vault, parsed.id);
      writeFileSync(refPath, JSON.stringify(parsed) + "\n");
      fire(route.triggerName, parsed.payload, refPath);
    }

    // Advance offset by bytes consumed (after processing all lines).
    offsets.set(inbox, from + consumed);
  }
}
