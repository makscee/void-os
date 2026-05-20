// VOS-160: InspectorRoot — the live in-flight-agent inspector surface.
//
// Covers VOS-155 acceptance bullets 1/2/5/6:
//   1. lists every in-flight agent from GET /agents/inflight
//   2. click a row → step-by-step trace (the agent's AgentEvent history)
//   5. auto-refreshes at <=2s cadence (POLL_MS below)
//   6. exercised end-to-end by inspector-view.spec.ts
//
// Design:
//   - Stateless about the daemon connection; the parent passes an
//     InflightApi. The component owns only the poll timer + UI state.
//   - Poll, not stream: see inflight-api.ts for why SSE is unusable from
//     the Obsidian renderer. POLL_MS = 1500ms keeps the worst-case
//     staleness under the 2s bar even with a slow round-trip.
//   - Errors (daemon offline / 401) collapse to an "offline" banner; the
//     last good snapshot is kept on screen so a transient blip doesn't
//     blank the view.
//   - Selecting a row expands its trace inline. The selection is by
//     agent_id; if that agent leaves the snapshot the expansion closes.

import * as React from "react";
import type { InflightApi } from "./inflight-api";
import type { AgentEvent, InflightAgent } from "./inflight-types";

/** Poll cadence. Must stay <= 2000ms (VOS-155 acceptance bullet 5). */
export const POLL_MS = 1500;

export interface InspectorRootProps {
  inflightApi: InflightApi;
  /** Override the poll interval (tests use a short value). */
  pollMs?: number;
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function TraceRow(props: { ev: AgentEvent }) {
  const { ev } = props;
  return (
    <li
      data-testid="inspector-trace-event"
      data-kind={ev.kind}
      className="vos:flex vos:gap-[var(--size-4-2)] vos:items-baseline vos:py-[2px] vos:text-xs"
    >
      <span
        className="vos:shrink-0 vos:uppercase vos:tracking-wider vos:text-[10px] vos:text-[var(--text-muted)] vos:w-[68px]"
      >
        {ev.kind}
      </span>
      <span className="vos:flex-1 vos:text-[var(--text-normal)] vos:break-words">
        {ev.summary}
      </span>
      <span className="vos:shrink-0 vos:text-[10px] vos:text-[var(--text-faint)]">
        {relTime(ev.ts)}
      </span>
    </li>
  );
}

export function InspectorRoot(props: InspectorRootProps) {
  const { inflightApi } = props;
  const pollMs = props.pollMs ?? POLL_MS;

  const [agents, setAgents] = React.useState<InflightAgent[]>([]);
  const [offline, setOffline] = React.useState<boolean>(false);
  // null = nothing loaded yet (first tick pending).
  const [loaded, setLoaded] = React.useState<boolean>(false);
  const [selected, setSelected] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const rows = await inflightApi.getInflight();
        if (cancelled) return;
        setAgents(rows);
        setOffline(false);
      } catch {
        if (cancelled) return;
        // Keep the last good snapshot on screen — only flag offline.
        setOffline(true);
      } finally {
        if (!cancelled) {
          setLoaded(true);
          timer = setTimeout(tick, pollMs);
        }
      }
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [inflightApi, pollMs]);

  // Close an expansion whose agent has left the snapshot.
  React.useEffect(() => {
    if (selected && !agents.some((a) => a.agent_id === selected)) {
      setSelected(null);
    }
  }, [agents, selected]);

  return (
    <div
      data-testid="vos-inspector-root"
      className="vos:flex vos:flex-col vos:h-full vos:min-h-0 vos:bg-[var(--background-primary)]"
    >
      <div className="vos:flex vos:items-center vos:gap-[var(--size-4-2)] vos:px-[var(--size-4-3)] vos:h-9 vos:border-b vos:border-[var(--background-modifier-border)] vos:shrink-0">
        <span className="vos:text-[11px] vos:uppercase vos:tracking-wider vos:text-[var(--text-muted)]">
          In-flight agents
        </span>
        {offline && (
          <span
            data-testid="inspector-offline"
            className="vos:text-[10px] vos:text-[var(--text-error,#e35a5a)]"
          >
            daemon offline — showing last snapshot
          </span>
        )}
      </div>

      <div className="vos:flex-1 vos:overflow-y-auto vos:py-[var(--size-4-2)]">
        {loaded && agents.length === 0 && (
          <div
            data-testid="inspector-empty"
            className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:text-xs vos:text-[var(--text-muted)]"
          >
            No agents in flight. Dispatch a task to see live activity here.
          </div>
        )}

        {agents.map((a) => {
          const expanded = a.agent_id === selected;
          return (
            <div key={a.agent_id} className="vos:flex vos:flex-col">
              <button
                type="button"
                data-testid="inspector-agent-row"
                data-agent-id={a.agent_id}
                data-expanded={expanded ? "true" : "false"}
                data-ended={a.ended ? "true" : "false"}
                onClick={() => setSelected(expanded ? null : a.agent_id)}
                className={
                  "vos:flex vos:flex-col vos:items-stretch vos:gap-[2px] " +
                  "vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:text-left " +
                  "vos:border-l-2 vos:cursor-pointer " +
                  "vos:bg-transparent vos:hover:bg-[var(--background-modifier-hover)] " +
                  (expanded
                    ? "vos:border-[var(--interactive-accent)]"
                    : "vos:border-transparent")
                }
              >
                <span className="vos:flex vos:items-baseline vos:gap-[var(--size-4-2)]">
                  <span
                    data-testid="inspector-agent-task"
                    className="vos:font-semibold vos:text-[var(--text-normal)] vos:text-sm"
                  >
                    {a.task_id}
                  </span>
                  <span
                    data-testid="inspector-agent-phase"
                    className="vos:text-[10px] vos:uppercase vos:tracking-wider vos:text-[var(--text-muted)]"
                  >
                    {a.ended ? "ended" : a.current_phase}
                  </span>
                  <span className="vos:ml-auto vos:text-[10px] vos:text-[var(--text-faint)]">
                    {relTime(a.started_at)}
                  </span>
                </span>
                <span
                  data-testid="inspector-agent-action"
                  className="vos:text-xs vos:text-[var(--text-muted)] vos:break-words"
                >
                  {a.last_action}
                </span>
              </button>

              {expanded && (
                <ul
                  data-testid="inspector-trace"
                  data-agent-id={a.agent_id}
                  className="vos:flex vos:flex-col vos:px-[var(--size-4-4)] vos:pb-[var(--size-4-2)] vos:border-l-2 vos:border-[var(--interactive-accent)]"
                >
                  {a.trace.length === 0 && (
                    <li className="vos:text-xs vos:text-[var(--text-faint)] vos:py-[2px]">
                      no events recorded yet
                    </li>
                  )}
                  {a.trace.map((ev, i) => (
                    <TraceRow key={`${a.agent_id}-${i}`} ev={ev} />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
