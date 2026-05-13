// State-aware idle watchdog. Pure-ish: takes `now`, `lastEventTs`, and
// `inToolCall` from the caller. The spawner wires setInterval(tick).

export interface WatchdogTimeoutInfo {
  idleMs: number;
  threshold: number;
}

export interface WatchdogOpts {
  now: () => number;
  outputTimeoutMs: number;
  toolTimeoutMs: number;
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
      const idleMs = opts.now() - opts.lastEventTs();
      const threshold = opts.inToolCall() > 0 ? opts.toolTimeoutMs : opts.outputTimeoutMs;
      if (idleMs > threshold) {
        didFire = true;
        opts.onTimeout({ idleMs, threshold });
      }
    },
    fired: () => didFire,
  };
};
