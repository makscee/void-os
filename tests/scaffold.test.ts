// scaffold smoke test — verifies module stubs are importable
import { test, expect } from "bun:test";

test("placeholder modules exist", async () => {
  // Each module must import without throwing at the module level
  const paths = await import("../src/paths.ts");
  const frontmatter = await import("../src/frontmatter.ts");
  const catalog = await import("../src/catalog.ts");
  const sessions = await import("../src/sessions.ts");
  const spawn = await import("../src/spawn.ts");
  const render = await import("../src/render.ts");

  expect(typeof paths.sessionsRoot).toBe("function");
  expect(typeof frontmatter.parseFrontmatter).toBe("function");
  expect(typeof catalog.listCatalogSkills).toBe("function");
  expect(typeof sessions.listSessions).toBe("function");
  expect(typeof spawn.buildLaunchArgv).toBe("function");
  expect(typeof render.renderDashboard).toBe("function");
});
