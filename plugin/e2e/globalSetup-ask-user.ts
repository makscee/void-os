/**
 * VOS-107 T9: dedicated Playwright project setup for ask-user.spec.ts.
 *
 * Spawns its own daemon + Obsidian with `VOS_FAKE_SCRIPT_maya` pointing at
 * `fixtures/ask-user.jsonl` instead of the shared ask-agent maya fixture.
 * This isolates the ask-user spec from companion specs (chat-roundtrip,
 * chat-list-polish, ask-agent*) which also use `agent: "maya"` and would
 * otherwise receive the ask-user fixture and break.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setupE2E } from "./globalSetup.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASK_USER_SCRIPT = path.join(HERE, "fixtures", "ask-user.jsonl");

export default async function globalSetupAskUser() {
  await setupE2E({
    mayaScriptPath: ASK_USER_SCRIPT,
    stateEnvVar: "VOS_E2E_STATE_ASK_USER",
    tmpDirSuffix: "ask-user-",
  });
}
