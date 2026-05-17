// CostMeter.tsx — daily token meter; fetches /cost/today on mount and whenever
// refreshKey changes. Renders the 4-token split (in/out/cc/cr) using
// formatTokens (shared with ChatList per-chat context column).
//
// VOS-110 T5 replaces the VOS-80 S5 static placeholder with a live widget that
// consumes the ChatApi.getCostToday() shim.

import * as React from "react";
import type { ChatApi } from "./api";
import { formatTokens } from "./format-tokens";

interface CostTodayTotal {
  input_tokens: number;
  output_tokens: number;
  cache_create_tokens: number;
  cache_read_tokens: number;
}

interface CostMeterProps {
  api: ChatApi;
  refreshKey?: number;
}

const LOADING_TEXT = "— in / — out / — cc / — cr";

export function CostMeter(props: CostMeterProps): React.ReactElement {
  const { api, refreshKey } = props;
  const [total, setTotal] = React.useState<CostTodayTotal | null>(null);
  const [errored, setErrored] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setErrored(false);
    api.getCostToday()
      .then((res) => {
        if (cancelled) return;
        setTotal(res?.total ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setErrored(true);
        setTotal(null);
      });
    return () => { cancelled = true; };
  }, [api, refreshKey]);

  const text = total == null
    ? LOADING_TEXT
    : `${formatTokens(total.input_tokens)} in / ${formatTokens(total.output_tokens)} out / ${formatTokens(total.cache_create_tokens)} cc / ${formatTokens(total.cache_read_tokens)} cr`;

  return (
    <div
      data-testid="cost-meter"
      data-state={errored ? "error" : total == null ? "loading" : "ready"}
      className="vos:px-[var(--size-4-3)] vos:py-[var(--size-4-2)] vos:text-[11px] vos:leading-none vos:text-[var(--text-muted)] vos:border-t vos:border-[var(--background-modifier-border)]"
    >
      {text}
    </div>
  );
}
