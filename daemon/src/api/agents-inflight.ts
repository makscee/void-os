// VOS-155: GET /agents/inflight — snapshot list + SSE delta stream.
//
// Two modes:
//   - GET /agents/inflight           → JSON snapshot { agents: InflightAgent[] }
//   - GET /agents/inflight?stream=1  → text/event-stream
//                                       hello frame → snapshot frame → delta frames
//
// The SSE branch mirrors mountChatStream's pattern: subscribe to the in-process
// bus, serialise writes through a Promise chain so close() can't race a
// pending writeSSE, and call stream.onAbort to drop the subscription when the
// client disconnects.

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { DaemonEvent, EventBus } from "../events/index.ts";
import type {
  AgentEvent,
  InflightRegistry,
} from "../agents/inflight.ts";

export interface MountInflightDeps {
  bus: EventBus;
  registry: InflightRegistry;
  version: string;
}

export function mountAgentsInflight(app: Hono, deps: MountInflightDeps): void {
  app.get("/agents/inflight", (c) => {
    const streamMode = c.req.query("stream") === "1";

    if (!streamMode) {
      return c.json({ agents: deps.registry.list() });
    }

    return streamSSE(c, async (stream) => {
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        try { await stream.close(); } catch { /* already closed */ }
      };

      let writeChain: Promise<void> = Promise.resolve();
      const enqueue = (frame: { event: string; data: unknown }) => {
        writeChain = writeChain
          .then(() => stream.writeSSE({ event: frame.event, data: JSON.stringify(frame.data) }))
          .catch(() => {});
      };

      const handler = (ev: DaemonEvent) => {
        const p = ev.payload as AgentEvent | undefined;
        if (!p) return;
        enqueue({ event: "agent_event", data: p });
      };

      const unsubscribe = deps.bus.subscribe("agent.event", handler);

      stream.onAbort(() => void close());

      // First frame: hello + version so clients can detect protocol drift.
      await stream.writeSSE({
        event: "hello",
        data: JSON.stringify({ version: deps.version }),
      });
      // Second frame: snapshot so reconnecting clients see current state
      // without waiting for the next delta.
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify({ agents: deps.registry.list() }),
      });

      // Keep open until close() is called.
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (closed) { clearInterval(interval); resolve(); }
        }, 50);
      });
    });
  });
}
