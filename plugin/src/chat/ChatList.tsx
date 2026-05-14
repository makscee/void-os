// ChatList.tsx — left rail with chats (recent-first) + "New chat".
//
// Design:
//   - Stateless about which chat is active in the runtime; it just calls
//     `onSelect(id)` and `onNewChat()`. The parent owns chatId.
//   - Title fallback: when daemon `title` is null (titler offline), preview
//     a truncated `last_msg`.
//   - Truly empty chats (no title, no last_msg, never run) are filtered out
//     so a stale "+ New" click doesn't pollute the rail.
//   - Run-status: a tiny chip on the right edge, only when last_run_status
//     is interesting (running / error). `done` is the boring default and
//     gets no marker. The status span is always rendered (with data-status)
//     so tests can introspect it.
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

/** Color for the run-status chip. Returns null for statuses we don't show. */
function chipColor(status: string | null): string | null {
  switch (status) {
    case "running": return "var(--interactive-accent)";
    case "error":   return "var(--text-error, #e35a5a)";
    default:        return null; // done / cancelled / null → no chip
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

  const visible = chats.filter((c) => !isEmpty(c));

  return (
    <aside
      className="vos:flex vos:flex-col vos:h-full vos:w-[260px] vos:shrink-0 vos:border-r vos:border-[var(--background-modifier-border)] vos:bg-[var(--background-secondary)]"
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
          const chip = chipColor(c.last_run_status);
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              data-testid="chat-row"
              data-chat-id={c.id}
              data-active={active ? "true" : "false"}
              className={
                "vos:w-full vos:text-left vos:pl-[10px] vos:pr-[var(--size-4-2)] vos:py-[var(--size-4-2)] vos:min-h-[34px] vos:flex vos:items-center vos:gap-[var(--size-4-2)] vos:rounded-[var(--radius-s)] vos:border-l-2 " +
                (active
                  ? "vos:border-[var(--interactive-accent)] vos:bg-[var(--background-modifier-active-hover)]"
                  : "vos:border-transparent hover:vos:bg-[var(--background-modifier-hover)]")
              }
            >
              <span className="vos:flex-1 vos:min-w-0">
                <span
                  className={
                    "vos:block vos:text-[13px] vos:leading-[1.4] vos:truncate " +
                    (active ? "vos:text-[var(--text-normal)]" : "vos:text-[var(--text-muted)]")
                  }
                >
                  {preview(c)}
                </span>
              </span>
              <span
                aria-hidden
                data-status={c.last_run_status ?? "none"}
                className={
                  "vos:inline-block vos:w-1.5 vos:h-1.5 vos:rounded-full vos:shrink-0 " +
                  (c.last_run_status === "running" ? "vos-run-dot" : "")
                }
                style={{ backgroundColor: chip ?? "transparent" }}
              />
            </button>
          );
        })}
      </div>
    </aside>
  );
}
