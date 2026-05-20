/**
 * VOS-163: dedicated Playwright project setup for operator-journey.spec.ts.
 *
 * The journey is one long-running staged walkthrough; it gets its own
 * daemon + Obsidian (like ask-user) so it never contends with the baseline
 * `main` specs. State sidecar is exposed under VOS_E2E_STATE_JOURNEY.
 */
import { setupE2E } from "./globalSetup.ts";

export default async function globalSetupJourney() {
  await setupE2E({
    stateEnvVar: "VOS_E2E_STATE_JOURNEY",
    tmpDirSuffix: "journey-",
  });
}
