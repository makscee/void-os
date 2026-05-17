/**
 * VOS-107 T9: chained globalSetup that runs the shared (main) setup AND the
 * ask-user-isolated setup sequentially. Playwright supports only a single
 * top-level globalSetup, so we chain the two project setups here.
 */
import sharedSetup from "./globalSetup.ts";
import askUserSetup from "./globalSetup-ask-user.ts";
import permissionDenyUiSetup from "./globalSetup-permission-deny-ui.ts";

export default async function globalSetupAll() {
  await sharedSetup();
  await askUserSetup();
  await permissionDenyUiSetup();
}
