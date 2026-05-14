// Bash tool UI — special-cased rendering for `Bash` tool calls.
// Registered via assistant-ui's `makeAssistantToolUI` so any assistant message
// content part with `toolName === "Bash"` gets this component.
//
// Layout:
//   - top row: small "Bash" label + status dot + collapse toggle (chevron)
//   - command (from input.command) in a tinted <pre>
//   - stdout (from result/output) in a muted <pre>, expandable
//   - exit code badge when present in input/output JSON (best-effort, hidden if missing)
//
// Collapse rules:
//   - while running (no result yet) → expanded
//   - once result has arrived → collapsed by default; user can re-expand

import * as React from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { normalizeOutput } from "./normalize";

interface BashArgs {
  command?: string;
  // Anthropic Bash tool occasionally tucks exit_code in here; usually it lives
  // on result.  We pick it up best-effort.
  [k: string]: unknown;
}

function pickExitCode(args: BashArgs | undefined, result: unknown): number | null {
  // Inputs typically don't carry exit code, but be defensive.
  if (args && typeof args.exit_code === "number") return args.exit_code as number;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as { exit_code?: unknown; exitCode?: unknown };
    if (typeof r.exit_code === "number") return r.exit_code;
    if (typeof r.exitCode === "number") return r.exitCode;
  }
  return null;
}

export const BashTool = makeAssistantToolUI<BashArgs, unknown>({
  toolName: "Bash",
  render: function BashToolRender(props) {
    const args = (props.args ?? {}) as BashArgs;
    const command = typeof args.command === "string" ? args.command : "";
    const hasResult = props.result !== undefined && props.result !== null;
    const output = hasResult ? normalizeOutput(props.result) : "";
    const isError = props.isError === true;
    const exitCode = pickExitCode(args, props.result);

    // Default collapsed once finished, open while running.
    const [open, setOpen] = React.useState<boolean>(!hasResult);
    // When result transitions from absent → present, auto-collapse once.
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
        data-tool="Bash"
        data-tool-state={hasResult ? (isError ? "error" : "done") : "running"}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="vos:w-full vos:flex vos:items-center vos:gap-[var(--size-4-2)] vos:px-[var(--size-4-2)] vos:py-[var(--size-4-1)] vos:text-[var(--text-muted)] vos:bg-[var(--background-secondary)] vos:rounded-t-[var(--radius-s)] vos:cursor-pointer"
          aria-expanded={open}
          aria-label={open ? "collapse bash tool" : "expand bash tool"}
        >
          <span className="vos:text-xs vos:uppercase vos:tracking-wider">Bash</span>
          {!hasResult && (
            <span
              className="vos-run-dot vos:inline-block vos:w-[6px] vos:h-[6px] vos:rounded-full vos:bg-[var(--interactive-accent)]"
              aria-label="running"
            />
          )}
          {exitCode !== null && (
            <span
              className={
                "vos:text-xs vos:px-[var(--size-4-1)] vos:rounded-[var(--radius-s)] " +
                (exitCode === 0
                  ? "vos:bg-[var(--background-modifier-border)] vos:text-[var(--text-muted)]"
                  : "vos:bg-[var(--text-error,#e35a5a)] vos:text-[var(--text-on-accent)]")
              }
              data-exit-code={exitCode}
            >
              exit {exitCode}
            </span>
          )}
          <span className="vos:flex-1 vos:truncate vos:text-left vos:text-[var(--text-normal)] vos:font-mono vos:text-xs">
            {command || "(no command)"}
          </span>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <div className="vos:px-[var(--size-4-2)] vos:py-[var(--size-4-2)] vos:flex vos:flex-col vos:gap-[var(--size-4-2)]">
            <pre
              className="vos:m-0 vos:whitespace-pre-wrap vos:break-words vos:font-mono vos:text-xs vos:p-[var(--size-4-2)] vos:rounded-[var(--radius-s)] vos:bg-[var(--background-secondary)] vos:text-[var(--text-normal)] vos:border-l-2 vos:border-[var(--interactive-accent)]"
              data-tool-input
            >
              {command}
            </pre>
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
  },
});
