// src/bus-line.ts — the inbound-bus line format: parse + validate. Pure, unit-testable.
// One responsibility: turn one JSONL bus line into a typed BusLine (ADR-0003 §8).
import { randomUUID } from "node:crypto";

export type BusChannel = "file" | "tg" | "web";
/** BusKind is open/extensible: the 4 built-in kinds + any custom kind authored by a skill.
 *  Routability (no matching trigger) is determined by routeBusLine, not at parse time. */
export type BusKind = string;

/** Routing hints. `skill`/`agent` override the trigger's bound pair (rare); decision-reply
 *  carries refs to the parked Decision + origin Execution it answers (consumer is VOS-194).
 *  `thread` names the chat thread history file for kind="chat" lines (VOS-193). */
export interface BusRouting {
  skill?: string;
  agent?: string;
  decisionRef?: string;
  execRef?: string;
  thread?: string;
}

export interface BusLine {
  channel: BusChannel;
  kind: BusKind;
  payload: string;      // the human/agent text this line carries
  routing: BusRouting;  // {} when unspecified
  id: string;           // stable line id (bl-<uuid> when absent)
  ts: number;           // arrival epoch ms
  raw: string;          // the original JSON line (provenance)
}

const CHANNELS: ReadonlySet<string> = new Set(["file", "tg", "web"]);

/** Parse + validate one bus line. `now` seeds a default ts. Throws on invalid input.
 *  Kind is open-ended: any non-empty string is accepted; routeBusLine is the sole gate
 *  for routability (it returns null + logs "no trigger for kind" for unmatched kinds). */
export function parseBusLine(line: string, now: number = Date.now()): BusLine {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`bus line: not valid JSON: ${line.slice(0, 80)}`);
  }
  const channel = String(data.channel ?? "");
  if (!CHANNELS.has(channel)) throw new Error(`bus line: unknown channel "${channel}" (expected file|tg|web)`);
  const kind = String(data.kind ?? "");
  if (!kind) throw new Error(`bus line: missing or empty kind`);
  if (typeof data.payload !== "string" || data.payload.length === 0) {
    throw new Error(`bus line: missing or empty payload`);
  }
  const routingRaw = (data.routing ?? {}) as Record<string, unknown>;
  const routing: BusRouting = {};
  for (const k of ["skill", "agent", "decisionRef", "execRef", "thread"] as const) {
    if (typeof routingRaw[k] === "string") routing[k] = routingRaw[k] as string;
  }
  const id = typeof data.id === "string" && data.id ? data.id : `bl-${randomUUID()}`;
  const ts = typeof data.ts === "number" ? data.ts : now;
  return { channel: channel as BusChannel, kind, payload: data.payload, routing, id, ts, raw: line };
}
