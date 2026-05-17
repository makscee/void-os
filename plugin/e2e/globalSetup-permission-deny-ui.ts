/**
 * VOS-109 T7: dedicated Playwright project setup for permission-deny-ui.spec.ts.
 *
 * Spawns its own daemon + Obsidian with `VOS_FAKE_SCRIPT_maya` pointing at
 * `fixtures/permission-deny/maya.jsonl`. The fixture drives maya to attempt
 * a `vault.create` against `journal/forbidden.md`; maya's seeded
 * write_scope:[] (globalSetup.ts L285-289) causes the MCP scope-gate to
 * deny the write. The denial materialises as a DataPart tool_result with
 * is_error:true; the daemon's denial synthesiser (VOS-109 T3) appends a
 * DenialPart in the same parts event, which the plugin renders via the
 * data.by_name.denial slot (VOS-109 T5) with data-testid="turn-denial".
 *
 * Mirrors globalSetup-ask-user.ts pattern.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setupE2E } from "./globalSetup.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERMISSION_DENY_SCRIPT = path.join(HERE, "fixtures", "permission-deny", "maya.jsonl");

export default async function globalSetupPermissionDenyUi() {
  await setupE2E({
    mayaScriptPath: PERMISSION_DENY_SCRIPT,
    stateEnvVar: "VOS_E2E_STATE_PERMISSION_DENY",
    tmpDirSuffix: "permission-deny-ui-",
  });
}
