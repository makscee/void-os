// orchestrator — per VOS-79 plan (2026-05-14-vos-79-chat-lifecycle-endpoints.md), Task 7.
//
// Responsibilities:
//   1. Acquire the per-chat lock by reading + setting chats.current_run_id
//      inside a single txn. If a non-terminal run already holds it, throw
//      Conflict409. Stale terminal current_run_id pointers (e.g. from a
//      crashed run that never cleared the lock) do NOT block new dispatch.
//   2. Insert a runs row (status='running') as part of the same txn so the
//      lock + run row are committed atomically.
//   3. Spawn the underlying claudev process via an injected Spawner.
//      The Spawner contract here is intentionally narrow — `AsyncIterable`
//      of parsed JSONL events — so tests can mock it and so the real
//      CcSpawner can be adapted by the wiring layer (Task 9) without
//      this module depending on Bun.spawn, bus subscriptions, or fs.
//   4. Translate spawner events into `chat.*` / `run.*` bus events.
//   5. Capture session_id exactly once per chat lifetime via the
//      `sessionCaptured` guard. Per T0 drill, claudev reuses the same
//      session_id across --resume, so we only write the first one. The
//      single in-memory boolean guard + the `chat.session_id IS NULL`
//      gate are both needed: the boolean guards against duplicate system
//      records inside one run; the IS NULL gate guards across runs when a
//      resume run re-emits the same id.
//   6. Finally-cleanup: clear chats.current_run_id and stamp ended_at on
//      the runs row, regardless of success or error.
//   7. Fire-and-forget titler on a successful first turn (titler is
//      internally idempotent — it no-ops if the chat already has a title
//      or has no session yet).
//
// Bus event names emitted: run.start, run.end, run.error,
//   chat.message_user, chat.token, chat.tool_call, chat.tool_result,
//   chat.completion. These mirror VOS-73's cc-spawner vocabulary (run.*)
//   and add chat.* for UI-facing stream surfaces.

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ChatRepo } from "./repo";
import { extractTurnText } from "./util";

/** Parsed stream event from claudev stdout JSONL. Shape is best-effort —
 * the spawner adapter normalizes to {type, ...}. */
export interface SpawnerEvent {
  type: string;
  session_id?: string;
  content?: unknown;
  message?: unknown;
  name?: string;
  input?: unknown;
  output?: unknown;
  [k: string]: unknown;
}

/**
 * Extract concatenated text from a CC stream-json `assistant` event. Per the
 * SDK shape, assistant events carry `{ message: { content: [{type:"text",
 * text}, {type:"tool_use", ...}, ...] } }`. We only sum text blocks; tool_use
 * blocks are surfaced separately via the `tool_use` event path. Returns "" if
 * the event has no recognisable text content (e.g. a pure tool-call turn).
 */
export function extractAssistantText(evt: SpawnerEvent): string {
  return extractTurnText(evt);
}

export interface SpawnArgs {
  chat_id: string;
  resume: string | null;
  prompt: string;
}

/** Narrow contract — async iterable of parsed events. The real CcSpawner
 * is bridged to this shape by the wiring layer. */
export interface Spawner {
  spawn(args: SpawnArgs): AsyncIterable<SpawnerEvent>;
}

export interface TitlerLike {
  title(chatId: string): Promise<void>;
}

export interface OrchestratorDeps {
  db: Database;
  repo: ChatRepo;
  spawner: Spawner;
  emit: (type: string, payload: Record<string, unknown>) => void;
  titler: TitlerLike;
}

export interface DispatchResult {
  run_id: string;
  status: "done" | "error";
}

export interface Orchestrator {
  dispatch(chatId: string, text: string): Promise<DispatchResult>;
}

/** 409 conflict — another dispatch holds the lock. HTTP layer (T9) maps
 * `err.status` and `err.current_run_id` directly into the response. */
export class Conflict409 extends Error {
  readonly status = 409;
  constructor(public readonly current_run_id: string) {
    super(`chat already has a running run: ${current_run_id}`);
    this.name = "Conflict409";
  }
}

/** A run is considered "terminal" if it can no longer emit events. Only
 * non-terminal pointers block new dispatch. */
const TERMINAL_STATUSES = new Set(["done", "error", "cancelled"]);

export function makeOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { db, repo, spawner, emit, titler } = deps;

  return {
    async dispatch(chatId, text) {
      const chat = repo.get(chatId);
      if (!chat) {
        const err = new Error(`chat not found: ${chatId}`) as Error & {
          status: number;
        };
        err.status = 404;
        throw err;
      }

      // Phase 1: acquire lock + insert run, atomic.
      const runId = randomUUID();
      const startedAt = Date.now();
      const acquire = db.transaction(() => {
        if (chat.current_run_id) {
          const existing = db
            .query("SELECT status FROM runs WHERE id = ?")
            .get(chat.current_run_id) as { status: string } | null;
          if (existing && !TERMINAL_STATUSES.has(existing.status)) {
            throw new Conflict409(chat.current_run_id);
          }
          // Stale pointer (terminal run or missing row) — overwrite below.
        }
        db.run(
          "INSERT INTO runs (id, chat_id, agent, kind, status, started_at) VALUES (?, ?, ?, 'chat', 'running', ?)",
          [runId, chatId, chat.agent, startedAt],
        );
        repo.setCurrentRun(chatId, runId);
      });
      acquire(); // may throw Conflict409 — propagates to caller, no cleanup needed (txn rolled back).

      emit("chat.message_user", { chat_id: chatId, run_id: runId, text });
      emit("run.start", {
        chat_id: chatId,
        run_id: runId,
        agent: chat.agent,
      });

      // Phase 2: spawn + drain. Errors here MUST land in finally.
      let status: "done" | "error" = "done";
      let errorMessage: string | null = null;
      let firstAssistantSeen = false;
      let lastAssistantText = "";
      // sessionCaptured guard: prevent duplicate setSession even if claudev
      // emits more than one system record per run.
      let sessionCaptured = chat.session_id !== null;

      try {
        const stream = spawner.spawn({
          chat_id: chatId,
          resume: chat.session_id,
          prompt: text,
        });
        for await (const evt of stream) {
          if (evt.type === "system" && typeof evt.session_id === "string") {
            // Double gate: in-memory boolean + the IS NULL check on the
            // canonical row. Across runs (--resume), claudev re-emits the
            // same id; we still want this branch to no-op.
            if (!sessionCaptured && chat.session_id === null) {
              repo.setSession(chatId, evt.session_id);
              sessionCaptured = true;
            }
          } else if (evt.type === "assistant") {
            firstAssistantSeen = true;
            // CC stream-json shape: text lives in evt.message.content[] as
            // {type:"text", text}. Pure tool-call assistant turns have no
            // text blocks — skip the emit so the wire stays clean (tool_use
            // rendering is a separate event).
            const text = extractAssistantText(evt);
            if (text) {
              lastAssistantText += text;
              emit("chat.token", {
                chat_id: chatId,
                run_id: runId,
                delta: text,
              });
            }
          } else if (evt.type === "tool_use") {
            emit("chat.tool_call", {
              chat_id: chatId,
              run_id: runId,
              tool: evt.name,
              input: evt.input,
            });
          } else if (evt.type === "tool_result") {
            emit("chat.tool_result", {
              chat_id: chatId,
              run_id: runId,
              tool: evt.name,
              output: evt.output,
            });
          }
        }
        if (firstAssistantSeen) {
          emit("chat.completion", { chat_id: chatId, run_id: runId });
          if (lastAssistantText) {
            repo.setLastMsg(chatId, lastAssistantText.slice(0, 200));
          }
        }
      } catch (err) {
        status = "error";
        errorMessage = err instanceof Error ? err.message : String(err);
        emit("run.error", {
          chat_id: chatId,
          run_id: runId,
          error: errorMessage,
        });
      } finally {
        // Phase 3: cleanup, atomic. Always clear the lock and stamp end.
        const endedAt = Date.now();
        const cleanup = db.transaction(() => {
          db.run(
            "UPDATE runs SET status = ?, ended_at = ?, error = ? WHERE id = ?",
            [status, endedAt, errorMessage, runId],
          );
          repo.setCurrentRun(chatId, null);
        });
        try {
          cleanup();
        } catch (cleanupErr) {
          // Last-ditch best-effort: if even the cleanup txn fails (disk full,
          // db closed), surface via bus but don't shadow the original error.
          emit("run.end_cleanup_failed", {
            chat_id: chatId,
            run_id: runId,
            error:
              cleanupErr instanceof Error
                ? cleanupErr.message
                : String(cleanupErr),
          });
        }
        emit("run.end", {
          chat_id: chatId,
          run_id: runId,
          status,
          error: errorMessage,
        });
      }

      // Phase 4: fire-and-forget titler on the FIRST successful turn.
      // The titler is internally idempotent, but we also gate here to
      // avoid spending a Haiku call on every subsequent turn — title
      // is only ever set once per chat. Re-read the row post-cleanup
      // so we see the session_id this turn just captured.
      if (status === "done") {
        const after = repo.get(chatId);
        if (after && after.title === null && after.session_id !== null) {
          titler.title(chatId).catch(() => {
            // Titler reports its own failures via the chat.title_failed
            // bus event; swallow here so it doesn't escape as an
            // unhandled rejection.
          });
        }
      }

      return { run_id: runId, status };
    },
  };
}
