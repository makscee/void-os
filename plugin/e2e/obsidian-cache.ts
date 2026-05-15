// VOS-94 — local Obsidian binary cache.
// See docs/superpowers/specs/2026-05-15-vos-94-e2e-obsidian-cache-design.md
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const OBSIDIAN_VERSION = "1.8.10";

export async function ensureObsidian(): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error(
      "obsidian-cache: macOS only; Linux follow-up pending (see VOS-94 spec).",
    );
  }
  throw new Error("obsidian-cache: not implemented");
}
