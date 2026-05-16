import type { CcRecordLike } from "./cc-shape.ts";
import { extractTurnText } from "../../chat/util.ts";

/**
 * Extract concatenated text from a CC stream-json `assistant` record.
 *
 * VOS-96 NOTE: deprecated shim — production providers now normalize CC
 * frames into canonical `ProviderEvent`s on yield, so consumers never call
 * this. Kept temporarily for the existing extract.ts unit tests in
 * orchestrator.test.ts; T9 deletes this file outright (and migrates the
 * tests to cover `normalizeCcEvent` instead).
 *
 * Accepts the raw CC record shape (`{message:{content:[...]}}`) — same as
 * `extractTurnText`. We retain the legacy delegating wrapper for callsite
 * stability inside the test suite only.
 */
export function extractAssistantText(evt: CcRecordLike): string {
  return extractTurnText(evt);
}
