// ActivityList.tsx — VOS-172 global activity list.
//
// An always-on overview of the agent tree: every Task across every Context,
// sorted by last activity (the daemon's `GET /tasks` route already returns
// them activity-DESC). Each row shows the Task's agent, an A2A-state dot,
// a one-line preview of the most recent message, and a relative timestamp.
// Clicking a row opens that Task — `onOpenTask(item)` — which the parent
// resolves to the Task's owning Context in the timeline pane.
//
// Design mirrors ChatList:
//   - Stateless about the active Task; the parent owns selection.
//   - `refreshKey` bump re-fetches.
//   - Polling fallback while any row is non-terminal (the agent tree is
//     live; a missed event frame should not leave the list stale).
//   - A one-minute tick keeps relative timestamps honest.

import * as React from "react";
import type { ChatApi, TaskActivityItem } from "./api";
import { AgentBadge } from "./AgentBadge";
import { formatRelativeTime } from "./util/format-relative-time";

export interface ActivityListProps {
  api: ChatApi;
  /** The Task id currently open in the timeline pane, if any. */
  activeTaskId: string | null;
  /** Row click — the parent opens this Task in the timeline pane. */
  onOpenTask: (item: TaskActivityItem) => void;
  /** Bumping this triggers a re-fetch of /tasks. */
  refreshKey?: number;
}

/** Poll interval while any non-terminal Task is present. Matches ChatList. */
const POLL_MS = 3000;
const PREVIEW_MAX = 80;

/** A2A terminal states — a Task in one of these has finished. Mirrors the
 *  daemon's TERMINAL_TASK_STATES; duplicated here so the plugin bundle does
 *  not import daemon code. */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

/** Map an A2A task state to a short status label + a colour token. */
function stateMeta(state: string): { label: string; color: string } {
  switch (state) {
    case "TASK_STATE_WORKING":
      return { label: "working", color: "var(--interactive-accent)" };
    case "TASK_STATE_INPUT_REQUIRED":
      return { label: "input", color: "var(--text-warning, #d8a657)" };
    case "TASK_STATE_WAITING_ON_AGENT":
      return { label: "waiting", color: "var(--text-warning, #d8a657)" };
    case "TASK_STATE_COMPLETED":
      return { label: "done", color: "var(--text-success, #5ac46a)" };
    case "TASK_STATE_FAILED":
      return { label: "failed", color: "var(--text-error, #e35a5a)" };
    case "TASK_STATE_CANCELED":
      return { label: "canceled", color: "var(--text-muted)" };
    case "TASK_STATE_REJECTED":
      return { label: "rejected", color: "var(--text-error, #e35a5a)" };
    default:
      return { label: "submitted", color: "var(--text-muted)" };
  }
}

/** One-line activity preview: the most recent message, else the Context
 *  title, else a fallback. Whitespace-collapsed + truncated. */
function oneLiner(item: TaskActivityItem): string {
  const raw = item.last_msg ?? item.context_title ?? "";
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return "(no activity yet)";
  if (cleaned.length <= PREVIEW_MAX) return cleaned;
  return cleaned.slice(0, PREVIEW_MAX - 1) + "…";
}

export function ActivityList(props: ActivityListProps) {
  const { api, activeTaskId, onOpenTask, refreshKey } = props;
  const [tasks, setTasks] = React.useState<TaskActivityItem[]>([]);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listTasks()
      .then((rows) => {
        if (!cancelled) {
          setTasks(rows);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, refreshKey]);

  // Polling fallback while the tree is live. Stops once every row is
  // terminal (a frozen tree needs no polling).
  const anyLive = tasks.some((t) => !TERMINAL_STATES.has(t.state));
  React.useEffect(() => {
    if (!anyLive) return;
    let cancelled = false;
    const id = setInterval(() => {
      api
        .listTasks()
        .then((rows) => {
          if (!cancelled) setTasks(rows);
        })
        .catch(() => {
          /* swallow: refreshKey path drives the loading/error UI */
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [api, anyLive]);

  // Keep relative timestamps honest.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <aside
      className="vos:flex vos:flex-col vos:flex-1 vos:min-h-0 vos:w-full vos:border-r vos:border-[var(--background-modifier-border)] vos:bg-[var(--background-secondary)]"
      data-testid="activity-list"
    >
      <div className="vos:flex vos:items-center vos:px-[var(--size-4-3)] vos:h-9 vos:border-b vos:border-[var(--background-modifier-border)]">
        <span className="vos:text-[11px] vos:uppercase vos:tracking-wider vos:text-[var(--text-muted)] vos:font-normal vos:leading-none">
          Activity
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
            data-testid="activity-list-error"
            className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:text-xs vos:text-[var(--text-error,#e35a5a)]"
          >
            {error}
          </div>
        )}
        {!loading && !error && tasks.length === 0 && (
          <div
            data-testid="activity-list-empty"
            className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:text-xs vos:text-[var(--text-muted)]"
          >
            No activity yet
          </div>
        )}
        {!loading &&
          tasks.map((t) => {
            const active = t.id === activeTaskId;
            const meta = stateMeta(t.state);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onOpenTask(t)}
                data-testid={`activity-row-${t.id}`}
                data-task-id={t.id}
                data-context-id={t.context_id}
                data-state={t.state}
                data-active={active ? "true" : "false"}
                className={
                  "void-os-activity-row vos:w-full vos:text-left vos:pl-[10px] vos:pr-[var(--size-4-2)] vos:py-[var(--size-4-2)] vos:min-h-[44px] vos:flex vos:flex-col vos:gap-[2px] vos:rounded-[var(--radius-s)] " +
                  (active
                    ? "vos:bg-[var(--background-modifier-active-hover)]"
                    : "hover:vos:bg-[var(--background-modifier-hover)]")
                }
              >
                {/* Row 1: state dot + one-line activity preview. */}
                <span className="vos:flex vos:items-center vos:gap-[var(--size-4-2)] vos:w-full vos:min-w-0">
                  <span
                    aria-hidden
                    data-testid="activity-row-status"
                    data-state={t.state}
                    className="vos:inline-block vos:w-1.5 vos:h-1.5 vos:rounded-full vos:shrink-0"
                    style={{ backgroundColor: meta.color }}
                  />
                  <span
                    data-testid="activity-row-line"
                    className={
                      "vos:flex-1 vos:min-w-0 vos:block vos:text-[13px] vos:leading-[1.4] vos:truncate " +
                      (active
                        ? "vos:text-[var(--text-normal)]"
                        : "vos:text-[var(--text-muted)]")
                    }
                  >
                    {oneLiner(t)}
                  </span>
                </span>
                {/* Row 2: agent badge + state label + relative time. */}
                <span
                  data-testid="activity-row-sub"
                  className="vos:flex vos:items-center vos:gap-[6px] vos:w-full vos:pl-[14px] vos:min-w-0"
                >
                  <AgentBadge agent={t.agent ?? ""} />
                  <span
                    data-testid="activity-row-state"
                    className="vos:text-[11px] vos:text-[var(--text-muted)] vos:shrink-0"
                  >
                    {meta.label}
                  </span>
                  <span className="vos:text-[11px] vos:text-[var(--text-muted)]">
                    ·
                  </span>
                  <span
                    data-testid="activity-row-time"
                    className="vos:text-[11px] vos:text-[var(--text-muted)] vos:truncate"
                  >
                    {formatRelativeTime(t.last_event ?? t.updated_at ?? t.created_at)}
                  </span>
                </span>
              </button>
            );
          })}
      </div>
    </aside>
  );
}
