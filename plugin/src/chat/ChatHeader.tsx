// VOS-153 T7: Chat header banner for the Active pane.
//
// Surfaces agent identity (avatar, name, description) at the top of an
// active chat. Mirrors the DraftLabel pill visually (color-mix tint
// keyed off --agent-color from agent.md frontmatter) but spans the full
// pane width and sits sticky-top within the scroll container.
//
// Contract preserved from the T5 inline placeholder it replaces:
//   - data-testid="chat-header"
//   - data-agent={agent.name}
// Existing/future e2e specs select on these attributes.
import * as React from "react";
import type { AgentListEntry } from "@voidos/protocol";

export function ChatHeader({ agent }: { agent: AgentListEntry }) {
  const color = agent.color || "var(--text-muted)";
  const avatar = agent.avatar || "●";
  return (
    <div
      className="void-os-chat-header"
      data-testid="chat-header"
      data-agent={agent.name}
      style={{ ["--agent-color" as unknown as string]: color }}
    >
      <span className="void-os-chat-header-avatar" aria-hidden>
        {avatar}
      </span>
      <strong className="void-os-chat-header-name">{agent.name}</strong>
      {agent.description && (
        <>
          <span className="void-os-chat-header-sep">·</span>
          <span className="void-os-chat-header-desc">{agent.description}</span>
        </>
      )}
    </div>
  );
}
