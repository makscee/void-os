// orchestrator — per VOS-79 plan (2026-05-14-vos-79-chat-lifecycle-endpoints.md), Task 7.
//
// Responsibilities:
//   1. Acquire the per-chat lock by reading + setting chats.current_run_id
//      inside a single txn. If a non-terminal run already holds it, throw
//      Conflict409. Stale terminal current_run_id pointers (e.g. from a
//      crashed run that never cleared the lock) do NOT block new dispatch.
//   2. Insert a runs row (status='running') as part of the same txn so the
//      lock + run row are committed atomically.
//   3. Spawn the underlying claudev process via an injected Provider.
//      The Provider contract here is intentionally narrow — `ProviderHandle`
//      with an async-iterable events stream — so tests can mock it and so
//      the real claude-code Provider can be composed by the wiring layer
//      without this module depending on Bun.spawn, bus subscriptions, or fs.
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
import { type ChatRepo, openTaskFor, setTaskState } from "./repo";
import { makeMessagesRepo, type MessagesRepo } from "./messages-repo";
import type { Part, DataPart } from "../types/a2a";

import type { Provider, ProviderHandle } from "../providers/index.ts";
import { drainRun, mergeAdjacentText } from "./run-driver.ts";
import { setPendingAskUserToolUseId } from "./ask-user-pending-registry.ts";

export interface TitlerLike {
  title(chatId: string): Promise<void>;
}

export interface OrchestratorDeps {
  db: Database;
  repo: ChatRepo;
  provider: Provider;
  cwd: string;
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

/** VOS-89 T11: child task reached a terminal state → if its parent was
 * parked in WAITING_ON_AGENT, flip the parent back to WORKING so its run
 * can resume. No-op when:
 *   - the child has no parent_task_id (top-level task), or
 *   - the parent is in any state other than WAITING_ON_AGENT (e.g. it was
 *     itself cancelled or completed independently — we never resurrect).
 *
 * Idempotent: the UPDATE's WHERE clause guards the state predicate, so
 * repeated emits of the same terminal state are safe. Mirrors the
 * INPUT_REQUIRED → WORKING resume done inline in `dispatch()` (the user-
 * reply path); here the trigger is a sibling task reaching terminal
 * rather than a user POST.
 *
 * VOS-89 T15.5: after the WAITING→WORKING flip, attempt to settle the
 * parent's terminal state. If the parent's chat has no active run AND no
 * non-terminal children remain, the parent's lifecycle is over — flip it
 * to COMPLETED. Covers the case where the run already ended (provider
 * stream drained) before the child finished, so run.end's own attempt at
 * the COMPLETED flip rejected (parent was still WAITING). When the child
 * later terminates, this branch closes the loop. */
export function resumeParentOnChildTerminal(
  db: Database,
  childTaskId: string,
  emit?: (type: string, payload: Record<string, unknown>) => void,
): void {
  const child = db
    .query("SELECT parent_task_id FROM tasks WHERE id = ?")
    .get(childTaskId) as { parent_task_id: string | null } | undefined;
  if (!child?.parent_task_id) return;
  db.run(
    `UPDATE tasks
     SET state = 'TASK_STATE_WORKING', updated_at = strftime('%s','now')
     WHERE id = ? AND state = 'TASK_STATE_WAITING_ON_AGENT'`,
    [child.parent_task_id],
  );
  // Try to settle the parent. Only fires when the parent's chat has no
  // current_run_id (i.e. the run has already cleaned up) AND no children
  // remain non-terminal. Both predicates are evaluated by the helper.
  const completed = tryCompleteParentTaskIfRunEnded(db, child.parent_task_id);
  if (completed && emit) {
    emit("task.state_changed", {
      taskId: child.parent_task_id,
      state: "TASK_STATE_COMPLETED",
    });
  }
}

/** VOS-89 T15.5: terminal task-state flip on run.end. CAS-guarded so:
 *  - WORKING + no non-terminal children → flip to `terminal`
 *  - any other state (INPUT_REQUIRED, WAITING_ON_AGENT, CANCELED, ...) →
 *    no-op. The parent stays parked until its waiter (user / child)
 *    resolves; the resume hook will retry the flip then.
 *
 *  We exclude tasks that have non-terminal children even if status==done.
 *  This guards the rare race where a child is dispatched mid-stream but
 *  the orchestrator's run.end fires before the child terminates — the
 *  parent should not COMPLETE while a child is still running. (Today the
 *  parent would already be WAITING_ON_AGENT in that case, so the state
 *  predicate alone catches it; the children-check is a defensive belt-
 *  and-braces.) */
function tryCompleteTaskOnRunEnd(
  db: Database,
  taskId: string,
  terminal: "TASK_STATE_COMPLETED" | "TASK_STATE_FAILED" | "TASK_STATE_CANCELED",
): boolean {
  const res = db.run(
    `UPDATE tasks
        SET state = ?, updated_at = strftime('%s','now')
      WHERE id = ?
        AND state = 'TASK_STATE_WORKING'
        AND NOT EXISTS (
          SELECT 1 FROM tasks ch
           WHERE ch.parent_task_id = tasks.id
             AND ch.state NOT IN (
               'TASK_STATE_COMPLETED',
               'TASK_STATE_FAILED',
               'TASK_STATE_CANCELED'
             )
        )`,
    [terminal, taskId],
  );
  return res.changes > 0;
}

/** VOS-89 T15.5: settle the parent task to COMPLETED after a child wakeup
 *  IF the parent's chat has no active run AND all children are terminal.
 *  Skips when the chat still has a current_run_id (run is in flight; the
 *  orchestrator's own finally block will handle the flip on run.end). */
function tryCompleteParentTaskIfRunEnded(
  db: Database,
  parentTaskId: string,
): boolean {
  // Post-0016 `current_run_id` lives on the root Task of the context, not on
  // `contexts`. "Chat has an active run" = the context's root Task holds a
  // current_run_id pointer.
  const ctx = db
    .query(
      `SELECT root.current_run_id AS current_run_id
         FROM tasks t
         JOIN tasks root
           ON root.id = (
                SELECT id FROM tasks
                 WHERE context_id = t.context_id AND parent_task_id IS NULL
                 ORDER BY created_at ASC LIMIT 1
              )
        WHERE t.id = ?`,
    )
    .get(parentTaskId) as { current_run_id: string | null } | undefined;
  if (!ctx) return false;
  if (ctx.current_run_id !== null) return false;
  return tryCompleteTaskOnRunEnd(db, parentTaskId, "TASK_STATE_COMPLETED");
}

/** VOS-89 T12: cancel-cascade. Walks the task tree under `rootTaskId`
 * (recursive CTE on `tasks.parent_task_id`) and flips every NON-terminal
 * descendant to TASK_STATE_CANCELED in a SINGLE transaction. The root
 * itself is left untouched — callers cancel it separately (e.g. via
 * `orch.cancel(chatId)` to terminate any in-flight provider handle).
 *
 * Terminal states (COMPLETED / FAILED / CANCELED) are excluded from the
 * sweep — once a child has finished on its own, we never overwrite its
 * outcome. Returns the ids that were actually cancelled, in CTE traversal
 * order (parent-before-child by depth).
 *
 * Wiring: NOT yet plumbed into a higher-level cancel entry-point —
 * `orch.cancel(chatId)` only kills the in-flight run / provider handle,
 * it does not currently reach into the task tree. A future task should
 * call `cascadeCancel` after that flip and emit `task.state_changed` per
 * returned id so the resume listener (app.ts T11) can react.
 *
 * No emit happens here: this helper is DB-only by design (mirrors
 * `resumeParentOnChildTerminal`). The caller owns event emission so the
 * helper stays unit-testable without a bus. */
export function cascadeCancel(db: Database, rootTaskId: string): string[] {
  const cancelled: string[] = [];
  const tx = db.transaction(() => {
    // Recursive CTE collects every non-terminal descendant of `rootTaskId`.
    // The base case is direct children (parent_task_id = root); the
    // recursive step extends through the tree. The root itself is excluded
    // by starting the CTE from `parent_task_id = ?` rather than `id = ?`.
    const rows = db
      .query(
        `WITH RECURSIVE descendants(id, state) AS (
           SELECT id, state FROM tasks WHERE parent_task_id = ?
           UNION ALL
           SELECT t.id, t.state
             FROM tasks t
             JOIN descendants d ON t.parent_task_id = d.id
         )
         SELECT id FROM descendants
          WHERE state NOT IN (
            'TASK_STATE_COMPLETED',
            'TASK_STATE_FAILED',
            'TASK_STATE_CANCELED'
          )`,
      )
      .all(rootTaskId) as Array<{ id: string }>;
    if (rows.length === 0) return;
    const update = db.prepare(
      `UPDATE tasks
         SET state = 'TASK_STATE_CANCELED', updated_at = strftime('%s','now')
       WHERE id = ?
         AND state NOT IN (
           'TASK_STATE_COMPLETED',
           'TASK_STATE_FAILED',
           'TASK_STATE_CANCELED'
         )`,
    );
    for (const r of rows) {
      const info = update.run(r.id);
      // changes==1 only when the row was still non-terminal at UPDATE time.
      // Within a single tx no concurrent writer exists, so this matches the
      // SELECT 1:1 — but we honour the actual UPDATE result to be safe.
      if (info.changes > 0) cancelled.push(r.id);
    }
  });
  tx();
  return cancelled;
}

/** VOS-170: durable parent-resume sweep (ADR-0008).
 *
 * The in-memory event bus is the fast-path wake hint; it does not survive a
 * daemon restart. If the daemon dies while a child Task is running, the
 * child's terminal state still lands in `tasks` (the durable queue), but the
 * parent — parked in WAITING_ON_AGENT — is never woken: the in-memory
 * `task.state_changed` that would have driven `resumeParentOnChildTerminal`
 * is gone, AND the parent's own CC subprocess died with the daemon, so even
 * the flip-to-WORKING done by the old reconciler left a parent that was
 * WORKING-but-dead — no live session to receive the child result.
 *
 * This sweep closes the hole. The wake condition is a pure DB query (ADR-0008
 * §Decision point 2): a parent in WAITING_ON_AGENT whose children have ALL
 * reached a terminal state is ready to resume. For each such parent it:
 *
 *   1. CAS-flips WAITING_ON_AGENT -> WORKING (idempotent; the WHERE predicate
 *      rejects an already-flipped row).
 *   2. Re-drives the parent: re-spawns its Claude session (`resumeFrom =
 *      tasks.session_id`) with the child's terminal output as the next Brief
 *      message — ADR-0008 §"The notification's content is also durable".
 *
 * Idempotency: a re-drive sets the parent's `current_run_id`; the SELECT
 * skips any parent that already holds a non-terminal `current_run_id`, so a
 * second sweep (or the periodic tick) never double-fires a resume.
 *
 * Runs at boot AFTER buildApp (it needs a provider-backed re-driver), unlike
 * `reconcileOrphans` which is DB-only and runs pre-buildApp. Safe to call
 * repeatedly — exposed for an optional slow periodic tick.
 *
 * `redrive` is injected (the `makeRedriveParentTask` dispatcher in
 * dispatch-child.ts) so this function stays unit-testable with a stub. */
export function reconcileWaitingParents(
  db: Database,
  redrive: (
    parentTaskId: string,
    args: { agentName: string; message: string; resumeFrom?: string },
  ) => Promise<void>,
): number {
  // Eligible = parent in WAITING_ON_AGENT, has >=1 child, ALL children
  // terminal, and not already holding a live run (idempotency guard).
  const parents = db
    .query(
      `SELECT id, agent, session_id
         FROM tasks p
        WHERE p.state = 'TASK_STATE_WAITING_ON_AGENT'
          AND EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = p.id)
          AND NOT EXISTS (
            SELECT 1 FROM tasks c
             WHERE c.parent_task_id = p.id
               AND c.state NOT IN (
                 'TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED'
               )
          )
          AND (
            p.current_run_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM runs r
               WHERE r.id = p.current_run_id
                 AND r.status IN ('pending','running')
            )
          )`,
    )
    .all() as Array<{ id: string; agent: string | null; session_id: string | null }>;

  let resumed = 0;
  for (const parent of parents) {
    // CAS flip — re-guarded so a concurrent writer (or a racing periodic
    // tick) cannot double-process. changes==0 means another path won.
    const flip = db.run(
      `UPDATE tasks
          SET state = 'TASK_STATE_WORKING', updated_at = strftime('%s','now')
        WHERE id = ? AND state = 'TASK_STATE_WAITING_ON_AGENT'`,
      [parent.id],
    );
    if (flip.changes === 0) continue;

    // Compose the resume message from every child's terminal outcome — this
    // is the "child output as next Brief message" the parent's session needs.
    const message = composeChildResumeMessage(db, parent.id);
    const agentName = parent.agent ?? "";
    void redrive(parent.id, {
      agentName,
      message,
      resumeFrom: parent.session_id ?? undefined,
    }).catch(() => {
      // redrive owns its own terminal-state handling + error surfacing
      // (mirrors dispatch-child's outer catch). A throw here must not abort
      // the sweep of the remaining parents.
    });
    resumed += 1;
  }
  return resumed;
}

/** VOS-170: build the Brief message that re-drives a parked parent. Folds
 *  every child Task's terminal state + final assistant text into a single
 *  prompt so the resumed parent session sees what its delegates produced.
 *  Child rows are ordered by created_at so a parent that fired N children
 *  reads them dispatch-order. */
function composeChildResumeMessage(db: Database, parentTaskId: string): string {
  const children = db
    .query(
      `SELECT id, state, target_agent FROM tasks
        WHERE parent_task_id = ? ORDER BY created_at ASC`,
    )
    .all(parentTaskId) as Array<{
    id: string;
    state: string;
    target_agent: string | null;
  }>;
  const parts: string[] = [];
  for (const c of children) {
    const agent = c.target_agent ?? "agent";
    if (c.state === "TASK_STATE_COMPLETED") {
      const row = db
        .query(
          `SELECT parts_text FROM messages
            WHERE task_id = ? AND role = 'ROLE_AGENT' AND parts_text != ''
            ORDER BY ts DESC, ord DESC LIMIT 1`,
        )
        .get(c.id) as { parts_text: string | null } | undefined;
      const text =
        row && row.parts_text && row.parts_text.length > 0
          ? row.parts_text
          : "(no message)";
      parts.push(`Delegated agent "${agent}" completed:\n${text}`);
    } else if (c.state === "TASK_STATE_FAILED") {
      let detail = "unknown";
      const metaRow = db
        .query("SELECT metadata FROM tasks WHERE id = ?")
        .get(c.id) as { metadata: string | null } | undefined;
      if (metaRow?.metadata) {
        try {
          const parsed = JSON.parse(metaRow.metadata) as Record<string, unknown>;
          if (typeof parsed.errorMessage === "string") detail = parsed.errorMessage;
        } catch {
          /* malformed metadata — keep "unknown" */
        }
      }
      parts.push(`Delegated agent "${agent}" failed: ${detail}`);
    } else {
      // CANCELED
      parts.push(`Delegated agent "${agent}" was cancelled.`);
    }
  }
  const body = parts.join("\n\n---\n\n");
  return (
    "Your delegated agent task(s) finished while this session was offline. " +
    "Continue from their result(s) below.\n\n" +
    body
  );
}

/** VOS-89 T13: startup reconciler — cancel-cascade orphan cleanup.
 *
 * Daemon may crash mid-flight while an ancestor was already CANCELED but a
 * descendant was still WORKING (the runtime cascade had not finished, or the
 * cancel reached only the in-flight provider handle without reaching the task
 * tree) — descendants would orphan-run forever once the daemon is back.
 *
 * `reconcileOrphans(db)` is called at boot, before the MCP server starts
 * accepting connections: a recursive CTE rooted at every CANCELED task
 * descending via parent_task_id flips every non-terminal descendant to
 * CANCELED.
 *
 * VOS-170: the WAITING_ON_AGENT parent-resume class is NO LONGER handled
 * here. A bare flip-to-WORKING is not a resume — the parent's CC subprocess
 * died with the daemon, so it must be re-spawned, which needs a provider.
 * `reconcileWaitingParents` (run after buildApp) owns that class now;
 * `reconcileOrphans` stays DB-only + pre-buildApp for the cancel cascade.
 *
 * Idempotent: re-running on an already-reconciled DB is a no-op (the UPDATE
 * is guarded by a state predicate that rejects already-correct rows).
 * DB-only by design — emits no events. */
export function reconcileOrphans(db: Database): void {
  const tx = db.transaction(() => {
    // Recursive CTE: descend from every CANCELED root through
    // parent_task_id chains and cancel any non-terminal descendant.
    // Base case = direct children of any CANCELED task; recursive step
    // extends down. The CTE only carries non-terminal rows so we never
    // descend into / overwrite a subtree whose ancestor already finished
    // independently (terminal states are preserved). Final UPDATE is
    // re-guarded by the same predicate for defence-in-depth.
    db.run(
      `WITH RECURSIVE orphans(id) AS (
         SELECT t.id
           FROM tasks t
           JOIN tasks p ON t.parent_task_id = p.id
          WHERE p.state = 'TASK_STATE_CANCELED'
            AND t.state NOT IN (
              'TASK_STATE_COMPLETED',
              'TASK_STATE_FAILED',
              'TASK_STATE_CANCELED'
            )
         UNION ALL
         SELECT t.id
           FROM tasks t
           JOIN orphans o ON t.parent_task_id = o.id
          WHERE t.state NOT IN (
            'TASK_STATE_COMPLETED',
            'TASK_STATE_FAILED',
            'TASK_STATE_CANCELED'
          )
       )
       UPDATE tasks
          SET state = 'TASK_STATE_CANCELED', updated_at = strftime('%s','now')
        WHERE id IN (SELECT id FROM orphans)
          AND state NOT IN (
            'TASK_STATE_COMPLETED',
            'TASK_STATE_FAILED',
            'TASK_STATE_CANCELED'
          )`,
    );
  });
  tx();
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
  const { db, repo, provider, cwd, emit, titler } = deps;
  // VOS-80 architecture (a): canonical messages store. Wired off the same
  // db handle as `repo`, so all persistence shares one connection (and
  // therefore the same per-statement txn semantics). Constructed lazily
  // per orchestrator so tests with multiple orchestrators don't share state.
  const messages: MessagesRepo = makeMessagesRepo(db);

  // Per-run cancel registry. Registered per-dispatch, aborted on cancel,
  // deleted on run end. Populated by dispatch() at run.start time and
  // consulted in both the streaming loop (after-yield bail) and the finally
  // block (status="cancelled" instead of "done"). `cancel(chatId)` looks
  // up the current_run_id, aborts the controller, and calls handle.cancel()
  // on the live ProviderHandle — so the subprocess receives SIGTERM/SIGKILL
  // and the for-await loop unblocks. Cleared on run end.
  const cancelControllers = new Map<string, AbortController>();
  const isCancelled = (runId: string) =>
    cancelControllers.get(runId)?.signal.aborted === true;
  // Active handles keyed by runId so cancel(chatId) can reach them.
  const activeHandles = new Map<string, ProviderHandle>();

  return {
    async cancel(chatId) {
      const chat = repo.get(chatId);
      if (!chat || !chat.current_run_id) {
        return { cancelled: false, run_id: null };
      }
      const runId = chat.current_run_id;
      if (isCancelled(runId)) {
        // Already cancelled in flight — return the run_id so callers can
        // log it, but cancelled=false flags this as a duplicate (the HTTP
        // layer still surfaces it as 200 only if the run was *just* terminated;
        // subsequent calls after the run finishes hit the no-current_run_id
        // branch above and return cancelled=false). The flag-already-set
        // case is rare (concurrent cancel requests) — treat it as "yes, the
        // first one already took effect" so the second call is idempotent.
        return { cancelled: true, run_id: runId };
      }
      let ctrl = cancelControllers.get(runId);
      if (!ctrl) {
        ctrl = new AbortController();
        cancelControllers.set(runId, ctrl);
      }
      ctrl.abort();
      // Best-effort: signal the underlying provider handle if one is active.
      // If the handle is absent (run already ended), the flag still ensures
      // the finally block stamps status="cancelled".
      const handle = activeHandles.get(runId);
      if (handle) {
        handle.cancel().catch(() => false);
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

      // VOS-83 mig-0007: every chat has an open task minted by repo.create.
      // The orchestrator attributes each turn's messages + state-flips to it.
      const taskId = openTaskFor(db, chatId);
      // Per-turn parts buffer for the AGENT message. Hoisted outside try so
      // the finally branches (cancel / error) see partial buffer on throw.
      const agentParts: Part[] = [];
      // Resuming user message: flip state back to WORKING (a previous turn
      // may have left this task in INPUT_REQUIRED waiting for input).
      setTaskState(db, taskId, "TASK_STATE_WORKING");

      // VOS-80 (a): persist the user prompt immediately — before spawning CC.
      // GET /chat/:id/messages reads from the messages table, so the user
      // turn must be visible the moment dispatch is accepted.
      messages.appendMessage(
        taskId,
        chatId,
        runId,
        "ROLE_USER",
        [{ text } as Part],
        startedAt,
      );

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
        const handle = provider.spawn({
          runId,
          prompt: text,
          cwd,
          // VOS-96 T10 (ADR-0001 §Decision): chatId folded into contextId on
          // the provider boundary. CC provider passes contextId through to
          // the spawner's chat_id arg; fake provider uses taskId+contextId
          // for vos_ask_user MCP correlation. No cast: ProviderSpawnRequest
          // requires both fields after T10.
          taskId,
          contextId: chatId,
          // VOS-124: forward the chat's agent so providers write the correct
          // identity into turn.start.payload.agent (req.agent takes precedence
          // over the provider's static opts.agent).
          agent: chat.agent,
          resumeFrom: chat.session_id ?? undefined,
        });
        let cancelController = cancelControllers.get(runId);
        if (!cancelController) {
          cancelController = new AbortController();
          cancelControllers.set(runId, cancelController);
        }
        const cancelSignal = cancelController.signal;
        activeHandles.set(runId, handle);

        await drainRun({
          handle,
          signal: cancelSignal,
          agentName: chat.agent,
          onSession: (sid) => {
            // Double gate: in-memory boolean + the IS NULL check on the
            // canonical row. Across runs (--resume), claudev re-emits the
            // same id; we still want this branch to no-op.
            if (!sessionCaptured && chat.session_id === null) {
              repo.setSession(chatId, sid);
              sessionCaptured = true;
            }
          },
          onPart: ({ parts, frameText, role }) => {
            if (role === "ROLE_AGENT") firstAssistantSeen = true;
            for (const p of parts) {
              agentParts.push(p); // ROLE_AGENT buffer — survives drainRun throws
              const data = (p as DataPart).data;
              if (!data || typeof data !== "object") continue;
              const kind = (data as { kind?: unknown }).kind;
              if (kind === "tool_use") {
                const toolCallId = (data as { tool_call_id?: string }).tool_call_id;
                const toolName = (data as { tool_name?: string }).tool_name;
                // VOS-147: stash CC's toolu_* id so the upcoming MCP
                // tools/call for ask_user uses it as the bridge slot id.
                // Without this, /answer first-try 409s because the plugin
                // posts CC's id but the bridge stored a random UUID.
                if (
                  typeof toolCallId === "string" &&
                  (toolName === "ask_user" || toolName === "mcp__void-os__ask_user")
                ) {
                  setPendingAskUserToolUseId(taskId, runId, toolCallId);
                }
                emit("chat.tool_use", {
                  chat_id: chatId,
                  run_id: runId,
                  tool_call_id: toolCallId,
                  name: toolName,
                  input: (data as { input?: unknown }).input,
                });
              } else if (kind === "tool_result") {
                emit("chat.tool_result", {
                  chat_id: chatId,
                  run_id: runId,
                  tool_call_id: (data as { tool_call_id?: string }).tool_call_id,
                  output: (data as { output?: unknown }).output,
                  is_error: (data as { is_error?: unknown }).is_error === true,
                });
              }
            }
            if (frameText) {
              // Preserved invariant: frame with no TextParts emits no chat.token.
              // Plugin S4 token stream depends on this.
              lastAssistantText += frameText;
              emit("chat.token", {
                chat_id: chatId,
                run_id: runId,
                delta: frameText,
              });
            }
          },
        });

        activeHandles.delete(runId);

        // Happy-path write: preserves orchestrator.ts:558 gate exactly.
        if (firstAssistantSeen && !isCancelled(runId)) {
          // VOS-83 mig-0007: flush buffered parts ONCE per turn (single
          // appendMessage). last_msg preview is now derived from messages
          // by repo.list(); setLastMsg is retained only for the updated_at
          // bump (used by list ordering).
          //
          // VOS-142: ask_user tool_use/result rows are already persisted
          // separately by ask-user-bridge (with its own UUID tool_call_id
          // and the bare `ask_user` tool name — kept for the ChatList
          // preview during pause, per VOS-104 T8b). Re-flushing them here
          // would produce a second, parallel row with CC's `toolu_*` id
          // and the raw `mcp__void-os__ask_user` name, and the plugin
          // would render both as duplicate `answered:` blocks. Drop them
          // from the flush; bridge's rows remain canonical for ask_user.
          const askUserIds = new Set<string>();
          for (const p of agentParts) {
            const d = (p as DataPart).data as
              | { kind?: string; tool_name?: string; tool_call_id?: string }
              | undefined;
            if (
              d?.kind === "tool_use" &&
              (d.tool_name === "ask_user" || d.tool_name === "mcp__void-os__ask_user") &&
              typeof d.tool_call_id === "string"
            ) {
              askUserIds.add(d.tool_call_id);
            }
          }
          const filteredParts =
            askUserIds.size === 0
              ? agentParts
              : agentParts.filter((p) => {
                  const d = (p as DataPart).data as
                    | { kind?: string; tool_call_id?: string }
                    | undefined;
                  if (!d || (d.kind !== "tool_use" && d.kind !== "tool_result")) return true;
                  return typeof d.tool_call_id !== "string" || !askUserIds.has(d.tool_call_id);
                });
          const flushed = mergeAdjacentText(filteredParts);
          if (flushed.length > 0) {
            messages.appendMessage(
              taskId,
              chatId,
              runId,
              "ROLE_AGENT",
              flushed,
              Date.now(),
            );
            if (lastAssistantText) {
              repo.setLastMsg(chatId, lastAssistantText.slice(0, 200));
            }
          }
        }
      } catch (err) {
        activeHandles.delete(runId);
        // VOS-80 S5: a cancel may race with the iterator throwing (e.g.
        // spawner-iter propagates "cancelled" sentinel via throw). When
        // isCancelled(runId) is true for this run, the error path was caused
        // by cancel — don't surface it as run.error.
        if (isCancelled(runId)) {
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
        if (isCancelled(runId)) {
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
          // STOPPED_MARKER invariant: ALWAYS write a row on cancel, even empty,
          // so messages-repo.walk()'s LEFT JOIN can stamp `cancelled: true`.
          // Empty parts render as STOPPED_MARKER on the plugin.
          const flushed = mergeAdjacentText(agentParts);
          messages.appendMessage(
            taskId,
            chatId,
            runId,
            "ROLE_AGENT",
            flushed,
            Date.now(),
          );
          if (lastAssistantText) {
            repo.setLastMsg(chatId, lastAssistantText.slice(0, 200));
          }
        } else if (status === "error" && agentParts.length > 0) {
          const flushed = mergeAdjacentText(agentParts);
          messages.appendMessage(
            taskId,
            chatId,
            runId,
            "ROLE_AGENT",
            flushed,
            Date.now(),
          );
          if (lastAssistantText) {
            repo.setLastMsg(chatId, lastAssistantText.slice(0, 200));
          }
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
        // VOS-89 T15.5: settle the task's terminal state. CAS-guarded:
        // only flips when the task is in WORKING with no non-terminal
        // children. If the task is parked in INPUT_REQUIRED or
        // WAITING_ON_AGENT, this is a no-op — the corresponding wakeup
        // path (answer route / resumeParentOnChildTerminal) will retry
        // the flip when the wait resolves.
        const terminalState =
          status === "done"
            ? "TASK_STATE_COMPLETED"
            : status === "error"
              ? "TASK_STATE_FAILED"
              : "TASK_STATE_CANCELED";
        try {
          const flipped = tryCompleteTaskOnRunEnd(db, taskId, terminalState);
          if (flipped) {
            emit("task.state_changed", {
              taskId,
              state: terminalState,
            });
          }
        } catch (taskFlipErr) {
          emit("task.terminal_flip_failed", {
            chat_id: chatId,
            run_id: runId,
            task_id: taskId,
            error:
              taskFlipErr instanceof Error
                ? taskFlipErr.message
                : String(taskFlipErr),
          });
        }
        // VOS-87 T4: stamp task_id on the WebSocket envelope so UI
        // clients can scope cost rollups to the right task without a
        // second round-trip. The cost subscriber lives on the bus and
        // is fed by the cc-spawner's run.end (full RunEndPayload); this
        // emit is the WebSocket fan-out only and keeps its existing
        // snake_case envelope shape. Additive — existing consumers
        // ignore the new field.
        emit("run.end", {
          chat_id: chatId,
          run_id: runId,
          status,
          error: errorMessage,
          task_id: taskId,
        });
        // Drop cancel-request flag — run is terminal, no further bail needed.
        cancelControllers.delete(runId);
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
