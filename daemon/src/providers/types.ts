// Provider — provider-agnostic interface for "run an AI agent".
// VOS-86 first impl: claude-code. See spec
// docs/superpowers/specs/2026-05-15-vos-86-provider-abstraction-design.md
//
// Canonical event union per ADR-0001 (docs/adr/ADR-0001-provider-event-canonicalization.md):
// `ProviderEvent` is an A2A-shaped, delta-style discriminated union. The legacy loose
// CC-passthrough shape is kept as `LegacyProviderEvent` during the migration so the
// existing consumers (chat/orchestrator, chat/dispatch-child, fake provider) keep
// compiling until T3-T10 migrate them. The exported `ProviderEvent` is the union of
// the canonical events and the legacy shape; the new emitters and tests use the
// canonical members directly.

import type { Part, Role } from "../types/a2a.ts";

// --- Canonical (ADR-0001) -------------------------------------------------

export interface SessionEvent {
  type: "session";
  sessionId: string;
}

export interface PartsEvent {
  type: "parts";
  role: Role;                   // "user" | "assistant"
  parts: Part[];
  ts: number;
}

export type CanonicalProviderEvent = SessionEvent | PartsEvent;

// --- Legacy (pre-ADR-0001) ------------------------------------------------
//
// Kept compiling so T1's additive scaffolding does not break existing consumers.
// Removed in T10 after chat/orchestrator + chat/dispatch-child + fake provider
// migrate to the canonical union.

export interface LegacyProviderEvent {
  type: string;                 // 'system' | 'assistant' | 'user' | impl-specific
  session_id?: string;          // present on 'system' events (CC handshake)
  message?: unknown;            // present on 'assistant' / 'user' events
  name?: string;
  input?: unknown;
  output?: unknown;
  content?: unknown;
  [k: string]: unknown;
}

// VOS-96 T3/T5/T6 (B2): `ProviderEvent` is the canonical union per ADR-0001
// §Decision. Both CC provider.ts and fake provider.ts run incoming raw CC
// frames through `normalizeCcEvent` before yielding, so downstream consumers
// (orchestrator, dispatch-child) only ever observe `SessionEvent | PartsEvent`.
// `LegacyProviderEvent` remains exported solely so internal seams
// (CC spawner iterator, test inline fakes, fake provider script parser)
// that still construct raw CC frames pre-normalization can name the shape.
// T9/T10 delete the legacy alias once those callsites migrate.
export type ProviderEvent = CanonicalProviderEvent;

// --- Spawn request --------------------------------------------------------
//
// ADR-0001 §Decision tightens spawn: `taskId` and `contextId` become required, and
// `chatId` / `kind` are removed (chatId folded into contextId; kind lifted into
// settings.runKind). During the migration window `taskId`/`contextId` are typed as
// optional alongside the legacy fields; T10 flips them to required and drops
// `chatId`/`kind` once every callsite has been updated.

export interface ProviderSpawnRequest {
  runId: string;
  taskId?: string;              // ADR-0001: required after T10 migration
  contextId?: string;           // ADR-0001: required after T10 migration; supersedes chatId
  prompt: string;
  cwd: string;
  /** @deprecated use `contextId` (ADR-0001). Removed in T10. */
  chatId?: string;
  /** @deprecated lift into `settings.runKind` (ADR-0001). Removed in T10. */
  kind?: "turn" | "replay" | string;
  resumeFrom?: string;          // session id passed to --resume
  outputTimeoutMs?: number;
  toolTimeoutMs?: number;
  firstEventTimeoutMs?: number;
  timeouts?: { firstEventMs?: number; outputMs?: number; toolMs?: number };
  settings?: Record<string, unknown>;
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
