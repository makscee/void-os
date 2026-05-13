// Cost tracker. Records token spend per run/agent, enforces caps.

export interface CostRecord {
  runId: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  ts: number;
}

export interface CostTracker {
  record(rec: CostRecord): Promise<void>;
  today(): Promise<{ total: number; byAgent: Record<string, number> }>;
  checkCap(agent: string): Promise<{ allowed: boolean; remaining: number }>;
}

export const createCostTracker = (): CostTracker => {
  throw new Error("not implemented");
};
