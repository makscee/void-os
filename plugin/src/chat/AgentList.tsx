// AgentList.tsx — left-rail segment showing installed agents with an
// active-agent marker.
//
// Design:
//   - Stateless about which agent is "active"; the parent passes
//     `activeAgent` (derived from the current chat's agent field).
//   - Click → onPickAgent(name). Parent mints a new chat with that agent
//     and updates activeAgent optimistically.
//   - Refresh: parent passes a `refreshKey`. Bumping it re-fetches
//     /agents. No internal polling — agents change only on vault
//     rescan, which is out of scope for v1.
//   - Empty / error / loading states render in place of the rows
//     (header stays visible so the segment doesn't collapse).

import * as React from "react";
import type { AgentsApi } from "../agents/api";
import type { AgentListEntry } from "../agents/types";

export interface AgentListProps {
  agentsApi: Pick<AgentsApi, "listAgents">;
  activeAgent: string | null;
  onPickAgent: (name: string) => void | Promise<void>;
  /** Bumping this triggers a re-fetch of /agents. */
  refreshKey?: number;
}

export function AgentList(props: AgentListProps) {
  const { agentsApi, activeAgent, onPickAgent, refreshKey } = props;
  const [agents, setAgents] = React.useState<AgentListEntry[]>([]);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    agentsApi.listAgents()
      .then((rows) => {
        if (cancelled) return;
        setAgents(rows);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("daemon offline");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [agentsApi, refreshKey]);

  const sorted = React.useMemo(() => {
    return [...agents].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }, [agents]);

  return (
    <aside
      className="vos:flex vos:flex-col vos:shrink-0 vos:max-h-[40%] vos:w-full vos:border-b vos:border-[var(--background-modifier-border)] vos:bg-[var(--background-secondary)]"
      data-testid="agent-list"
      aria-labelledby="vos-agents-heading"
    >
      <div className="vos:flex vos:items-center vos:px-[var(--size-4-3)] vos:h-9 vos:border-b vos:border-[var(--background-modifier-border)]">
        <span id="vos-agents-heading" className="vos:text-[11px] vos:uppercase vos:tracking-wider vos:text-[var(--text-muted)] vos:font-normal vos:leading-none">
          Agents
        </span>
      </div>
      <div className="vos:flex-1 vos:overflow-y-auto vos:flex vos:flex-col vos:gap-[2px] vos:py-[var(--size-4-2)] vos:px-[var(--size-4-1)]">
        {loading && (
          <div className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:text-xs vos:text-[var(--text-muted)]">
            loading…
          </div>
        )}
        {error && !loading && (
          <div
            data-testid="agent-list-error"
            className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:text-xs vos:text-[var(--text-error,#e35a5a)]"
          >
            {error}
          </div>
        )}
        {!loading && !error && sorted.length === 0 && (
          <div className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:text-xs vos:text-[var(--text-muted)]">
            No agents in vault/agents/
          </div>
        )}
        {!loading && !error && sorted.map((a) => {
          const active = a.name === activeAgent;
          return (
            <button
              key={a.name}
              type="button"
              title={a.description || undefined}
              onClick={() => { void onPickAgent(a.name); }}
              data-testid="agent-row"
              data-agent-name={a.name}
              data-active={active ? "true" : "false"}
              className={
                "vos:w-full vos:text-left vos:pl-[10px] vos:pr-[var(--size-4-2)] vos:py-[var(--size-4-2)] vos:min-h-[28px] vos:flex vos:items-center vos:rounded-[var(--radius-s)] vos:border-l-2 " +
                (active
                  ? "vos:border-[var(--interactive-accent)] vos:bg-[var(--background-modifier-active-hover)]"
                  : "vos:border-transparent hover:vos:bg-[var(--background-modifier-hover)]")
              }
            >
              <span
                data-testid="agent-name"
                className={
                  "vos:flex-1 vos:min-w-0 vos:text-[13px] vos:leading-[1.4] vos:truncate " +
                  (active
                    ? "vos:text-[var(--text-normal)] vos:font-semibold"
                    : "vos:text-[var(--text-muted)]")
                }
              >
                {a.name}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
