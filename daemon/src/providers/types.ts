// Provider — provider-agnostic interface for "run an AI agent".
// VOS-86 first impl: claude-code. See spec
// docs/superpowers/specs/2026-05-15-vos-86-provider-abstraction-design.md
//
// Event shape is intentionally loose so any provider impl can pass through
// its own NDJSON wire format unchanged. The single guaranteed field is `type`.
// Today the claude-code impl emits raw CC types ('system' | 'assistant' | 'user');
// canonicalization is deferred to a follow-up task.

export interface ProviderSpawnRequest {
  runId: string;
  prompt: string;
  cwd: string;
  chatId?: string;
  kind?: "turn" | "replay" | string;
  resumeFrom?: string;          // session id passed to --resume
  outputTimeoutMs?: number;
  toolTimeoutMs?: number;
  firstEventTimeoutMs?: number;
  settings?: Record<string, unknown>;
}

export interface ProviderEvent {
  type: string;                 // 'system' | 'assistant' | 'user' | impl-specific
  session_id?: string;          // present on 'system' events (CC handshake)
  message?: unknown;            // present on 'assistant' / 'user' events
  name?: string;
  input?: unknown;
  output?: unknown;
  content?: unknown;
  [k: string]: unknown;
}

export interface ProviderHandle {
  // AsyncIterable of raw events for this run. Single-shot — not re-iterable.
  // Iteration ends when the run ends (exit / cancel / timeout / error).
  events: AsyncIterable<ProviderEvent>;
  // Cooperative cancellation. Resolves true if a cancel was signalled,
  // false if the run had already ended.
  cancel(opts?: { fast?: boolean }): Promise<boolean>;
  // Resolves with the terminal outcome once the stream is drained.
  done: Promise<{
    exitCode?: number;
    sessionId?: string;
    reason: "exit" | "cancel" | "timeout" | "error";
  }>;
}

export interface Provider {
  readonly name: string;        // e.g. 'claude-code'
  spawn(req: ProviderSpawnRequest): ProviderHandle;
  probe?(): Promise<{ ok: boolean; version?: string; error?: string }>;
}
