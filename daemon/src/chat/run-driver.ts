import type { ProviderHandle } from "../providers/types.ts";
import type { Part, Role } from "../types/a2a.ts";
import { maybeSynthDenial } from "./parts/denial-synth.ts";

export interface PartFrame {
  parts: Part[];
  frameText: string;
  role: Role;
}

export interface DrainRunArgs {
  handle: ProviderHandle;
  signal?: AbortSignal;
  onSession?: (sessionId: string) => void;
  onPart?: (frame: PartFrame) => void;
  /**
   * VOS-109: agent identity for denial synthesis fallback. When a tool_result
   * carries `WRITE_SCOPE_DENIED:` (CC hook path) without a trailing
   * `for agent <name>` suffix, the synthesiser falls back to this name.
   * Optional for back-compat with callers (mostly tests) that don't care;
   * production callers (orchestrator, dispatch-child) MUST pass it.
   */
  agentName?: string;
  /**
   * VOS-161: soft-pause checkpoint. Awaited at each frame boundary (before
   * the next provider frame is processed). Resolves immediately when the
   * run is not paused; when paused it returns a promise that parks the run
   * until resume — the "wait-for-checkpoint" half of the two-verb model.
   * The await is raced against `signal` so a hard kill while parked still
   * exits promptly. Optional; omit for non-controllable runs.
   */
  onCheckpoint?: () => Promise<void>;
}

export interface TerminalOutcome {
  reason: "exit" | "cancel" | "timeout" | "error";
  exitCode?: number;
  sessionId?: string;
  parts: Part[];                 // merged (adjacent TextParts collapsed)
  firstAssistantSeen: boolean;
}

interface TextPart { text: string }
const isText = (p: Part): p is Part & TextPart =>
  typeof (p as TextPart).text === "string";

export function mergeAdjacentText(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev && isText(prev) && isText(p)) {
      out[out.length - 1] = { ...prev, text: prev.text + p.text } as Part;
    } else {
      out.push(p);
    }
  }
  return out;
}

export async function drainRun(args: DrainRunArgs): Promise<TerminalOutcome> {
  const { handle, signal, onSession, onPart, agentName, onCheckpoint } = args;

  const agentParts: Part[] = [];
  let firstAssistantSeen = false;

  if (signal) {
    signal.addEventListener("abort",
      () => { void handle.cancel().catch(() => false); }, { once: true });
  }

  // Build abort promise once so we can race each iterator step against it.
  const abortPromise: Promise<null> | null = signal
    ? new Promise<null>((resolve) => {
        if (signal.aborted) resolve(null);
        else signal.addEventListener("abort", () => resolve(null), { once: true });
      })
    : null;

  // Manual async-iterator loop so we can race each next() against the abort
  // signal. This ensures the loop exits promptly even when the generator is
  // suspended inside an await that never resolves.
  const iter = handle.events[Symbol.asyncIterator]();
  try {
    while (true) {
      // VOS-161: soft-pause checkpoint. A clean frame boundary — no torn
      // tool call. If the operator paused this agent, `onCheckpoint`
      // returns a promise that parks here until resume; raced against the
      // abort signal so a hard kill while parked exits promptly.
      if (onCheckpoint && !signal?.aborted) {
        const cp = onCheckpoint();
        if (abortPromise) {
          await Promise.race([cp, abortPromise]);
        } else {
          await cp;
        }
        if (signal?.aborted) break;
      }

      const step: IteratorResult<any> | null = abortPromise
        ? await Promise.race([
            iter.next(),
            abortPromise.then(() => null as null),
          ])
        : await iter.next();

      if (step === null || step.done) break;

      const evt = step.value;
      if (signal?.aborted) break;

      if (evt.type === "session") {
        onSession?.((evt as { sessionId: string }).sessionId);
        continue;
      }
      if (evt.type === "parts") {
        const partsEvt = evt as { role: Role; parts: Part[] };
        if (partsEvt.role === "ROLE_AGENT") firstAssistantSeen = true;
        let frameText = "";
        const augmented: Part[] = [];
        for (const p of partsEvt.parts) {
          if (isText(p)) frameText += p.text;
          augmented.push(p);
          agentParts.push(p);
          // VOS-109: synth a DenialPart immediately after any offending
          // deny tool_result so the augmented frame keeps them adjacent.
          // agentName fallback: tests may omit; synth tolerates "" since
          // the deny-path that needs the fallback only fires on CC hook
          // text shaped "WRITE_SCOPE_DENIED: <path>" — that path requires
          // a real agent name in production but the predicate still
          // matches with "" (it just produces a degenerate message).
          const denial = maybeSynthDenial(p, agentName ?? "");
          if (denial) {
            augmented.push(denial);
            agentParts.push(denial);
          }
        }
        onPart?.({ parts: augmented, frameText, role: partsEvt.role });
      }
    }
  } finally {
    // Call return() to clean up the generator (fires finally blocks inside it).
    // We do NOT await this — the caller doesn't need to wait for producer cleanup,
    // and awaiting a stuck generator would block drainRun itself.
    // For the iterator-close test, the microtask flush (30ms setTimeout) in the
    // test gives the generator enough time to execute its finally block once
    // return() is called.
    if (iter.return) {
      iter.return(undefined).catch(() => undefined);
    }
  }

  let handleDoneWon = false;
  const abortSentinel = signal
    ? new Promise<{ reason: "cancel" }>((resolve) => {
        if (signal.aborted) resolve({ reason: "cancel" });
        else signal.addEventListener("abort",
          () => resolve({ reason: "cancel" }), { once: true });
      })
    : null;

  const trackedDone = handle.done.then((v) => {
    handleDoneWon = true;
    return v;
  });

  const done = abortSentinel
    ? await Promise.race([trackedDone, abortSentinel])
    : await trackedDone;

  if (signal?.aborted && !handleDoneWon) {
    console.warn("[run-driver] handle.done did not resolve before signal.aborted — provider may be leaking");
  }

  return {
    reason: done.reason,
    exitCode: (done as { exitCode?: number }).exitCode,
    sessionId: (done as { sessionId?: string }).sessionId,
    parts: mergeAdjacentText(agentParts),
    firstAssistantSeen,
  };
}
