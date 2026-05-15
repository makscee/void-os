// Stream-json line parser for claudev/claude --output-format stream-json.
// Pure (no I/O, no timers). Caller wires onEvent/onNoise/onSession/onWarning
// into the spawner's EventBus + JSONL writer.

export interface ParserHandlers {
  onEvent:   (event: StreamEvent) => void;
  onNoise:   (line: string) => void;       // non-JSON stdout line (claudev preamble)
  onSession: (sessionId: string) => void;  // first time session_id is captured
  onWarning: (w: ParserWarning) => void;
}

export interface ParserWarning {
  reason: "unknown_tool_result_id";
  id?: string;
}

// Loose shape — claudev stream-json carries varied content. We index a few
// known fields and pass the rest through.
export interface StreamEvent {
  type: string;
  [k: string]: unknown;
}

export interface StreamParser {
  feed(chunk: Buffer): void;
  flush(): void;
  inToolCall(): number;
  lastEventType(): string;
  lastEventTs(): number;
  sessionId(): string | undefined;
}

export const createStreamParser = (h: ParserHandlers): StreamParser => {
  let buf = "";
  let _lastEventType = "";
  let _lastEventTs = 0;
  let _sessionId: string | undefined;
  const openToolUseIds = new Set<string>();

  const handleLine = (line: string): void => {
    if (line.length === 0) return;
    let event: StreamEvent | undefined;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
        event = parsed as StreamEvent;
      } else {
        h.onNoise(line);
        return;
      }
    } catch {
      h.onNoise(line);
      return;
    }

    // session_id capture (first system event)
    if (event.type === "system" && typeof (event as { session_id?: unknown }).session_id === "string") {
      const sid = (event as { session_id: string }).session_id;
      if (_sessionId === undefined) {
        _sessionId = sid;
        h.onSession(sid);
      }
    }

    // tool_use / tool_result tracking — content blocks live under
    // event.message.content[] for both assistant (tool_use) and user
    // (tool_result) message events.
    const msg = (event as { message?: { content?: unknown } }).message;
    const content = msg && Array.isArray(msg.content) ? msg.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; id?: string; tool_use_id?: string };
      if (b.type === "tool_use" && typeof b.id === "string") {
        openToolUseIds.add(b.id);
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        if (openToolUseIds.has(b.tool_use_id)) {
          openToolUseIds.delete(b.tool_use_id);
        } else {
          h.onWarning({ reason: "unknown_tool_result_id", id: b.tool_use_id });
        }
      }
    }

    _lastEventType = event.type;
    _lastEventTs = Date.now();
    h.onEvent(event);
  };

  return {
    feed(chunk) {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    },
    flush() {
      if (buf.length > 0) {
        const line = buf;
        buf = "";
        handleLine(line);
      }
    },
    inToolCall: () => openToolUseIds.size,
    lastEventType: () => _lastEventType,
    lastEventTs: () => _lastEventTs,
    sessionId: () => _sessionId,
  };
};
