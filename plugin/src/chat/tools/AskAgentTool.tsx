// AskAgentTool — collapsible nested sub-thread card for `ask_agent` tool calls.
// Registered via makeAssistantToolUI (VOS-91 T16).
//
// Data flow:
//   - toolCallId (from assistant-ui props) → ChildTaskContext.chatState.toolCallToChild
//     → childTaskId → chatState.childTasks[childTaskId]
//   - dispatch threaded from ChildTaskContext so toggle clicks hit the reducer.
//
// Rendering:
//   - WORKING:        auto-expanded, shows live token stream + live tool events.
//   - terminal:       auto-collapsed to one-line summary.
//   - manual click:   sticks (overrides auto rule) via child_toggle reducer action.
//   - depth ≥ MAX_DEPTH: truncation guard to prevent runaway nesting.

import * as React from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import type { ChildTaskStream, ChatState, LocalAction, ToolPart, ChatMessage } from "../reducer";
import { TERMINAL_CHILD_STATES } from "../reducer";
import { ChildTaskContext } from "../ChildTaskContext";
import { normalizeOutput } from "./normalize";

const MAX_DEPTH = 5;

// ── summary line ─────────────────────────────────────────────────────────────

function summary(stream: ChildTaskStream): string {
  switch (stream.state) {
    case "COMPLETED": {
      const last = [...stream.messages].reverse().find((m) => m.role === "assistant");
      const text = (last?.text ?? "").replace(/\s+/g, " ").trim();
      const head = text.length > 60 ? text.slice(0, 60) + "…" : text;
      return `${stream.agent} answered: ${head}`;
    }
    case "FAILED":
      return `${stream.agent} failed: ${stream.error ?? "unknown"}`;
    case "CANCELED":
      return `${stream.agent} canceled`;
    case "WORKING":
      return `${stream.agent} running…`;
    case "INPUT_REQUIRED":
      return `${stream.agent} waiting for input`;
  }
}

// ── nested tool part fallback (plain display, not full assistant-ui widget) ───

interface NestedToolPartProps {
  part: ToolPart;
  chatState: ChatState;
  depth: number;
  onToggle: (childTaskId: string, next: "expanded" | "collapsed") => void;
}

function NestedToolPart(props: NestedToolPartProps): React.ReactElement {
  const { part, chatState, depth, onToggle } = props;
  if (part.name === "ask_agent") {
    return (
      <AskAgentCard
        part={part}
        chatState={chatState}
        depth={depth}
        onToggle={onToggle}
      />
    );
  }
  // Non-ask_agent tool inside a child thread: simple one-line display.
  const hasResult = part.output !== undefined;
  const output = hasResult ? normalizeOutput(part.output) : "";
  return (
    <div
      className={
        "vos:my-1 vos:rounded-[var(--radius-s)] vos:border vos:px-2 vos:py-1 vos:text-xs vos:text-[var(--text-muted)] " +
        (part.isError
          ? "vos:border-[var(--text-error,#e35a5a)]"
          : "vos:border-[var(--background-modifier-border)]")
      }
      data-tool={part.name}
      data-tool-state={hasResult ? (part.isError ? "error" : "done") : "running"}
    >
      <span className="vos:uppercase vos:tracking-wider">{part.name}</span>
      {!hasResult && (
        <span
          className="vos:inline-block vos:w-[6px] vos:h-[6px] vos:rounded-full vos:bg-[var(--interactive-accent)] vos:ml-2"
          aria-label="running"
        />
      )}
      {hasResult && output && (
        <span className="vos:ml-2 vos:opacity-70">
          {output.length > 80 ? output.slice(0, 80) + "…" : output}
        </span>
      )}
    </div>
  );
}

// ── nested message renderer ───────────────────────────────────────────────────

interface NestedMessageProps {
  msg: ChatMessage;
  chatState: ChatState;
  depth: number;
  onToggle: (childTaskId: string, next: "expanded" | "collapsed") => void;
}

function NestedMessage(props: NestedMessageProps): React.ReactElement {
  const { msg, chatState, depth, onToggle } = props;
  return (
    <div className="vos:text-[13px]">
      {msg.text && <div>{msg.text}</div>}
      {msg.parts
        ?.filter((p) => p.kind === "tool")
        .map((tp, i) => (
          <NestedToolPart
            key={i}
            part={tp as ToolPart}
            chatState={chatState}
            depth={depth}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}

// ── nested thread body ────────────────────────────────────────────────────────

interface NestedThreadProps {
  stream: ChildTaskStream;
  chatState: ChatState;
  depth: number;
  onToggle: (childTaskId: string, next: "expanded" | "collapsed") => void;
}

function NestedThread(props: NestedThreadProps): React.ReactElement {
  const { stream, chatState, depth, onToggle } = props;
  return (
    <div className="vos:py-1">
      {stream.messages.map((m, i) => (
        <NestedMessage
          key={i}
          msg={m}
          chatState={chatState}
          depth={depth}
          onToggle={onToggle}
        />
      ))}
      {stream.liveTokens && (
        <div className="vos:text-[13px] vos:text-[var(--text-normal)]">
          {stream.liveTokens}
        </div>
      )}
      {stream.liveToolEvents.map((tp, i) => (
        <NestedToolPart
          key={`live-${i}`}
          part={tp}
          chatState={chatState}
          depth={depth}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

// ── core card (recursion-safe) ────────────────────────────────────────────────

interface AskAgentCardProps {
  /** ToolPart with optional childTaskId set by the refetched/live reducer. */
  part: ToolPart;
  chatState: ChatState;
  depth: number;
  onToggle: (childTaskId: string, next: "expanded" | "collapsed") => void;
}

function AskAgentCard(props: AskAgentCardProps): React.ReactElement {
  const { part, chatState, depth, onToggle } = props;
  const cid = part.childTaskId;
  const stream = cid ? chatState.childTasks[cid] : undefined;

  if (depth > MAX_DEPTH) {
    return (
      <div className="vos:text-xs vos:text-[var(--text-muted)] vos:italic">
        (deep nesting truncated)
      </div>
    );
  }

  if (!stream) {
    // Race: child_task_started not yet received — render minimal placeholder.
    return (
      <div
        className="vos:my-1 vos:border-l-2 vos:pl-3 vos:text-xs vos:text-[var(--text-muted)]"
        style={{ borderColor: "var(--background-modifier-border)" }}
        data-testid="ask-agent-tool"
        data-state="WORKING"
        data-expanded="true"
      >
        <span>→ ask_agent · </span>
        <span className="vos:opacity-60">starting…</span>
      </div>
    );
  }

  const isTerminal = TERMINAL_CHILD_STATES.has(stream.state);
  const expanded =
    stream.manualToggle === "expanded"
      ? true
      : stream.manualToggle === "collapsed"
      ? false
      : !isTerminal; // auto: open while running, collapsed on terminal

  const stateBadge = stream.state.toLowerCase().replace("_", " ");

  return (
    <div
      data-testid="ask-agent-tool"
      data-child-task-id={stream.taskId}
      data-state={stream.state}
      data-expanded={expanded ? "true" : "false"}
      className="vos:my-1 vos:border-l-2 vos:pl-3"
      style={{ borderColor: "var(--background-modifier-border)" }}
    >
      <button
        type="button"
        className="vos:flex vos:items-center vos:gap-2 vos:text-[12px] vos:text-[var(--text-muted)] hover:vos:text-[var(--text-normal)]"
        onClick={() => onToggle(stream.taskId, expanded ? "collapsed" : "expanded")}
      >
        <span aria-hidden>→ ask_agent</span>
        <span>·</span>
        <span className="vos:font-medium">{stream.agent}</span>
        <span>·</span>
        <span data-testid="ask-agent-state-badge">{stateBadge}</span>
      </button>
      {expanded ? (
        <NestedThread
          stream={stream}
          chatState={chatState}
          depth={depth + 1}
          onToggle={onToggle}
        />
      ) : (
        <div
          data-testid="ask-agent-summary"
          className="vos:text-[12px] vos:text-[var(--text-muted)] vos:py-1"
        >
          {summary(stream)}
        </div>
      )}
    </div>
  );
}

// ── assistant-ui tool registration ────────────────────────────────────────────

interface AskAgentArgs {
  target_agent_id?: unknown;
  message?: unknown;
  [k: string]: unknown;
}

function AskAgentRender(props: {
  args?: AskAgentArgs;
  result?: unknown;
  isError?: boolean;
  toolCallId: string;
}): React.ReactElement {
  const { chatState, dispatch } = React.useContext(ChildTaskContext);

  const onToggle = React.useCallback(
    (childTaskId: string, next: "expanded" | "collapsed") => {
      (dispatch as React.Dispatch<LocalAction>)({ kind: "child_toggle", childTaskId, next });
    },
    [dispatch],
  );

  // Look up childTaskId via the toolCallId→child map set by the reducer.
  const childTaskId = chatState.toolCallToChild[props.toolCallId];
  const input = (props.args && typeof props.args === "object" ? props.args : {}) as Record<string, unknown>;
  const output =
    typeof props.result === "string"
      ? props.result
      : props.result != null
      ? String(props.result)
      : undefined;
  const part: ToolPart = {
    kind: "tool",
    toolCallId: props.toolCallId,
    name: "ask_agent",
    input,
    output,
    isError: props.isError === true,
    childTaskId,
  };

  return (
    <AskAgentCard
      part={part}
      chatState={chatState}
      depth={1}
      onToggle={onToggle}
    />
  );
}

export const AskAgentTool = makeAssistantToolUI<AskAgentArgs, unknown>({
  toolName: "ask_agent",
  render: AskAgentRender as never,
});
