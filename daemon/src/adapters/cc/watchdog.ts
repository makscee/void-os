// State-aware idle watchdog. Pure-ish: takes `now`, `lastEventTs`, and
// `inToolCall` from the caller. The spawner wires setInterval(tick).
//
// VOS-80 fix: three timeout phases.
//   1. firstEventTimeoutMs — applies until the first parsed stream-json event
//      arrives (lastEventTs() === 0). Catches "CC --resume hangs in
//      claudev auth/setup" pathologies where stdout only ever produces noise
//      lines. Without this, idle was measured against `started` and the
//      user-facing run stayed in "running" for up to outputTimeoutMs (120s)
//      before the indicator unstuck. Default 15s — far above normal first-
//      token latency, but well below the prior 120s ceiling.
//   2. toolTimeoutMs — when a tool call is open (inToolCall() > 0). Tools
//      legitimately take a long time (search, build, ssh) so this is generous.
//   3. outputTimeoutMs — between assistant tokens after the first event. The
//      original idle threshold; covers mid-stream stalls.

export interface WatchdogTimeoutInfo {
  idleMs: number;
  threshold: number;
  /** Which phase triggered the timeout. Surfaces in run.timeout event so
   * the cancel-resume hang case (`first_event`) can be distinguished from
   * a mid-stream stall (`output`) in traces and tests. */
  phase: "first_event" | "output" | "tool";
}

export interface WatchdogOpts {
  now: () => number;
  outputTimeoutMs: number;
  toolTimeoutMs: number;
  /** VOS-80 fix: pre-first-event idle ceiling. Default supplied by caller
   * (cc/index.ts → DEFAULT_FIRST_EVENT_TIMEOUT_MS). */
  firstEventTimeoutMs: number;
  /** Spawn-start timestamp; needed to compute idle-before-first-event since
   * lastEventTs() returns 0 until the parser sees a JSON line. */
  startedAt: number;
  lastEventTs: () => number;
  inToolCall: () => number;
  onTimeout: (info: WatchdogTimeoutInfo) => void;
}

export interface Watchdog {
  tick(): void;
  fired(): boolean;
}

export const createWatchdog = (opts: WatchdogOpts): Watchdog => {
  let didFire = false;
  return {
    tick() {
      if (didFire) return;
      const last = opts.lastEventTs();
      const now = opts.now();
      // Pre-first-event branch: no parsed events yet → compare against
      // startedAt with the (short) firstEventTimeoutMs threshold.
      if (last === 0) {
        const idleMs = now - opts.startedAt;
        if (idleMs > opts.firstEventTimeoutMs) {
          didFire = true;
          opts.onTimeout({
            idleMs,
            threshold: opts.firstEventTimeoutMs,
            phase: "first_event",
          });
        }
        return;
      }
      // Post-first-event branch: existing tool/output split.
      const idleMs = now - last;
      const inTool = opts.inToolCall() > 0;
      const threshold = inTool ? opts.toolTimeoutMs : opts.outputTimeoutMs;
      if (idleMs > threshold) {
        didFire = true;
        opts.onTimeout({
          idleMs,
          threshold,
          phase: inTool ? "tool" : "output",
        });
      }
    },
    fired: () => didFire,
  };
};
