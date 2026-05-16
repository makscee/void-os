/**
 * VOS-107 T9: chained globalTeardown — mirrors globalSetup-all.ts. Tears
 * down both the shared and the ask-user-isolated daemons. Each teardown
 * is wrapped in try/catch so a failure in one doesn't leak the other.
 */
import sharedTeardown from "./globalTeardown.ts";
import askUserTeardown from "./globalTeardown-ask-user.ts";

export default async function globalTeardownAll() {
  // Tear down the ask-user daemon first since it was started last.
  try { await askUserTeardown(); } catch (err) { console.error("[teardown] ask-user:", err); }
  try { await sharedTeardown(); } catch (err) { console.error("[teardown] shared:", err); }
}
