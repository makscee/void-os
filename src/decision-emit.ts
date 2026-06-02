// decision-emit.ts — "emit + park" (ADR-0003 §9, stateless). A Consequential action does NOT
// block in-thread: it appends a Decision to the decisions file AND writes a resumption-intent
// file (what to do once the operator answers), then the emitting execution simply STOPS.
// No held session — the emitting execution's clean SessionEnd is the "park" (VOS-191 reuse:
// the resumption-intent file is declared as the emitting skill's output_target, so the Stop
// hook confirms it was written before allowing the stop).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { appendDecision, type Decision } from "./decision.ts";
import { resumptionIntentPath } from "./paths.ts";
import { notifyDecision } from "./tg-notify.ts";

/** What a continuation execution needs to resume the parked work once a reply arrives. */
export interface ResumptionIntent {
  decisionId: string;     // the Decision this intent is parked behind
  originExecId: string;   // the execution that emitted the Decision
  resumeSkill: string;    // skill to run on resume (the continuation skill)
  resumeAgent: string;    // agent to run it as
  resumePayload: string;  // the parked work context ("what to do once answered")
  createdAt: number;
}

/** Append a Decision + write the resumption-intent file. The caller (the emitting CC session)
 *  then stops cleanly — that clean exit IS the park. Returns the decision + intent path. */
export function emitDecisionAndPark(
  vault: string,
  a: { execId: string; question: string; options: string[]; context: string;
       resumeSkill: string; resumeAgent: string; resumePayload: string; now: number },
): { decision: Decision; intentPath: string } {
  const decision = appendDecision(vault, {
    question: a.question, options: a.options, originExecId: a.execId,
    context: a.context, now: a.now,
  });
  const intent: ResumptionIntent = {
    decisionId: decision.id, originExecId: a.execId,
    resumeSkill: a.resumeSkill, resumeAgent: a.resumeAgent,
    resumePayload: a.resumePayload, createdAt: a.now,
  };
  // Key by decisionId (not execId) so a single execution emitting multiple decisions
  // (e.g. skill-author submitting 2+ drafts) never clobbers earlier intent files.
  const intentPath = resumptionIntentPath(vault, decision.id);
  mkdirSync(dirname(intentPath), { recursive: true });
  writeFileSync(intentPath, JSON.stringify(intent) + "\n");
  notifyDecision(vault, decision); // surface on the TG channel (stub; seam for real adapter)
  return { decision, intentPath };
}

/** Read a resumption-intent file by decisionId. Throws if absent. */
export function readResumptionIntent(vault: string, decisionId: string): ResumptionIntent {
  const path = resumptionIntentPath(vault, decisionId);
  if (!existsSync(path)) throw new Error(`resumption intent not found for decision ${decisionId}: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as ResumptionIntent;
}
