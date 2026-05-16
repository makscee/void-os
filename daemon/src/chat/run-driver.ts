import type { ProviderHandle } from "../providers/types.ts";
import type { Part, Role } from "../types/a2a.ts";

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
  const { handle, signal, onSession, onPart } = args;

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
        for (const p of partsEvt.parts) {
          if (isText(p)) frameText += p.text;
          agentParts.push(p);
        }
        onPart?.({ parts: partsEvt.parts, frameText, role: partsEvt.role });
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

  const abortSentinel = signal
    ? new Promise<{ reason: "cancel" }>((resolve) => {
        if (signal.aborted) resolve({ reason: "cancel" });
        else signal.addEventListener("abort",
          () => resolve({ reason: "cancel" }), { once: true });
      })
    : null;

  const done = abortSentinel
    ? await Promise.race([handle.done, abortSentinel])
    : await handle.done;

  if (signal?.aborted && done.reason === "cancel") {
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
