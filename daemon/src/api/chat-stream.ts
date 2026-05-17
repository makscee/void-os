import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Database } from "bun:sqlite";
import type { EventBus, DaemonEvent } from "../events/index.ts";

interface Deps {
  db: Database;
  bus: EventBus;
  version: string;
}

export function mountChatStream(app: Hono, deps: Deps): void {
  app.get("/chat/:id/stream", (c) => {
    const id = c.req.param("id");
    // Chat lookup hits the post-0007 table name: `chats` was renamed to
    // `contexts` in migration 0007_a2a_tables.sql.
    const row = deps.db.query("SELECT id FROM contexts WHERE id = ?").get(id);
    if (!row) return c.json({ error: "E_NOT_FOUND" }, 404);

    const textOnly = c.req.query("text_only") === "1";

    return streamSSE(c, async (stream) => {
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        try { await stream.close(); } catch { /* already closed */ }
      };

      // Serialise writes: bus events arrive synchronously, but writeSSE
      // is async. If we did not chain them, a `run_end` emitted in the
      // same tick as a `text` event could close the stream before the
      // text write had flushed, dropping the frame.
      let writeChain: Promise<void> = Promise.resolve();
      const enqueue = (frame: { event: string; data: unknown }, isFinal: boolean) => {
        writeChain = writeChain
          .then(() => stream.writeSSE({ event: frame.event, data: JSON.stringify(frame.data) }))
          .catch(() => {});
        if (isFinal) {
          writeChain = writeChain.then(() => close()).catch(() => {});
        }
      };

      const handler = (event: DaemonEvent) => {
        if (event.chatId !== id) return;
        let frame: { event: string; data: unknown } | null = null;
        switch (event.type) {
          case "text":
            frame = { event: "text", data: { run_id: event.runId, ...(event.payload as object) } };
            break;
          case "tool_use":
            if (textOnly) return;
            frame = { event: "tool_use", data: { run_id: event.runId, ...(event.payload as object) } };
            break;
          case "tool_result":
            if (textOnly) return;
            frame = { event: "tool_result", data: { run_id: event.runId, ...(event.payload as object) } };
            break;
          case "ask_user":
            frame = { event: "ask_user", data: { run_id: event.runId, ...(event.payload as object) } };
            break;
          case "usage":
            frame = { event: "usage", data: { run_id: event.runId, ...(event.payload as object) } };
            break;
          case "run.end":
            frame = { event: "run_end", data: { run_id: event.runId, ...(event.payload as object) } };
            break;
        }
        if (!frame) return;
        enqueue(frame, frame.event === "run_end");
      };

      const unsubscribe = deps.bus.subscribe("*", handler);

      stream.onAbort(() => void close());

      // First frame.
      await stream.writeSSE({
        event: "hello",
        data: JSON.stringify({ chat_id: id, version: deps.version }),
      });

      // Keep open until close() is called.
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => { if (closed) { clearInterval(interval); resolve(); } }, 50);
      });
    });
  });
}
