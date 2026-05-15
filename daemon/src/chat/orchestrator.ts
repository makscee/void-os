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
//   chat.message_user, chat.token, chat.tool_use, chat.tool_result.
//   These mirror VOS-73's cc-spawner vocabulary (run.*) and add chat.*
//   for UI-facing stream surfaces. run.end is the authoritative terminal
//   frame; the canonical assistant text is in the messages table.
//
// chat.tool_use / chat.tool_result frame contract (consumed by plugin S4):
//   { type: "chat.tool_use",   chat_id, run_id, tool_call_id, name, input }
//   { type: "chat.tool_result", chat_id, run_id, tool_call_id, output, is_error }
// Source of truth — tool_use blocks live on assistant-role events at
// evt.message.content[]; tool_result blocks live on user-role events at
// evt.message.content[]. The wire envelope is added by app.ts broadcast()
// (prepends {type, ts, ...payload}).

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ChatRepo } from "./repo";
import { makeMessagesRepo, type MessagesRepo } from "./messages-repo";
import { extractTurnText, extractToolUses, extractToolResults } from "./util";
import { extractAssistantText } from "../providers/claude-code/index.ts";

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

export interface SpawnArgs {
  chat_id: string;
  resume: string | null;
  prompt: string;
}

/** Narrow contract — async iterable of parsed events. The real CcSpawner
 * is bridged to this shape by the wiring layer.
 *
 * `cancel(runId)` is optional — when present, the orchestrator's
 * `cancel(chatId)` calls into it to terminate the underlying subprocess.
 * The spawner-iter adapter (VOS-80) implements this by calling
 * `CcProcess.kill()` (SIGTERM → SIGKILL grace) on the matching runId. A
 * spawner without `cancel` is treated as un-cancellable: orchestrator's
 * `cancel()` still flips the cancel-request flag, but the underlying
 * iterator must terminate on its own (test fakes do this via a `killed`
 * polling loop). Returns true if the runId was known + signalled. */
export interface Spawner {
  spawn(args: SpawnArgs): AsyncIterable<SpawnerEvent>;
  cancel?(runId: string): Promise<boolean>;
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
  status: "done" | "error" | "cancelled";
}

/** Result of `cancel(chatId)`. `cancelled=true` when an in-flight run was
 * found and signalled; `cancelled=false` when no active run exists (HTTP
 * layer maps this to 409 no_active_run — idempotent). */
export interface CancelResult {
  cancelled: boolean;
  run_id: string | null;
}

export interface Orchestrator {
  dispatch(chatId: string, text: string): Promise<DispatchResult>;
  cancel(chatId: string): Promise<CancelResult>;
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
  // VOS-80 architecture (a): canonical messages store. Wired off the same
  // db handle as `repo`, so all persistence shares one connection (and
  // therefore the same per-statement txn semantics). Constructed lazily
  // per orchestrator so tests with multiple orchestrators don't share state.
  const messages: MessagesRepo = makeMessagesRepo(db);

  // Per-run cancel registry. Populated by dispatch() at run.start time and
  // consulted in both the streaming loop (after-yield bail) and the finally
  // block (status="cancelled" instead of "done"). `cancel(chatId)` looks
  // up the current_run_id, flips the flag, and forwards to spawner.cancel
  // if available — so the subprocess actually receives SIGTERM/SIGKILL and
  // the for-await loop unblocks. Cleared on run end.
  const cancelRequested = new Set<string>();

  return {
    async cancel(chatId) {
      const chat = repo.get(chatId);
      if (!chat || !chat.current_run_id) {
        return { cancelled: false, run_id: null };
      }
      const runId = chat.current_run_id;
      if (cancelRequested.has(runId)) {
        // Already cancelled in flight — return the run_id so callers can
        // log it, but cancelled=false flags this as a duplicate (the HTTP
        // layer still surfaces it as 200 only if the run was *just* terminated;
        // subsequent calls after the run finishes hit the no-current_run_id
        // branch above and return cancelled=false). The flag-already-set
        // case is rare (concurrent cancel requests) — treat it as "yes, the
        // first one already took effect" so the second call is idempotent.
        return { cancelled: true, run_id: runId };
      }
      cancelRequested.add(runId);
      // Best-effort: signal the underlying spawner. If the spawner exposes
      // no cancel hook (legacy test fakes), the orchestrator still records
      // intent so the post-stream finally block stamps status="cancelled".
      if (spawner.cancel) {
        await spawner.cancel(runId).catch(() => false);
      }
      return { cancelled: true, run_id: runId };
    },
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

      // VOS-80 (a): persist the user prompt immediately — before spawning CC.
      // GET /chat/:id/messages reads from the messages table, so the user
      // turn must be visible the moment dispatch is accepted.
      messages.appendUser(chatId, runId, text, startedAt);

      emit("chat.message_user", { chat_id: chatId, run_id: runId, text });
      emit("run.start", {
        chat_id: chatId,
        run_id: runId,
        agent: chat.agent,
      });

      // Phase 2: spawn + drain. Errors here MUST land in finally.
      let status: "done" | "error" | "cancelled" = "done";
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
          // VOS-80 S5: cancel-bail. The for-await may already have a buffered
          // event that arrived before SIGTERM landed; drop further events so
          // the run terminates promptly without surfacing post-cancel tokens.
          if (cancelRequested.has(runId)) {
            break;
          }
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
            // {type:"text", text}, possibly interleaved with tool_use blocks.
            // Pure tool-call assistant turns have no text blocks — skip the
            // chat.token emit but still surface their tool_use blocks below.
            const text = extractAssistantText(evt);
            if (text) {
              lastAssistantText += text;
              emit("chat.token", {
                chat_id: chatId,
                run_id: runId,
                delta: text,
              });
            }
            // Surface every tool_use block in this assistant turn as a
            // dedicated WS frame (S4 tool-call panel hydration).
            for (const tu of extractToolUses(evt)) {
              // VOS-80 (a): persist immediately so replay can render tool
              // blocks even if the run is cancelled before completion.
              const tuTs = typeof evt.ts === "number" ? evt.ts : Date.now();
              const inputJson = (() => {
                try {
                  return JSON.stringify(tu.input);
                } catch {
                  return String(tu.input);
                }
              })();
              messages.appendToolUse(
                chatId,
                runId,
                tu.tool_call_id,
                tu.name,
                inputJson,
                tuTs,
              );
              emit("chat.tool_use", {
                chat_id: chatId,
                run_id: runId,
                tool_call_id: tu.tool_call_id,
                name: tu.name,
                input: tu.input,
              });
            }
          } else if (evt.type === "user") {
            // User-role events with tool_result content[] carry the model's
            // tool output for the next assistant turn. They are NOT user
            // messages (chat.message_user was already emitted for the prompt
            // at dispatch start) — they only surface as chat.tool_result.
            for (const tr of extractToolResults(evt)) {
              // VOS-80 (a): normalize output to text and persist immediately.
              const outText =
                typeof tr.output === "string"
                  ? tr.output
                  : (() => {
                      try {
                        return JSON.stringify(tr.output);
                      } catch {
                        return String(tr.output);
                      }
                    })();
              const trTs = typeof evt.ts === "number" ? evt.ts : Date.now();
              messages.appendToolResult(
                chatId,
                runId,
                tr.tool_call_id,
                outText,
                tr.is_error,
                trTs,
              );
              emit("chat.tool_result", {
                chat_id: chatId,
                run_id: runId,
                tool_call_id: tr.tool_call_id,
                output: tr.output,
                is_error: tr.is_error,
              });
            }
          }
        }
        if (firstAssistantSeen && !cancelRequested.has(runId)) {
          // VOS-80 (a): persist assistant row + derive last_msg from same
          // text in one logical write. last_msg is now derived from the
          // canonical messages row (single source of truth) — the explicit
          // setLastMsg call below preserves the 200-char preview shape so
          // existing list-view consumers don't break.
          if (lastAssistantText) {
            messages.appendAssistant(
              chatId,
              runId,
              lastAssistantText,
              Date.now(),
            );
            repo.setLastMsg(chatId, lastAssistantText.slice(0, 200));
          }
        }
      } catch (err) {
        // VOS-80 S5: a cancel may race with the iterator throwing (e.g.
        // spawner-iter propagates "cancelled" sentinel via throw). When
        // cancelRequested is set for this run, the error path was caused
        // by cancel — don't surface it as run.error.
        if (cancelRequested.has(runId)) {
          // swallowed: finally block handles status="cancelled" + run.end
        } else {
          status = "error";
          errorMessage = err instanceof Error ? err.message : String(err);
          emit("run.error", {
            chat_id: chatId,
            run_id: runId,
            error: errorMessage,
          });
        }
      } finally {
        // VOS-80 S5: cancel-late override. The cancel signal can land any
        // time during dispatch; finally is the single point where we know
        // the run is over and can stamp the terminal status correctly.
        // Persist whatever assistant text was streamed before the bail so
        // mid-stream interrupts don't drop visible tokens.
        if (cancelRequested.has(runId)) {
          status = "cancelled";
          errorMessage = null;
        }
        // VOS-80 (a): non-happy terminal (cancel or error) — flush partial
        // assistant text into the canonical messages table BEFORE run.end
        // is broadcast. The happy path already did this in the try-block;
        // here we cover the two failure modes where that branch was skipped.
        //
        // VOS-80 stopped-badge fix (b): on CANCEL we ALWAYS persist an
        // assistant row — even with empty content — so the LEFT JOIN in
        // messages-repo.walk() can stamp `cancelled: true` on a concrete
        // row. Without this, ESC-before-first-token loses its "↯ stopped"
        // badge on chat-switch / remount (refetch returns only the user
        // prompt, no cancelled marker). Empty content renders as
        // STOPPED_MARKER on the plugin via toThreadMessage. We do NOT do
        // this for the error path: an error before any tokens stream
        // should NOT inject a phantom empty assistant row into history;
        // the errorNotice surface in the plugin handles that case.
        if (status === "cancelled") {
          messages.appendAssistant(
            chatId,
            runId,
            lastAssistantText,
            Date.now(),
          );
          if (lastAssistantText) {
            repo.setLastMsg(chatId, lastAssistantText.slice(0, 200));
          }
        } else if (status === "error" && lastAssistantText) {
          messages.appendAssistant(
            chatId,
            runId,
            lastAssistantText,
            Date.now(),
          );
          repo.setLastMsg(chatId, lastAssistantText.slice(0, 200));
        }
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
        // Drop cancel-request flag — run is terminal, no further bail needed.
        cancelRequested.delete(runId);
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
