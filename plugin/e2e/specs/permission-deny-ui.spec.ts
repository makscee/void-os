import { test } from "@playwright/test";

test.skip(true, "blocked on VOS-109 — plugin UI has no denial render surface yet (no `tool_denied` event, no `turn-denial` testid); depends on VOS-108 emitting the event");

test("UI surfaces denial when agent attempts cross-scope write", async () => {
  // placeholder — un-skip when VOS-109 lands
});
