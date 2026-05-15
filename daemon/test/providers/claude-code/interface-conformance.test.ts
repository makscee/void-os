import { test, expect } from "bun:test";
import {
  makeClaudeCodeProvider,
  makeClaudeCodeProviderComposed,
} from "../../../src/providers/claude-code/index.ts";
import type { Provider } from "../../../src/providers/types.ts";

test("makeClaudeCodeProvider returns Provider (type)", () => {
  const p: Provider = makeClaudeCodeProvider({
    iter: { spawn: () => (async function* () {})() },
  });
  expect(p.name).toBe("claude-code");
});

test("makeClaudeCodeProviderComposed is callable as a Provider factory (type only)", () => {
  // Compile-time check: type assignability. We don't construct one here
  // because it would require a real DB + bus + tracesDir; that's exercised
  // by the existing app-bootstrap test.
  const _typeCheck: (deps: Parameters<typeof makeClaudeCodeProviderComposed>[0]) => Provider =
    makeClaudeCodeProviderComposed;
  expect(typeof _typeCheck).toBe("function");
});
