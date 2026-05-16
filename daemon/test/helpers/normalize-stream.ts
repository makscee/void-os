// VOS-96 B2 test shim: mirrors what providers/claude-code/provider.ts and
// providers/fake/index.ts do on yield — translate raw CC-shaped frames
// into canonical `ProviderEvent`s. Test fakes / inline event generators
// still script the legacy CC shape (smaller, more familiar) and route
// through this normalizer so the orchestrator + dispatch-child consumer
// loops see the same canonical stream they would see in production.
//
// Delete alongside the legacy `LegacyProviderEvent` arm in T9/T10 once
// every test fake emits canonical events directly.

import type {
  CanonicalProviderEvent,
  LegacyProviderEvent,
} from "../../src/providers/types.ts";
import { normalizeCcEvent } from "../../src/providers/claude-code/cc-shape.ts";

export async function* normalizeStream(
  // Test helper: accepts any iterable of frames. The production seam types
  // this as CcIter (legacy) or canonical; here we accept any shape so test
  // fixtures keep their concise inline literal form without churn. Each
  // element is treated as either a canonical event (passed through) or a
  // raw CC frame (normalized via the same path the prod provider uses).
  src: AsyncIterable<unknown>,
): AsyncGenerator<CanonicalProviderEvent, void, void> {
  for await (const e of src) {
    const ev = e as { type?: unknown };
    if (ev.type === "session" || ev.type === "parts") {
      yield ev as unknown as CanonicalProviderEvent;
      continue;
    }
    const c = normalizeCcEvent(ev as LegacyProviderEvent);
    if (c) yield c;
  }
}
