// CostMeter.tsx — static sidebar widget mounted under ChatList.
//
// VOS-80 S5 ships a placeholder; VOS-81 will replace the literals with live
// daily-spend numbers from the daemon. Keeping the props-free shape so the
// future swap-in only edits this file.

import * as React from "react";

export function CostMeter(): React.ReactElement {
  return (
    <div
      data-testid="cost-meter"
      className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:text-[11px] vos:leading-none vos:text-[var(--text-muted)] vos:border-t vos:border-[var(--background-modifier-border)]"
    >
      $0.00 / $5.00 daily
    </div>
  );
}
