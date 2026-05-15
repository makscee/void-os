/**
 * No-op Titler — used in e2e and offline boot when VOS_TITLER=stub.
 * Conforms to `Titler` interface; every method returns synchronously
 * without touching the network or the chat-titles table.
 */
import type { Titler } from "./titler.ts";

export function makeTitlerStub(): Titler {
  return {
    async title(_chatId: string): Promise<void> {
      // intentionally empty
    },
  };
}
