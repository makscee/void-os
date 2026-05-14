// ChatList.tsx — left rail with chats (recent-first) + "New chat".
//
// Design:
//   - Stateless about which chat is active in the runtime; it just calls
//     `onSelect(id)` and `onNewChat()`. The parent owns chatId.
//   - Title fallback: when daemon `title` is null (titler offline), preview
//     a truncated `last_msg`.
//   - Run-status badge: a tiny dot whose color reflects last_run_status.
//   - Refresh: parent passes a `refreshKey` that changes whenever a new
//     chat is minted or a run finishes; we re-fetch on changes. Simpler
//     than wiring the bus through here.

import * as React from "react";
import type { ChatApi, ChatSummary } from "./api";

export interface ChatListProps {
  api: ChatApi;
  activeChatId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void | Promise<void>;
  /** Bumping this triggers a re-fetch of /chats. */
  refreshKey?: number;
}

const PREVIEW_MAX = 60;

function preview(s: ChatSummary): string {
  const raw = s.title ?? s.last_msg ?? "";
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return "(empty chat)";
  if (cleaned.length <= PREVIEW_MAX) return cleaned;
  return cleaned.slice(0, PREVIEW_MAX - 1) + "…";
}

function badgeColor(status: string | null): string {
  switch (status) {
    case "running": return "var(--interactive-accent)";
    case "error":   return "var(--text-error, #e35a5a)";
    case "done":    return "var(--text-faint, #888)";
    case "cancelled": return "var(--text-muted)";
    default:        return "transparent";
  }
}

export function ChatList(props: ChatListProps) {
  const { api, activeChatId, onSelect, onNewChat, refreshKey } = props;
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

  return (
    <aside
      className="vos:flex vos:flex-col vos:h-full vos:w-[260px] vos:shrink-0 vos:border-r vos:border-[var(--background-modifier-border)] vos:bg-[var(--background-secondary)]"
      data-testid="chat-list"
    >
      <div className="vos:flex vos:items-center vos:justify-between vos:px-3 vos:py-2 vos:border-b vos:border-[var(--background-modifier-border)]">
        <span className="vos:text-[11px] vos:uppercase vos:tracking-wider vos:text-[var(--text-muted)]">
          chats
        </span>
        <button
          type="button"
          onClick={() => { void onNewChat(); }}
          className="vos:px-2 vos:py-0.5 vos:rounded vos:text-xs vos:bg-[var(--interactive-accent)] vos:text-[var(--text-on-accent)] vos:border vos:border-transparent hover:vos:opacity-90"
          data-testid="new-chat-btn"
        >
          + New
        </button>
      </div>
      <div className="vos:flex-1 vos:overflow-y-auto">
        {loading && (
          <div className="vos:p-3 vos:text-xs vos:text-[var(--text-muted)]">loading…</div>
        )}
        {error && !loading && (
          <div className="vos:p-3 vos:text-xs vos:text-[var(--text-error,#e35a5a)]">
            {error}
          </div>
        )}
        {!loading && !error && chats.length === 0 && (
          <div className="vos:p-3 vos:text-xs vos:text-[var(--text-muted)]">
            no chats yet
          </div>
        )}
        {!loading && chats.map((c) => {
          const active = c.id === activeChatId;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              data-testid="chat-row"
              data-chat-id={c.id}
              className={
                "vos:w-full vos:text-left vos:px-3 vos:py-2 vos:flex vos:items-start vos:gap-2 vos:border-b vos:border-[var(--background-modifier-border)] " +
                (active
                  ? "vos:bg-[var(--background-modifier-hover)]"
                  : "hover:vos:bg-[var(--background-modifier-hover)]")
              }
            >
              <span
                aria-hidden
                className={
                  "vos:mt-1.5 vos:inline-block vos:w-2 vos:h-2 vos:rounded-full vos:shrink-0 " +
                  (c.last_run_status === "running" ? "vos-run-dot" : "")
                }
                style={{ backgroundColor: badgeColor(c.last_run_status) }}
                data-status={c.last_run_status ?? "none"}
              />
              <span className="vos:flex-1 vos:min-w-0">
                <span className="vos:block vos:text-sm vos:text-[var(--text-normal)] vos:truncate">
                  {preview(c)}
                </span>
                <span className="vos:block vos:text-[11px] vos:text-[var(--text-muted)]">
                  {c.agent}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
