// src/bus-route.ts — route a parsed BusLine to the event-Trigger that should drain it (ADR-0003 §8).
// One responsibility: (line, sourceInbox, triggers) → target trigger + effective skill/agent. Pure.
import type { BusLine } from "./bus-line.ts";

export interface RoutableTrigger {
  name: string;
  inbox: string | null;
  kind: string | null;   // event-trigger's declared kind filter; null = match any kind
  skill: string;
  agent: string;
  enabled: number;       // 1|0
}

export interface RouteResult {
  triggerName: string;
  skill: string;  // line.routing.skill overrides the trigger's skill
  agent: string;  // line.routing.agent overrides the trigger's agent
}

/** Pick the enabled event-Trigger bound to `sourceInbox` whose kind matches `line.kind`
 *  (a kindless trigger matches any kind). Line routing.skill/agent override. null if none. */
export function routeBusLine(line: BusLine, sourceInbox: string, triggers: RoutableTrigger[]): RouteResult | null {
  const candidates = triggers.filter(
    (t) => t.enabled === 1 && t.inbox === sourceInbox && (t.kind == null || t.kind === line.kind),
  );
  // Prefer an exact-kind match over a kindless catch-all.
  candidates.sort((a, b) => {
    const aExact = a.kind === line.kind ? 1 : 0;
    const bExact = b.kind === line.kind ? 1 : 0;
    return bExact - aExact;
  });
  const t = candidates[0];
  if (!t) return null;
  return { triggerName: t.name, skill: line.routing.skill ?? t.skill, agent: line.routing.agent ?? t.agent };
}
