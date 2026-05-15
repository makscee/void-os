import { test, expect } from "bun:test";
import { makeClaudeCodeProvider } from "../../../src/providers/claude-code/index.ts";
import type {
  Provider,
  ProviderEvent,
  ProviderSpawnRequest,
} from "../../../src/providers/types.ts";

// Fake iterator-style spawner that mimics the existing CcSpawnerIter shape.
// Tests drive it through each terminal scenario.
function makeFakeIter(opts: {
  emit?: ProviderEvent[];
  onExit?: "ok" | "error";
  cancelable?: boolean;
}) {
  let cancelled = false;
  return {
    spawn: () =>
      (async function* () {
        for (const e of opts.emit ?? []) {
          if (cancelled) return;
          yield e;
        }
      })(),
    cancel: opts.cancelable
      ? async () => {
          cancelled = true;
          return true;
        }
      : undefined,
  };
}

function baseReq(): ProviderSpawnRequest {
  return { runId: "r1", prompt: "hi", cwd: "/tmp" };
}

test("done resolves 'exit' when iterator exhausts cleanly", async () => {
  const provider: Provider = makeClaudeCodeProvider({
    iter: makeFakeIter({ emit: [{ type: "assistant", message: {} }] }),
  });
  const h = provider.spawn(baseReq());
  const seen: ProviderEvent[] = [];
  for await (const e of h.events) seen.push(e);
  const out = await h.done;
  expect(seen).toHaveLength(1);
  expect(out.reason).toBe("exit");
});

test("done resolves 'cancel' when cancel() is invoked mid-stream", async () => {
  const provider: Provider = makeClaudeCodeProvider({
    iter: makeFakeIter({
      emit: [
        { type: "assistant", message: {} },
        { type: "assistant", message: {} },
      ],
      cancelable: true,
    }),
  });
  const h = provider.spawn(baseReq());
  const it = h.events[Symbol.asyncIterator]();
  await it.next(); // consume first
  const cancelled = await h.cancel();
  expect(cancelled).toBe(true);
  // drain
  while (!(await it.next()).done) {}
  const out = await h.done;
  expect(out.reason).toBe("cancel");
});

test("done resolves 'error' when underlying iterator throws", async () => {
  const provider: Provider = makeClaudeCodeProvider({
    iter: {
      spawn: () =>
        (async function* () {
          throw new Error("boom");
        })(),
    },
  });
  const h = provider.spawn(baseReq());
  try {
    for await (const _ of h.events) {
      // unreachable
    }
  } catch {
    // swallow — Provider surfaces error via done
  }
  const out = await h.done;
  expect(out.reason).toBe("error");
});

test("cancel() returns false after run has ended", async () => {
  const provider: Provider = makeClaudeCodeProvider({
    iter: makeFakeIter({ emit: [], cancelable: true }),
  });
  const h = provider.spawn(baseReq());
  for await (const _ of h.events) {}
  await h.done;
  expect(await h.cancel()).toBe(false);
});

test("provider.name is 'claude-code'", () => {
  const provider: Provider = makeClaudeCodeProvider({
    iter: makeFakeIter({ emit: [] }),
  });
  expect(provider.name).toBe("claude-code");
});
