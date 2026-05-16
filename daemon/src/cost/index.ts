import type { Database } from "bun:sqlite";
import type { EventBus, RunEndEvent, UsageTurn } from "../events";
import { priceFor, type Usage, type WarnLogger } from "./pricing";

export interface CostTodayResponse {
  total_usd: number;
  total: {
    input_tokens: number;
    output_tokens: number;
    cache_create_tokens: number;
    cache_read_tokens: number;
  };
  by_task: Array<{
    task_id: string;
    usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_create_tokens: number;
    cache_read_tokens: number;
  }>;
  by_chat: Array<{
    chat_id: string;
    usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_create_tokens: number;
    cache_read_tokens: number;
  }>;
}

function turnToUsage(t: UsageTurn): Usage {
  return {
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheCreateTokens: t.cacheCreateTokens,
    cacheReadTokens: t.cacheReadTokens,
  };
}

export function subscribeRunEnd(
  bus: EventBus,
  db: Database,
  log: WarnLogger,
): () => void {
  return bus.subscribe("run.end", (raw) => {
    const ev = raw as RunEndEvent;
    const turns = ev.payload?.usageTurns;
    if (!turns || turns.length === 0) {
      log.warn("cost.missing_usage", { runId: ev.runId });
      return;
    }

    const taskId = ev.payload.taskId ?? null;

    const tx = db.transaction(() => {
      let totalIn = 0;
      let totalOut = 0;
      let totalUsd = 0;

      const insertStmt = db.prepare(
        `INSERT INTO costs (run_id, task_id, chat_id, agent, provider, ts,
                            cost_usd, input_tokens, output_tokens,
                            cache_create_tokens, cache_read_tokens, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const t of turns) {
        const usd = priceFor(t.model, turnToUsage(t), log);
        const provider = t.provider ?? "claude-code";
        if (!t.provider) {
          log.warn("cost.missing_provider", { runId: ev.runId, model: t.model });
        }
        insertStmt.run(
          ev.runId,
          taskId,
          ev.chatId,
          ev.payload.agent,
          provider,
          ev.payload.endedAt,
          usd,
          t.inputTokens,
          t.outputTokens,
          t.cacheCreateTokens,
          t.cacheReadTokens,
          t.model,
        );
        totalIn += t.inputTokens;
        totalOut += t.outputTokens;
        totalUsd += usd;
      }

      if (taskId !== null) {
        const updateStmt = db.prepare(
          `UPDATE tasks
              SET cost_usd   = cost_usd   + ?,
                  tokens_in  = tokens_in  + ?,
                  tokens_out = tokens_out + ?,
                  updated_at = ?
            WHERE id = ?`,
        );
        const result = updateStmt.run(totalUsd, totalIn, totalOut, ev.payload.endedAt, taskId);
        if (result.changes === 0) {
          log.warn("cost.task_missing", { runId: ev.runId, taskId });
        }
      }
    });

    // EventBus contract (daemon/src/events/index.ts:61): handler exceptions
    // are caught and forwarded to the bus logger. Do NOT rethrow — duplicate
    // log line. SQLite BUSY / write failures are logged-and-swallowed; cost
    // data for the failing run is lost. Accept for v1.
    try {
      tx();
    } catch (err) {
      log.warn("cost.write_failed", { runId: ev.runId, err: String(err) });
    }
  });
}

export function costsForToday(
  db: Database,
  range: { startMs: number; endMs: number },
): CostTodayResponse {
  const total = db.query(
    `SELECT
       COALESCE(SUM(cost_usd), 0)             AS total_usd,
       COALESCE(SUM(input_tokens), 0)         AS input_tokens,
       COALESCE(SUM(output_tokens), 0)        AS output_tokens,
       COALESCE(SUM(cache_create_tokens), 0)  AS cache_create_tokens,
       COALESCE(SUM(cache_read_tokens), 0)    AS cache_read_tokens
     FROM costs WHERE ts >= ? AND ts < ?`,
  ).get(range.startMs, range.endMs) as {
    total_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_create_tokens: number;
    cache_read_tokens: number;
  };

  const by_task = db.query(
    `SELECT task_id,
            COALESCE(SUM(cost_usd), 0)             AS usd,
            COALESCE(SUM(input_tokens), 0)         AS input_tokens,
            COALESCE(SUM(output_tokens), 0)        AS output_tokens,
            COALESCE(SUM(cache_create_tokens), 0)  AS cache_create_tokens,
            COALESCE(SUM(cache_read_tokens), 0)    AS cache_read_tokens
       FROM costs
      WHERE ts >= ? AND ts < ? AND task_id IS NOT NULL
      GROUP BY task_id
      ORDER BY usd DESC`,
  ).all(range.startMs, range.endMs) as CostTodayResponse["by_task"];

  const by_chat = db.query(
    `SELECT chat_id,
            COALESCE(SUM(cost_usd), 0)             AS usd,
            COALESCE(SUM(input_tokens), 0)         AS input_tokens,
            COALESCE(SUM(output_tokens), 0)        AS output_tokens,
            COALESCE(SUM(cache_create_tokens), 0)  AS cache_create_tokens,
            COALESCE(SUM(cache_read_tokens), 0)    AS cache_read_tokens
       FROM costs
      WHERE ts >= ? AND ts < ?
      GROUP BY chat_id
      ORDER BY usd DESC`,
  ).all(range.startMs, range.endMs) as CostTodayResponse["by_chat"];

  return {
    total_usd: total.total_usd,
    total: {
      input_tokens: total.input_tokens,
      output_tokens: total.output_tokens,
      cache_create_tokens: total.cache_create_tokens,
      cache_read_tokens: total.cache_read_tokens,
    },
    by_task,
    by_chat,
  };
}

export function costsForChat(db: Database, chatId: string): {
  usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_create_tokens: number;
  cache_read_tokens: number;
} {
  return db.query(
    `SELECT COALESCE(SUM(cost_usd), 0)            AS usd,
            COALESCE(SUM(input_tokens), 0)        AS input_tokens,
            COALESCE(SUM(output_tokens), 0)       AS output_tokens,
            COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens,
            COALESCE(SUM(cache_read_tokens), 0)   AS cache_read_tokens
       FROM costs WHERE chat_id = ?`,
  ).get(chatId) as {
    usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_create_tokens: number;
    cache_read_tokens: number;
  };
}
