import * as React from "react";

export type Status = "input_required" | "error" | "running" | "cancelled" | "idle";

/**
 * Precedence per VOS-114 spec:
 *   input_required > error > running > cancelled > idle (done/null/unknown)
 * Pure — easy to unit-test, easy to reuse if another surface needs the
 * same fold (e.g. tab title badge).
 */
export function resolveStatus(
  inputRequired: boolean,
  lastRunStatus: string | null,
): Status {
  if (inputRequired) return "input_required";
  if (lastRunStatus === "error") return "error";
  if (lastRunStatus === "running") return "running";
  if (lastRunStatus === "cancelled") return "cancelled";
  return "idle";
}

const COLOR: Record<Status, string> = {
  input_required: "var(--text-warning, #d8a657)",
  error:          "var(--text-error, #e35a5a)",
  running:        "var(--interactive-accent)",
  cancelled:      "var(--text-muted)",
  idle:           "transparent",
};

export interface StatusDotProps {
  input_required: boolean;
  last_run_status: string | null;
}

export function StatusDot({ input_required, last_run_status }: StatusDotProps) {
  const status = resolveStatus(input_required, last_run_status);
  const color = COLOR[status];
  return (
    <span
      aria-hidden={status === "idle"}
      aria-label={status === "input_required" ? "input required" : undefined}
      data-testid="chat-row-status"
      data-status={status}
      className={
        "vos:inline-block vos:w-1.5 vos:h-1.5 vos:rounded-full vos:shrink-0 " +
        (status === "running" ? "vos-run-dot " : "") +
        (status === "idle" ? "vos:invisible" : "")
      }
      style={{ backgroundColor: color }}
    />
  );
}
