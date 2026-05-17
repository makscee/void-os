/**
 * VOS-107 T9: chained globalTeardown — mirrors globalSetup-all.ts. Tears
 * down both the shared and the ask-user-isolated daemons. Each teardown
 * is wrapped in try/catch so a failure in one doesn't leak the other.
 */
import sharedTeardown from "./globalTeardown.ts";
import askUserTeardown from "./globalTeardown-ask-user.ts";
import permissionDenyUiTeardown from "./globalTeardown-permission-deny-ui.ts";

export default async function globalTeardownAll() {
  // Tear down in reverse setup order (last-started first).
  try { await permissionDenyUiTeardown(); } catch (err) { console.error("[teardown] permission-deny-ui:", err); }
  try { await askUserTeardown(); } catch (err) { console.error("[teardown] ask-user:", err); }
  try { await sharedTeardown(); } catch (err) { console.error("[teardown] shared:", err); }
}
