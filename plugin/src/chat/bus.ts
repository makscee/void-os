// Tiny pub/sub for daemon WS frames. Decouples ChatRoot (React) from main.ts
// (Obsidian Plugin), and lets us share ONE WebSocket between the reconnect FSM
// (status bar) and the chat runtime (token streaming).
//
// Shape mirrors the daemon broadcast envelope:
//   {type: string, ts: number, ...payload}
// with payload keys promoted to top-level (see daemon/src/app.ts broadcast()).

export type DaemonFrame = {
  type: string;
  ts?: number;
  // payload fields (chat_id, run_id, delta, status, agent, ...) live here.
  [k: string]: unknown;
} & (
  | { type: "run.start" }
  | { type: "chat.message_user" }
  | { type: "chat.token"; task_id?: string }
  | { type: "chat.tool_use"; task_id?: string }
  | { type: "chat.tool_result"; task_id?: string }
  | { type: "run.end" }
  | { type: "run.error" }
  | {
      type: "chat.child_task_started";
      chat_id: string;
      parent_task_id: string;
      parent_tool_call_id: string;
      child_task_id: string;
      agent: string;
    }
  | {
      type: "chat.task.state_changed";
      chat_id: string;
      task_id: string;
      parent_task_id: string | null;
      state: "SUBMITTED" | "WORKING" | "WAITING_ON_AGENT" | "INPUT_REQUIRED" | "COMPLETED" | "FAILED" | "CANCELED";
      error?: string;
    }
);

export type FrameHandler = (f: DaemonFrame) => void;

export class FrameBus {
  private handlers = new Set<FrameHandler>();

  on(h: FrameHandler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  emit(f: DaemonFrame): void {
    for (const h of this.handlers) {
      try { h(f); } catch { /* one bad subscriber must not poison fan-out */ }
    }
  }
}
