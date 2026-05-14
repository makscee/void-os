// Generic fallback tool UI — used for any tool name not specifically handled.
// Registered via assistant-ui's `MessagePrimitive.Parts components.tools.Fallback`
// hook so unmatched tool calls don't render as blank space.
//
// Layout:
//   - top row: tool name label + status dot
//   - input as JSON-pretty <pre>
//   - output (string-normalized) as <pre>
//   - is_error tinted styling when set

import * as React from "react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { normalizeOutput } from "./normalize";

function jsonPretty(v: unknown): string {
  if (v == null) return "";
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export const GenericTool: ToolCallMessagePartComponent<unknown, unknown> = (props) => {
  const hasResult = props.result !== undefined && props.result !== null;
  const isError = props.isError === true;
  const output = hasResult ? normalizeOutput(props.result) : "";
  const inputText = jsonPretty(props.args);

  const [open, setOpen] = React.useState<boolean>(!hasResult);
  const sawResultRef = React.useRef<boolean>(hasResult);
  React.useEffect(() => {
    if (!sawResultRef.current && hasResult) {
      sawResultRef.current = true;
      setOpen(false);
    }
  }, [hasResult]);

  return (
    <div
      className={
        "vos:my-[var(--size-4-2)] vos:rounded-[var(--radius-s)] vos:border " +
        (isError
          ? "vos:border-[var(--text-error,#e35a5a)]"
          : "vos:border-[var(--background-modifier-border)]")
      }
      data-tool={props.toolName || "tool"}
      data-tool-state={hasResult ? (isError ? "error" : "done") : "running"}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="vos:w-full vos:flex vos:items-center vos:gap-[var(--size-4-2)] vos:px-[var(--size-4-2)] vos:py-[var(--size-4-1)] vos:text-[var(--text-muted)] vos:bg-[var(--background-secondary)] vos:rounded-t-[var(--radius-s)] vos:cursor-pointer"
        aria-expanded={open}
        aria-label={open ? "collapse tool" : "expand tool"}
      >
        <span className="vos:text-xs vos:uppercase vos:tracking-wider">
          {props.toolName || "tool"}
        </span>
        {!hasResult && (
          <span
            className="vos-run-dot vos:inline-block vos:w-[6px] vos:h-[6px] vos:rounded-full vos:bg-[var(--interactive-accent)]"
            aria-label="running"
          />
        )}
        <span className="vos:flex-1" />
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="vos:px-[var(--size-4-2)] vos:py-[var(--size-4-2)] vos:flex vos:flex-col vos:gap-[var(--size-4-2)]">
          {inputText && (
            <pre
              className="vos:m-0 vos:whitespace-pre-wrap vos:break-words vos:font-mono vos:text-xs vos:p-[var(--size-4-2)] vos:rounded-[var(--radius-s)] vos:bg-[var(--background-secondary)] vos:text-[var(--text-normal)] vos:border-l-2 vos:border-[var(--interactive-accent)]"
              data-tool-input
            >
              {inputText}
            </pre>
          )}
          {hasResult && (
            <pre
              className={
                "vos:m-0 vos:whitespace-pre-wrap vos:break-words vos:font-mono vos:text-xs vos:p-[var(--size-4-2)] vos:rounded-[var(--radius-s)] vos:bg-[var(--background-secondary)] " +
                (isError ? "vos:text-[var(--text-error,#e35a5a)]" : "vos:text-[var(--text-muted)]")
              }
              data-tool-output
            >
              {output || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};
