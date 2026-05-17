import * as React from "react";

export interface AgentBadgeProps {
  agent: string;
}

export function AgentBadge({ agent }: AgentBadgeProps) {
  return (
    <span
      data-testid="chat-row-agent"
      className={
        "vos:inline-block vos:font-mono vos:text-[10px] vos:leading-[1.4] " +
        "vos:px-[5px] vos:py-[1px] vos:rounded-[3px] vos:shrink-0 " +
        "vos:max-w-[80px] vos:overflow-hidden vos:text-ellipsis vos:whitespace-nowrap " +
        "vos:bg-[var(--background-secondary-alt)] vos:text-[var(--text-accent)]"
      }
    >
      {agent}
    </span>
  );
}
