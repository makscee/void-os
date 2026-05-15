import type { Database } from "bun:sqlite";
import type { EventBus, RunEndEvent, UsageTurn } from "../events";
import { priceFor, type Usage, type WarnLogger } from "./pricing";

export interface CostRollup {
  usd: number;
  tokens_in: number;
  tokens_out: number;
}

function turnToUsage(t: UsageTurn): Usage {
  return {
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheCreateTokens: t.cacheCreateTokens,
    cacheReadTokens: t.cacheReadTokens,
  };
}

function sumTurns(turns: UsageTurn[]): Usage {
  return turns.reduce<Usage>(
    (acc, t) => ({
      inputTokens: acc.inputTokens + t.inputTokens,
      outputTokens: acc.outputTokens + t.outputTokens,
      cacheCreateTokens: acc.cacheCreateTokens + t.cacheCreateTokens,
      cacheReadTokens: acc.cacheReadTokens + t.cacheReadTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreateTokens: 0, cacheReadTokens: 0 },
  );
}

export function subscribeRunEnd(bus: EventBus, db: Database, log: WarnLogger): () => void {
  return bus.subscribe("run.end", (raw) => {
    const ev = raw as RunEndEvent;
    const turns = ev.payload?.usageTurns;
    if (!turns || turns.length === 0) {
      log.warn("cost.missing_usage", { runId: ev.runId });
      return;
    }
    const total = sumTurns(turns);
    const allSame = turns.every((t) => t.model === turns[0]!.model);
    const model = allSame ? turns[0]!.model : "mixed";
    const costUsd = turns.reduce((acc, t) => acc + priceFor(t.model, turnToUsage(t), log), 0);
    db.run(
      `INSERT INTO costs (run_id, chat_id, agent, ts, cost_usd,
                          input_tokens, output_tokens,
                          cache_create_tokens, cache_read_tokens, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ev.runId, ev.chatId, ev.payload.agent, ev.payload.endedAt, costUsd,
       total.inputTokens, total.outputTokens,
       total.cacheCreateTokens, total.cacheReadTokens, model],
    );
  });
}

export function costsForToday(db: Database): CostRollup {
  const row = db.query(
    `SELECT
       COALESCE(SUM(cost_usd), 0) AS usd,
       COALESCE(SUM(input_tokens + cache_create_tokens + cache_read_tokens), 0) AS tokens_in,
       COALESCE(SUM(output_tokens), 0) AS tokens_out
     FROM costs
     WHERE date(ts/1000, 'unixepoch') = date('now')`,
  ).get() as CostRollup;
  return row;
}

export function costsForChat(db: Database, chatId: string): CostRollup {
  const row = db.query(
    `SELECT
       COALESCE(SUM(cost_usd), 0) AS usd,
       COALESCE(SUM(input_tokens + cache_create_tokens + cache_read_tokens), 0) AS tokens_in,
       COALESCE(SUM(output_tokens), 0) AS tokens_out
     FROM costs
     WHERE chat_id = ?`,
  ).get(chatId) as CostRollup;
  return row;
}
