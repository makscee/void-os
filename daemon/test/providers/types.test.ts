import { test, expect } from "bun:test";
import type {
  Provider,
  ProviderEvent,
  ProviderHandle,
  ProviderSpawnRequest,
} from "../../src/providers/types.ts";

test("Provider interface is satisfiable by a hand-rolled mock", () => {
  const mock: Provider = {
    name: "mock",
    spawn(_req: ProviderSpawnRequest): ProviderHandle {
      return {
        events: (async function* () {
          // empty iterable
        })(),
        cancel: async () => false,
        done: Promise.resolve({ reason: "exit" as const, exitCode: 0 }),
      };
    },
  };
  expect(mock.name).toBe("mock");
});

test("ProviderEvent is the canonical discriminated union (ADR-0001)", () => {
  // VOS-96: ProviderEvent narrowed from the loose CC pass-through to the
  // canonical `SessionEvent | PartsEvent` union per ADR-0001 §Decision.
  // Raw CC frames are typed via `LegacyProviderEvent` at internal seams.
  const session: ProviderEvent = { type: "session", sessionId: "sid-1" };
  const parts: ProviderEvent = {
    type: "parts",
    role: "ROLE_AGENT",
    parts: [{ text: "hi" }],
    ts: Date.now(),
  };
  expect(session.type).toBe("session");
  expect(parts.type).toBe("parts");
});
