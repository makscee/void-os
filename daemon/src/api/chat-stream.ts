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
        // VOS-118: chatId may live on the envelope (legacy bus.emit path used
        // by ask-user-bridge / tests) or be folded into payload.chat_id by the
        // orchestrator's emit shim (the chat.* events are broadcast()-shaped
        // {type, ...payload} envelopes, so chat_id lands on payload). Accept
        // either so the SSE handler is independent of which writer fired it.
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const chatIdFromPayload =
          typeof payload.chat_id === "string" ? (payload.chat_id as string) : undefined;
        const chatId = event.chatId ?? chatIdFromPayload;
        if (chatId !== id) return;

        // VOS-118: orchestrator runId likewise rides payload.run_id on the
        // chat.* bus events. Prefer the envelope runId if set (legacy bus
        // emitters keep it), otherwise lift from payload.
        const runIdFromPayload =
          typeof payload.run_id === "string" ? (payload.run_id as string) : undefined;
        const runId = event.runId ?? runIdFromPayload;

        let frame: { event: string; data: unknown } | null = null;
        switch (event.type) {
          // Legacy bus event names — preserved so existing tests
          // (daemon/test/chat-stream.test.ts) and any future emitters that
          // publish in this vocabulary keep working.
          case "text":
            frame = { event: "text", data: { run_id: runId, ...payload } };
            break;
          case "tool_use":
            if (textOnly) return;
            frame = { event: "tool_use", data: { run_id: runId, ...payload } };
            break;
          case "tool_result":
            if (textOnly) return;
            frame = { event: "tool_result", data: { run_id: runId, ...payload } };
            break;
          case "ask_user":
            frame = { event: "ask_user", data: { run_id: runId, ...payload } };
            break;
          case "usage":
            frame = { event: "usage", data: { run_id: runId, ...payload } };
            break;
          case "run.end":
            frame = { event: "run_end", data: { run_id: runId, ...payload } };
            break;

          // VOS-118: orchestrator (daemon/src/chat/orchestrator.ts) emits
          // chat.token / chat.tool_use / chat.tool_result via the broadcast
          // shim; ask-user-bridge emits chat.ask_user. Translate each to the
          // SSE event names + payload shapes the CLI renderer
          // (cli/lib/stream-render.ts) expects. Renaming the orchestrator's
          // bus vocabulary is intentionally avoided — plugin reducer tests
          // (plugin/test/chat-reducer.test.ts etc.) depend on the chat.*
          // prefix on the WebSocket fan-out.
          case "chat.token": {
            // chat.token payload: {chat_id, run_id, delta}. CLI Frame "text"
            // expects {text: string}.
            const delta = typeof payload.delta === "string" ? (payload.delta as string) : "";
            frame = { event: "text", data: { run_id: runId, text: delta } };
            break;
          }
          case "chat.tool_use": {
            if (textOnly) return;
            // chat.tool_use payload: {chat_id, run_id, tool_call_id, name, input}.
            // CLI Frame "tool_use" expects {name, input, run_id?}.
            const name = typeof payload.name === "string" ? (payload.name as string) : "";
            const input =
              payload.input && typeof payload.input === "object"
                ? (payload.input as Record<string, unknown>)
                : {};
            frame = {
              event: "tool_use",
              data: {
                run_id: runId,
                tool_call_id: payload.tool_call_id,
                name,
                input,
              },
            };
            break;
          }
          case "chat.tool_result": {
            if (textOnly) return;
            // chat.tool_result payload: {chat_id, run_id, tool_call_id, output, is_error}.
            // CLI Frame "tool_result" expects {ok: boolean, size?, error?}.
            // ok = !is_error; size = byte length of stringified output when known;
            // error = output text when is_error.
            const isError = payload.is_error === true;
            const output = payload.output;
            let size: number | undefined;
            if (typeof output === "string") size = output.length;
            else if (output != null) {
              try {
                size = JSON.stringify(output).length;
              } catch {
                size = undefined;
              }
            }
            const data: Record<string, unknown> = {
              run_id: runId,
              tool_call_id: payload.tool_call_id,
              ok: !isError,
            };
            if (!isError && size !== undefined) data.size = size;
            if (isError) {
              data.error =
                typeof output === "string" ? output : output != null ? JSON.stringify(output) : "error";
            }
            frame = { event: "tool_result", data };
            break;
          }
          case "chat.ask_user": {
            // chat.ask_user payload: {chat_id, run_id, tool_use_id, question}.
            // CLI Frame "ask_user" expects {tool_use_id, prompt}.
            const question =
              typeof payload.question === "string" ? (payload.question as string) : "";
            const toolUseId =
              typeof payload.tool_use_id === "string" ? (payload.tool_use_id as string) : "";
            frame = {
              event: "ask_user",
              data: { run_id: runId, tool_use_id: toolUseId, prompt: question },
            };
            break;
          }
          case "run.error": {
            // CLI Frame "error" expects {message}.
            const message =
              typeof payload.error === "string"
                ? (payload.error as string)
                : payload.error != null
                  ? JSON.stringify(payload.error)
                  : "error";
            frame = { event: "error", data: { run_id: runId, message } };
            break;
          }
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
