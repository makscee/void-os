import { resolve as pathResolve } from "node:path";
import { FileSystemAdapter, type App } from "obsidian";
import { UnsupportedPlatformError } from "./daemon-lifecycle";

/**
 * Resolve the absolute filesystem path of the loaded Obsidian vault. Throws
 * UnsupportedPlatformError on mobile / non-desktop adapters (no FS access).
 *
 * Isolated in its own module so `daemon-lifecycle.ts` can stay free of any
 * `obsidian` import — Bun's test runner cannot resolve the `obsidian`
 * package (it ships .d.ts only, no runtime module), so anything that
 * imports it must be mocked or kept out of the unit-test import graph.
 */
export function getVaultRoot(app: App): string {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new UnsupportedPlatformError(
      "void-os requires Obsidian desktop (FileSystemAdapter)",
    );
  }
  return pathResolve(adapter.getBasePath());
}
