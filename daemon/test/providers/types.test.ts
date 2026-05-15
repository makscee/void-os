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

test("ProviderEvent accepts loose CC NDJSON shape", () => {
  const evt: ProviderEvent = {
    type: "assistant",
    message: { content: [{ type: "text", text: "hi" }] },
  };
  expect(evt.type).toBe("assistant");
});
