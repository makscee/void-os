export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
}

export interface ModelRates {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

// Per-token USD as of 2026-05 list prices.
// 1M input @ $15 → $15e-6 per token.
export const PRICING: Record<string, ModelRates> = {
  "claude-opus-4-7":   { input: 15e-6,  output: 75e-6, cacheCreate: 18.75e-6, cacheRead: 1.5e-6 },
  "claude-sonnet-4-6": { input: 3e-6,   output: 15e-6, cacheCreate: 3.75e-6,  cacheRead: 0.3e-6 },
  "claude-haiku-4-5":  { input: 0.8e-6, output: 4e-6,  cacheCreate: 1e-6,     cacheRead: 0.08e-6 },
};

export interface WarnLogger {
  warn(event: string, fields?: Record<string, unknown>): void;
}

export function priceFor(model: string, usage: Usage, log?: WarnLogger): number {
  const rates = PRICING[model];
  if (!rates) {
    log?.warn("cost.unknown_model", { model });
    return 0;
  }
  return rates.input * usage.inputTokens
    + rates.output * usage.outputTokens
    + rates.cacheCreate * usage.cacheCreateTokens
    + rates.cacheRead * usage.cacheReadTokens;
}
