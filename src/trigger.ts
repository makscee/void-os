// src/trigger.ts — Trigger file format: parse + validate. Pure, unit-testable.
// One responsibility: turn a Trigger file's text into a typed Trigger spec.
// Uses its own lightweight frontmatter parse since parseFrontmatter is SkillMeta-typed.
import { isValidCron } from "./cron.ts";

export type TriggerKind = "manual" | "schedule" | "event";

/** Default runaway step-ceiling for a trigger-fired Run when the file omits one. */
export const DEFAULT_STEP_CEILING = 50;

export interface TriggerSpec {
  name: string;          // = filename stem; the Trigger's stable id
  kind: TriggerKind;
  skill: string;         // bound Skill (slash-command name without leading /)
  agent: string;         // bound Agent label
  cronExpr: string | null; // schedule only
  inbox: string | null;    // event only
  eventKind: string | null; // event only — optional kind filter (ADR-0003 §8); null = match any
  stepCeiling: number;
}

const KINDS: ReadonlySet<string> = new Set(["manual", "schedule", "event"]);

/** Parse raw YAML frontmatter block into a string-keyed record. */
function parseFrontmatterRaw(text: string): Record<string, unknown> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const data: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([\w]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    const val = v.replace(/^["']|["']$/g, "").trim();
    // Coerce numeric-looking values
    const num = Number(val);
    if (val !== "" && !Number.isNaN(num)) {
      data[k] = num;
    } else {
      data[k] = val;
    }
  }
  return data;
}

/** Parse + validate a Trigger file. `name` is the filename stem. Throws on invalid spec. */
export function parseTrigger(name: string, text: string): TriggerSpec {
  const data = parseFrontmatterRaw(text);
  const kind = String(data.kind ?? "");
  if (!KINDS.has(kind)) {
    throw new Error(`trigger ${name}: unknown kind "${kind}" (expected manual|schedule|event)`);
  }
  const skill = String(data.skill ?? "");
  const agent = String(data.agent ?? "");
  if (!skill) throw new Error(`trigger ${name}: missing skill`);
  if (!agent) throw new Error(`trigger ${name}: missing agent`);

  let cronExpr: string | null = null;
  let inbox: string | null = null;

  if (kind === "schedule") {
    cronExpr = data.cron_expr != null ? String(data.cron_expr) : null;
    if (!cronExpr) throw new Error(`trigger ${name}: schedule kind requires cron_expr`);
    if (!isValidCron(cronExpr)) throw new Error(`trigger ${name}: invalid cron "${cronExpr}"`);
  }
  let eventKind: string | null = null;
  if (kind === "event") {
    inbox = data.inbox != null ? String(data.inbox) : null;
    if (!inbox) throw new Error(`trigger ${name}: event kind requires inbox`);
    eventKind = data.event_kind != null ? String(data.event_kind) : null;
  }

  const rawCeiling = data.step_ceiling;
  const stepCeiling =
    typeof rawCeiling === "number" && rawCeiling > 0 ? rawCeiling : DEFAULT_STEP_CEILING;

  return { name, kind: kind as TriggerKind, skill, agent, cronExpr, inbox, eventKind, stepCeiling };
}
