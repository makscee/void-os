// decision.ts — the single drainable decisions file (ADR-0003 §9). One append/drainable JSONL
// at <vault>/.void-os/decisions.jsonl; same JSONL discipline as the inbound bus. A Decision is a
// parked-action record; "draining" marks it resolved (append-rewrite of the matching line) — the
// pending list is every line whose state is still "pending". Files-first: this file IS the store.
import { mkdirSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { decisionsFilePath } from "./paths.ts";

export type DecisionState = "pending" | "resolved";

export interface Decision {
  id: string;             // dl-<uuid>
  question: string;
  options: string[];      // offered options; operator may pick one OR free-text a reply
  originExecId: string;   // the execution that emitted this Decision
  context: string;        // free-text context for the operator
  state: DecisionState;
  reply: string | null;   // the operator's answer once drained
  createdAt: number;
  resolvedAt: number | null;
}

/** Parse + validate one decisions.jsonl line. Throws on invalid input. */
export function parseDecision(line: string): Decision {
  let d: Record<string, unknown>;
  try { d = JSON.parse(line) as Record<string, unknown>; }
  catch { throw new Error(`decision: not valid JSON: ${line.slice(0, 80)}`); }
  if (typeof d.id !== "string" || !d.id) throw new Error("decision: missing id");
  if (typeof d.question !== "string" || !d.question) throw new Error("decision: missing question");
  const options = Array.isArray(d.options) ? d.options.filter((o): o is string => typeof o === "string") : [];
  const state = d.state === "resolved" ? "resolved" : "pending";
  return {
    id: d.id, question: d.question, options,
    originExecId: typeof d.originExecId === "string" ? d.originExecId : "",
    context: typeof d.context === "string" ? d.context : "",
    state,
    reply: typeof d.reply === "string" ? d.reply : null,
    createdAt: typeof d.createdAt === "number" ? d.createdAt : 0,
    resolvedAt: typeof d.resolvedAt === "number" ? d.resolvedAt : null,
  };
}

/** Append a new pending Decision to the decisions file. Returns the created record. */
export function appendDecision(
  vault: string,
  a: { question: string; options: string[]; originExecId: string; context: string; now: number },
): Decision {
  const d: Decision = {
    id: `dl-${randomUUID()}`, question: a.question, options: a.options,
    originExecId: a.originExecId, context: a.context, state: "pending",
    reply: null, createdAt: a.now, resolvedAt: null,
  };
  const path = decisionsFilePath(vault);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(d) + "\n");
  return d;
}

/** Read all decisions (every line). */
export function listDecisions(vault: string): Decision[] {
  const path = decisionsFilePath(vault);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map(parseDecision);
}

/** Pending decisions = the latest state per id is "pending". */
export function listPendingDecisions(vault: string): Decision[] {
  const byId = new Map<string, Decision>();
  for (const d of listDecisions(vault)) byId.set(d.id, d); // last line per id wins
  return [...byId.values()].filter((d) => d.state === "pending");
}

/** Mark a decision resolved by appending an updated line (append-only audit; last line wins).
 *  No-op if id unknown among pending. */
export function drainDecision(vault: string, id: string, a: { reply: string; now: number }): void {
  const byId = new Map<string, Decision>();
  for (const d of listDecisions(vault)) byId.set(d.id, d);
  const current = byId.get(id);
  if (!current || current.state === "resolved") return;
  const resolved: Decision = { ...current, state: "resolved", reply: a.reply, resolvedAt: a.now };
  const path = decisionsFilePath(vault);
  appendFileSync(path, JSON.stringify(resolved) + "\n");
}
