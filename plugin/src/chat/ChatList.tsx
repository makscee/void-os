// ChatList.tsx — left rail with chats (recent-first) + "New chat".
//
// Design:
//   - Stateless about which chat is active in the runtime; it just calls
//     `onSelect(id)` and `onNewChat()`. The parent owns chatId.
//   - Title fallback: when daemon `title` is null (titler offline), preview
//     a truncated `last_msg`.
//   - Truly empty chats (no title, no last_msg, never run) are filtered out
//     so a stale "+ New" click doesn't pollute the rail.
//   - Status: a single dot (StatusDot) per row folds input_required
//     and last_run_status into one indicator with precedence
//     input_required > error > running > cancelled > idle. Replaces
//     the VOS-104 input-required-dot + trailing chip pair.
//   - Refresh: parent passes a `refreshKey` that changes whenever a new
//     chat is minted or a run finishes; we re-fetch on changes. Simpler
//     than wiring the bus through here.
//   - Polling safety-net: when any row reports last_run_status="running"
//     we poll listChats every POLL_MS as a fallback for dropped/late
//     run.end frames (WS reconnect edge, debounce trailing-edge races).
//     Stops as soon as no row is running. Cheap (one GET / 3s).

import * as React from "react";
import type { ChatApi, ChatSummary } from "./api";
import type { AgentListEntry } from "@voidos/protocol";
import { formatTokens } from "./format-tokens";
import { StatusDot } from "./StatusDot";
import { AgentBadge } from "./AgentBadge";
import { formatRelativeTime } from "./util/format-relative-time";

export interface ChatListProps {
  api: ChatApi;
  activeChatId: string | null;
  onSelect: (id: string, agent: string) => void;
  onNewChat: () => void | Promise<void>;
  /** Bumping this triggers a re-fetch of /chats. */
  refreshKey?: number;
  /**
   * VOS-153 T8: per-row name → AgentListEntry lookup source. ChatRoot
   * keeps this cache (its own GET /agents) and threads it down so we
   * can render an agent-coloured stripe + emoji per row without an
   * extra fetch here. Optional + defaults to empty so older callers
   * keep working (rows fall back to muted stripe + bullet glyph).
   */
  agents?: AgentListEntry[];
}

/** Polling interval while any chat row reports running. Picked to be slow
 *  enough to be free (one GET / interval) but fast enough that a stuck dot
 *  resolves within a couple seconds at worst. */
const POLL_MS = 3000;

const PREVIEW_MAX = 80;

function preview(s: ChatSummary): string {
  const raw = s.title ?? s.last_msg ?? "";
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New chat";
  if (cleaned.length <= PREVIEW_MAX) return cleaned;
  return cleaned.slice(0, PREVIEW_MAX - 1) + "…";
}

/** Hide rows with no readable content. A chat with a `done` run but blank
 *  last_msg (e.g. spawn produced no text) is still useless to display. */
function isEmpty(s: ChatSummary): boolean {
  const t = (s.title ?? "").trim();
  const m = (s.last_msg ?? "").trim();
  return !t && !m;
}


export function ChatList(props: ChatListProps) {
  const { api, activeChatId, onSelect, onNewChat, refreshKey } = props;
  const agents = props.agents ?? [];
  const [chats, setChats] = React.useState<ChatSummary[]>([]);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.listChats()
      .then((rows) => { if (!cancelled) { setChats(rows); setLoading(false); } })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [api, refreshKey]);

  // Polling fallback: while any chat row reads as "running", re-fetch on
  // POLL_MS interval. Guards against missed run.end frames (WS drop /
  // debounce trailing-edge races) leaving the sidebar dot stuck pulsing.
  // Stops as soon as the next fetch returns no running rows.
  const anyRunning = chats.some((c) => c.last_run_status === "running");
  React.useEffect(() => {
    if (!anyRunning) return;
    let cancelled = false;
    const id = setInterval(() => {
      api.listChats()
        .then((rows) => { if (!cancelled) setChats(rows); })
        .catch(() => { /* swallow: next tick retries; loading/error UI
                          is driven by the refreshKey path, not polling. */ });
    }, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [api, anyRunning]);

  // VOS-114: keep relative timestamps honest. One setState/min while
  // mounted — cheap. Independent of the running-row poller.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const visible = chats.filter((c) => !isEmpty(c));

  return (
    <aside
      className="vos:flex vos:flex-col vos:flex-1 vos:min-h-0 vos:w-full vos:border-r vos:border-[var(--background-modifier-border)] vos:bg-[var(--background-secondary)]"
      data-testid="chat-list"
    >
      <div className="vos:flex vos:items-center vos:justify-between vos:px-[var(--size-4-3)] vos:h-9 vos:border-b vos:border-[var(--background-modifier-border)]">
        <span className="vos:text-[11px] vos:uppercase vos:tracking-wider vos:text-[var(--text-muted)] vos:font-normal vos:leading-none">
          Chats
        </span>
        <button
          type="button"
          onClick={() => { void onNewChat(); }}
          className="vos:inline-flex vos:items-center vos:h-6 vos:px-[var(--size-4-2)] vos:rounded-[var(--radius-s)] vos:text-[11px] vos:leading-none vos:text-[var(--text-muted)] vos:bg-transparent vos:border vos:border-[var(--background-modifier-border)] hover:vos:bg-[var(--background-modifier-hover)] hover:vos:text-[var(--text-normal)]"
          data-testid="new-chat-btn"
        >
          + New
        </button>
      </div>
      <div className="vos:flex-1 vos:overflow-y-auto vos:flex vos:flex-col vos:gap-[2px] vos:py-[var(--size-4-2)] vos:px-[var(--size-4-1)]">
        {loading && (
          <div className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:text-xs vos:text-[var(--text-muted)]">loading…</div>
        )}
        {error && !loading && (
          <div className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:text-xs vos:text-[var(--text-error,#e35a5a)]">
            {error}
          </div>
        )}
        {!loading && !error && visible.length === 0 && (
          <div className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:text-xs vos:text-[var(--text-muted)]">
            No chats yet — click + New
          </div>
        )}
        {!loading && visible.map((c) => {
          const active = c.id === activeChatId;
          // VOS-153 T8: per-row agent metadata lookup. The lookup is
          // O(N) but `agents` is the daemon's full agent list (typically
          // single-digit length), so this is fine. Fallbacks keep the
          // row legible if the agent vanished from disk or the cache
          // is still loading.
          const agentEntry = agents.find((a) => a.name === c.agent);
          const color = agentEntry?.color || "var(--text-muted)";
          const avatar = agentEntry?.avatar || "●";
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id, c.agent)}
              data-testid={`chat-row-${c.id}`}
              data-chat-id={c.id}
              data-agent={c.agent}
              data-active={active ? "true" : "false"}
              style={{ ["--agent-color" as unknown as string]: color }}
              className={
                "void-os-chat-row vos:w-full vos:text-left vos:pl-[10px] vos:pr-[var(--size-4-2)] vos:py-[var(--size-4-2)] vos:min-h-[44px] vos:flex vos:flex-row vos:items-stretch vos:gap-[var(--size-4-2)] vos:rounded-[var(--radius-s)] " +
                (active
                  ? "vos:bg-[var(--background-modifier-active-hover)]"
                  : "hover:vos:bg-[var(--background-modifier-hover)]")
              }
            >
              {/* Agent colour stripe — pulled from agent.md frontmatter
                  via the parent's agents cache. Falls back to muted. */}
              <span
                className="void-os-chat-stripe"
                aria-hidden
                data-testid="chat-row-stripe"
              />
              {/* Agent emoji avatar. Falls back to a bullet when the
                  agent omits `avatar` in its frontmatter. */}
              <span
                className="void-os-chat-emoji"
                aria-hidden
                data-testid="chat-row-emoji"
              >
                {avatar}
              </span>
              <span className="vos:flex vos:flex-col vos:gap-[2px] vos:flex-1 vos:min-w-0">
                {/* Row 1: status dot + title (title takes full remaining width). */}
                <span className="vos:flex vos:items-center vos:gap-[var(--size-4-2)] vos:w-full vos:min-w-0">
                  <StatusDot
                    input_required={c.input_required}
                    last_run_status={c.last_run_status}
                  />
                  <span
                    data-testid="chat-row-title"
                    className={
                      "void-os-chat-title vos:flex-1 vos:min-w-0 vos:block vos:text-[13px] vos:leading-[1.4] vos:truncate " +
                      (active ? "vos:text-[var(--text-normal)]" : "vos:text-[var(--text-muted)]")
                    }
                  >
                    {preview(c)}
                  </span>
                </span>

                {/* Row 2: agent badge + relative time on the left, tokens on the right.
                    pl-[14px] aligns under the title (dot ~6px + gap ~8px). */}
                <span
                  data-testid="chat-row-sub"
                  className="void-os-chat-sub vos:flex vos:items-center vos:justify-between vos:w-full vos:pl-[14px]"
                >
                  <span className="vos:flex vos:items-center vos:gap-[6px] vos:min-w-0">
                    <AgentBadge agent={c.agent} />
                    <span
                      data-testid="chat-row-time"
                      className="vos:text-[11px] vos:text-[var(--text-muted)] vos:truncate"
                    >
                      {formatRelativeTime(c.updated_at)}
                    </span>
                  </span>
                  <span
                    data-testid="context-cell"
                    className="vos:inline-block vos:min-w-[3.5rem] vos:text-right vos:text-[11px] vos:text-[var(--text-muted)] vos:tabular-nums vos:shrink-0"
                  >
                    {formatTokens(c.context_tokens)}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
