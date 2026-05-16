// VOS-89 T15.5: production dispatchChildTask wiring.
//
// Closes the seam left by T10/T11: production buildApp wires mountMcp
// without a real `dispatchChildTask`, so the placeholder in
// adapters/mcp/index.ts logs a warning and returns. As a result the
// freshly-minted child task row never runs, never reaches a terminal
// state, and the parent (parked in WAITING_ON_AGENT) never resumes.
//
// This module supplies a real dispatcher. Its contract:
//   - input: childTaskId + { agentName, message, systemMessage? }
//   - kicks the work onto the next microtask so the ask_agent handler's
//     post-dispatch DB recheck (step 9) gets a beat to settle before
//     state changes
//   - per-agent provider memoisation (one Provider per agent) keyed by
//     agentName, so repeated children for the same agent reuse one
//     Provider/factory call rather than re-resolving env+SDK each time
//   - drains the provider stream into the canonical messages table
//     against the child task's existing row (the row was inserted by
//     mintChildAndFlipParent in SUBMITTED state)
//   - flips child SUBMITTED → WORKING at start, then either
//     COMPLETED on a clean drain or FAILED on a thrown error
//   - emits task.state_changed so:
//       (a) the parent-resume listener (app.ts T11 wiring) flips the
//           parent back to WORKING (and possibly all the way to COMPLETED
//           via the T15.5 settle-on-resume helper)
//       (b) the ask_agent waiter (waitForChildTerminal) in the ask_agent
//           handler resolves and translates the terminal state into an
//           MCP tool result
//
// Why not reuse `orchestrator.dispatch(chatId, text)`? The orchestrator's
// dispatch unit is a chat: it acquires a per-chat lock via
// chats.current_run_id, mints its own task row (`openTaskFor`), inserts a
// run row, persists a user message, and runs a titler. Children are NOT
// chats — they're standalone task rows under the parent's context, with
// no run row, no chat lock, and no titler. So we do the minimal slice of
// the orchestrator that's relevant to a child task: spawn provider,
// drain events into messages, flip terminal state.

import type { Database } from "bun:sqlite";
import type { EventBus } from "../events/index.ts";
import type { Provider, ProviderHandle } from "../providers/index.ts";
import { makeProvider, type ProviderEnv } from "../providers/factory.ts";
import { makeMessagesRepo, type MessagesRepo } from "./messages-repo.ts";
import { drainRun } from "./run-driver.ts";
import type { TextPart, DataPart } from "../types/a2a.ts";

export interface DispatchChildDeps {
  db: Database;
  bus: EventBus;
  /** Vault root, used as cwd for child providers. Mirrors orchestrator's
   *  `cwd` argument; pulled from BuildAppDeps.vaultRoot at wire-up. */
  cwd: string;
  /** tracesDir for the claude-code provider; mirrors buildApp wiring. */
  tracesDir: string;
  /** Process env, threaded through so VOS_PROVIDER + VOS_FAKE_SCRIPT_<agent>
   *  fall-through works for fake-provider integration tests. */
  env?: ProviderEnv;
  /** Override Provider construction. Tests inject a stub here to skip the
   *  real claude-code/fake factory call. */
  buildProvider?: (agentName: string) => Provider;
  /** WS fan-out helper. Defaults to module-level broadcast() in buildApp,
   *  overridable from tests. Mirrors orchestrator's deps.emit. */
  emit?: (type: string, payload: Record<string, unknown>) => void;
}

export type DispatchChildFn = (
  childTaskId: string,
  args: { agentName: string; message: string; systemMessage?: string },
) => Promise<void>;

/**
 * Build the production dispatcher. Memoises one Provider per agentName for
 * the lifetime of the daemon process; the Provider's spawn() returns a
 * fresh ProviderHandle per child invocation.
 */
export function makeDispatchChildTask(deps: DispatchChildDeps): DispatchChildFn {
  const messages = makeMessagesRepo(deps.db);
  const providerByAgent = new Map<string, Provider>();
  // Default to no-op so tests that don't inject emit still work.
  // In production, buildApp always passes its local `emit` (= broadcast)
  // explicitly to avoid a circular import between dispatch-child ↔ app.
  const emit = deps.emit ?? ((_type: string, _payload: Record<string, unknown>) => {});

  const buildProvider =
    deps.buildProvider ??
    ((agentName: string): Provider =>
      makeProvider(deps.env ?? (process.env as ProviderEnv), {
        bus: deps.bus,
        db: deps.db,
        tracesDir: deps.tracesDir,
        agent: agentName,
        cwd: deps.cwd,
      }));

  const providerFor = (agentName: string): Provider => {
    let p = providerByAgent.get(agentName);
    if (p) return p;
    p = buildProvider(agentName);
    providerByAgent.set(agentName, p);
    return p;
  };

  return (childTaskId, args) =>
    new Promise<void>((resolve) => {
      // Resolve the ask_agent handler BEFORE the child runs (microtask
      // boundary). The handler does a post-dispatch state recheck
      // immediately after awaiting this promise; firing the actual
      // provider work on the next microtask gives that recheck a chance
      // to settle to a non-terminal value first, which exercises the
      // bus-await path rather than the synchronous-terminal short-circuit.
      queueMicrotask(() => {
        runChildOnProvider({
          db: deps.db,
          bus: deps.bus,
          messages,
          provider: providerFor(args.agentName),
          childTaskId,
          message: args.message,
          cwd: deps.cwd,
          emit,
        }).catch((err) => {
          // The runner already flips the child to FAILED + emits
          // task.state_changed in its catch path. This outer catch is a
          // last-ditch guard for unexpected throws OUTSIDE that path
          // (e.g. messages-repo writes failing). Surface via bus so
          // operators can see it; do NOT rethrow into a void-promise.
          deps.bus.emit({
            type: "child.dispatch_error",
            payload: {
              child_task_id: childTaskId,
              agent_name: args.agentName,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        });
      });
      resolve();
    });
}

interface RunChildArgs {
  db: Database;
  bus: EventBus;
  messages: MessagesRepo;
  provider: Provider;
  childTaskId: string;
  message: string;
  /** Vault-aware cwd threaded from DispatchChildDeps. Passed to
   *  provider.spawn so the child runs in the same working directory as
   *  the parent (mirrors orchestrator wiring), NOT a hardcoded "/tmp". */
  cwd: string;
  /** WS fan-out helper threaded from DispatchChildDeps. Used to emit
   *  chat.token / chat.tool_use / chat.tool_result frames per provider part. */
  emit: (type: string, payload: Record<string, unknown>) => void;
}

async function runChildOnProvider(args: RunChildArgs): Promise<void> {
  const { db, bus, messages, provider, childTaskId, message, cwd, emit } = args;
  const childRunId = "child-" + childTaskId;

  const ctxRow = db
    .query("SELECT context_id FROM tasks WHERE id = ?")
    .get(childTaskId) as { context_id: string } | undefined;
  if (!ctxRow) throw new Error(`child task not found: ${childTaskId}`);
  const contextId = ctxRow.context_id;

  // Flip SUBMITTED → WORKING. The mint inserted with SUBMITTED so the
  // pre-dispatch state is observable; flipping to WORKING here marks the
  // moment provider work starts. Use raw UPDATE — setTaskState is
  // constrained to the WORKING/INPUT_REQUIRED handshake pair.
  db.run(
    "UPDATE tasks SET state = 'TASK_STATE_WORKING', updated_at = ? WHERE id = ?",
    [Date.now(), childTaskId],
  );

  let handle: ProviderHandle | undefined;
  let terminalState: "TASK_STATE_COMPLETED" | "TASK_STATE_FAILED" =
    "TASK_STATE_COMPLETED";
  let errorMessage: string | null = null;
  let outcome: Awaited<ReturnType<typeof drainRun>> | undefined;

  try {
    handle = provider.spawn({
      runId: childTaskId, // child has no run row; reuse id for prompt/logs only
      prompt: message,
      cwd,
      // VOS-96 T10: ProviderSpawnRequest.chatId removed (ADR-0001 §Decision).
      // Child dispatch sets taskId = childTaskId and folds the chat-shaped
      // identifier into contextId.
      taskId: childTaskId,
      contextId,
    });

    // VOS-96 T6: canonical event loop per ADR-0001 §Decision. Provider
    // normalizes wire format on yield; dispatch-child sees only
    // `SessionEvent | PartsEvent`. CC-shape parsing lives upstream in
    // providers/claude-code/cc-shape.ts.
    // No onSession callback — child has no chat row to update.
    // onPart fans out chat.token / chat.tool_use / chat.tool_result so WS
    // clients can render the child task stream live (VOS-91 T4). drainRun
    // owns parts accumulation + firstAssistantSeen tracking; this hook
    // only emits side-effects, mirroring orchestrator's two-pass ordering:
    // tool_use / tool_result inline (in parts order), then a single
    // chat.token for the concatenated frame text.
    outcome = await drainRun({
      handle,
      onPart: (frame) => {
        for (const p of frame.parts) {
          if (typeof (p as TextPart).text === "string") continue;
          const data = (p as DataPart).data;
          if (!data || typeof data !== "object") continue;
          const kind = (data as { kind?: unknown }).kind;
          if (kind === "tool_use") {
            emit("chat.tool_use", {
              chat_id: contextId,
              task_id: childTaskId,
              run_id: childRunId,
              tool_call_id: (data as { tool_call_id?: string }).tool_call_id,
              name: (data as { tool_name?: string }).tool_name,
              input: (data as { input?: unknown }).input,
            } as Record<string, unknown>);
          } else if (kind === "tool_result") {
            emit("chat.tool_result", {
              chat_id: contextId,
              task_id: childTaskId,
              run_id: childRunId,
              tool_call_id: (data as { tool_call_id?: string }).tool_call_id,
              output: (data as { output?: unknown }).output,
              is_error: (data as { is_error?: unknown }).is_error === true,
            } as Record<string, unknown>);
          }
        }
        if (frame.frameText) {
          emit("chat.token", {
            chat_id: contextId,
            task_id: childTaskId,
            run_id: childRunId,
            delta: frame.frameText,
          });
        }
      },
    });
  } catch (e) {
    terminalState = "TASK_STATE_FAILED";
    errorMessage = e instanceof Error ? e.message : String(e);
    bus.emit({
      type: "child.error",
      payload: {
        child_task_id: childTaskId,
        error: errorMessage,
      },
    });
  }

  // Persist message OUTSIDE the try: if appendMessage throws (DB write
  // error), it surfaces via the outer .catch() at the microtask boundary
  // as child.dispatch_error, NOT as a wrongly-flipped TASK_STATE_FAILED.
  if (outcome && outcome.firstAssistantSeen && outcome.parts.length > 0) {
    messages.appendMessage(
      childTaskId,
      contextId,
      null, // child has no run row
      "ROLE_AGENT",
      outcome.parts,
      Date.now(),
    );
  }

  // VOS-89 review-fix Finding 2: persist errorMessage to tasks.metadata
  // on FAILED so translateChildResult can surface the real error string
  // to the parent ask_agent caller. Without this, the parent sees
  // "child task failed: unknown" since the raw error is lost.
  if (terminalState === "TASK_STATE_FAILED") {
    const existingRow = db
      .query("SELECT metadata FROM tasks WHERE id = ?")
      .get(childTaskId) as { metadata: string | null } | undefined;
    let meta: Record<string, unknown> = {};
    if (existingRow?.metadata) {
      try {
        const parsed = JSON.parse(existingRow.metadata);
        if (parsed && typeof parsed === "object") {
          meta = parsed as Record<string, unknown>;
        }
      } catch {
        // malformed metadata — overwrite with fresh object
      }
    }
    const providerName =
      (provider as unknown as { providerName?: string }).providerName ??
      "provider";
    const truncated = (errorMessage ?? "unknown").slice(0, 200);
    meta.errorMessage = `${providerName}: ${truncated}`;
    db.run(
      "UPDATE tasks SET state = ?, metadata = ?, updated_at = ? WHERE id = ?",
      [terminalState, JSON.stringify(meta), Date.now(), childTaskId],
    );
  } else {
    db.run(
      "UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?",
      [terminalState, Date.now(), childTaskId],
    );
  }

  bus.emit({
    type: "task.state_changed",
    payload: { taskId: childTaskId, state: terminalState },
  });
}
