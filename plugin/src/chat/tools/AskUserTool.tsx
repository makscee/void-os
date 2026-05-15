// ask_user tool UI — special-cased rendering for `ask_user` tool calls.
// Registered via assistant-ui's `makeAssistantToolUI` so any assistant message
// content part with `toolName === "ask_user"` gets this component.
//
// Three rendering stages:
//   pending   : question + N option buttons (if options present)
//   submitting: same DOM but buttons disabled + spinner on clicked button
//   answered  : muted "answered: <result>" line, no buttons
//
// chatId + api.answer are pulled from AskUserContext (provided by ChatRoot)
// because assistant-ui's tool render fn does not receive runtime deps.

import * as React from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { AskUserContext } from "../AskUserContext";

interface AskUserArgs {
  question?: unknown;
  options?: unknown;
  // task_id / context_id / run_id are present but unused in this component.
  [k: string]: unknown;
}

function readArgs(raw: AskUserArgs | undefined): { question: string; options: string[] } {
  const question = typeof raw?.question === "string" ? raw.question : "";
  const options = Array.isArray(raw?.options)
    ? (raw!.options as unknown[]).filter((o): o is string => typeof o === "string")
    : [];
  return { question, options };
}

function AskUserRender(props: {
  args?: AskUserArgs;
  result?: unknown;
  isError?: boolean;
  toolCallId: string;
}) {
  const ctx = React.useContext(AskUserContext);
  const { question, options } = readArgs(props.args);
  const hasResult = props.result !== undefined && props.result !== null;
  const isError = props.isError === true;
  const resultText = hasResult ? String(props.result) : "";
  const [submitting, setSubmitting] = React.useState<string | null>(null);

  const onPick = React.useCallback(
    async (value: string) => {
      if (submitting !== null) return;
      setSubmitting(value);
      try {
        const r = await ctx.answer(props.toolCallId, value);
        if (r && "ok" in r && r.ok === false && r.status === 409) {
          ctx.showToast("Question already resolved.");
        }
      } catch {
        ctx.showToast("Couldn't send — try again.");
        setSubmitting(null);
      }
      // Success path leaves `submitting` set; daemon echo will flip props.result
      // and re-render in the answered stage. Component will unmount on chat switch.
    },
    [ctx, props.toolCallId, submitting],
  );

  if (hasResult) {
    return (
      <div
        data-testid="ask-user-prompt"
        data-tool="ask_user"
        data-tool-state={isError ? "error" : "done"}
        className={
          "vos:my-[var(--size-4-2)] vos:rounded-[var(--radius-s)] vos:border vos:px-[var(--size-4-2)] vos:py-[var(--size-4-1)] vos:text-[var(--text-muted)] vos:text-xs " +
          (isError
            ? "vos:border-[var(--text-error,#e35a5a)]"
            : "vos:border-[var(--background-modifier-border)]")
        }
      >
        answered: {resultText || "(empty)"}
      </div>
    );
  }

  return (
    <div
      data-testid="ask-user-prompt"
      data-tool="ask_user"
      data-tool-state="pending"
      className="vos:my-[var(--size-4-2)] vos:rounded-[var(--radius-s)] vos:border vos:border-[var(--interactive-accent)] vos:px-[var(--size-4-2)] vos:py-[var(--size-4-2)] vos:bg-[var(--background-secondary)]"
    >
      <div className="vos:text-[var(--text-normal)] vos:whitespace-pre-wrap vos:mb-[var(--size-4-2)]">
        {question || "(no question)"}
      </div>
      {options.length > 0 && (
        <div className="vos:flex vos:flex-wrap vos:gap-[var(--size-4-2)]">
          {options.map((opt) => {
            const isSubmittingThis = submitting === opt;
            const disabled = submitting !== null;
            return (
              <button
                key={opt}
                type="button"
                data-testid="ask-user-option"
                data-value={opt}
                aria-busy={isSubmittingThis}
                disabled={disabled}
                onClick={() => onPick(opt)}
                className={
                  "vos:px-[var(--size-4-3)] vos:py-[var(--size-4-1)] vos:rounded-[var(--radius-s)] vos:border vos:border-[var(--background-modifier-border)] vos:bg-[var(--background-primary)] vos:text-[var(--text-normal)] vos:cursor-pointer " +
                  (disabled && !isSubmittingThis ? "vos:opacity-50 vos:pointer-events-none " : "") +
                  (isSubmittingThis ? "vos:opacity-80 " : "")
                }
              >
                {opt}
                {isSubmittingThis && <span aria-hidden="true"> …</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const _ToolUI = makeAssistantToolUI<AskUserArgs, unknown>({
  toolName: "ask_user",
  render: AskUserRender as never,
});

/** Exposed wrapper. The default export is the registration component (mount it
 *  once in ChatRoot, sibling to <BashTool/>). `__renderForTest` exposes the
 *  inner render fn for unit tests without going through assistant-ui's
 *  store registration. */
export const AskUserTool = Object.assign(_ToolUI, { __renderForTest: AskUserRender });
