// VOS-153 T5: pre-send "Starting chat with <agent>" pill rendered in the
// Draft pane. Uses the agent's optional color/avatar surfaced by T3 to
// hint at identity before the chat row is materialised.

import * as React from "react";
import type { AgentListEntry } from "@voidos/protocol";

export function DraftLabel({ agent }: { agent: AgentListEntry }) {
  const color = agent.color || "var(--text-muted)";
  const avatar = agent.avatar || "●";
  return (
    <div
      className="void-os-draft-label"
      data-testid="draft-label"
      data-agent={agent.name}
      style={{ ["--agent-color" as unknown as string]: color }}
    >
      <span className="void-os-draft-avatar">{avatar}</span>
      <span className="void-os-draft-text">
        Starting chat with <strong>{agent.name}</strong>
      </span>
    </div>
  );
}
