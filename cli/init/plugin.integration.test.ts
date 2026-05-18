import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, cpSync, existsSync, rmdirSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ensurePluginBuilt, PLUGIN_DIST_FILES } from "./plugin"

/**
 * Integration test that spawns the REAL bun build against the repo's actual
 * plugin/ sources, into a tmp prefix. This is the regression that the F3 fix
 * targets: without `VOID_OS_PLUGIN_OUT` pinned, plugin/build.ts wrote to
 * `~/void/.obsidian/plugins/void-os` and `plugin/dist` stayed empty.
 *
 * Heavy (~5-10s); gated by `VOS_INTEGRATION=1` so unit-test runs stay fast.
 * CI / smoke can set the env var to exercise it.
 */
const RUN = process.env.VOS_INTEGRATION === "1"
const describeIf = RUN ? describe : describe.skip

describeIf("ensurePluginBuilt() integration", () => {
  let root: string
  let prefix: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "vos122-plugin-int-"))
    prefix = join(root, "prefix")
    mkdirSync(prefix, { recursive: true })
    // Copy plugin/ from the repo into the tmp prefix. node_modules is
    // expected to live at the repo root (workspace), so we link it.
    const repoRoot = resolve(import.meta.dir, "../..")
    cpSync(join(repoRoot, "plugin"), join(prefix, "plugin"), {
      recursive: true,
      filter: (src) => !src.includes("/dist") && !src.includes("/node_modules"),
    })
    // Bun's `run build` will resolve modules from the closest node_modules;
    // symlink to the repo's.
    mkdirSync(join(prefix, "node_modules"), { recursive: true })
    rmdirSync(join(prefix, "node_modules"))
    // We can't symlink across — but bun walks upward, so copy package.json
    // up so bun knows to resolve from repoRoot. Simplest: don't bother
    // with isolation; just run build inside the *real* plugin dir but
    // with VOID_OS_PLUGIN_OUT pointing at our tmp dist.
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("runs the real bun build and emits all artifacts to <prefix>/plugin/dist", () => {
    // Skip the copied-prefix dance: invoke the helper but point cwd at the
    // real plugin/ source (so node_modules resolves) while pinning the out
    // dir to our tmp via env. We do this by running spawnSync directly with
    // the same env-pin contract the helper enforces.
    const realPluginDir = resolve(import.meta.dir, "../../plugin")
    const tmpDist = join(prefix, "external-dist")
    rmSync(tmpDist, { recursive: true, force: true })

    // Use the helper's env contract via a custom spawn that ignores cwd
    // override and uses the real plugin dir; this verifies that when
    // VOID_OS_PLUGIN_OUT is set, build.ts honours it.
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    const r = spawnSync("bun", ["run", "build"], {
      cwd: realPluginDir,
      env: { ...process.env, VOID_OS_PLUGIN_OUT: tmpDist },
      encoding: "utf8",
    })

    if (r.status !== 0) {
      console.error("STDOUT:", r.stdout)
      console.error("STDERR:", r.stderr)
    }
    expect(r.status).toBe(0)
    for (const f of PLUGIN_DIST_FILES) {
      expect(existsSync(join(tmpDist, f))).toBe(true)
    }
    rmSync(tmpDist, { recursive: true, force: true })
  }, 60_000)

  it("ensurePluginBuilt builds a fresh prefix end-to-end", () => {
    // Full path: tmp prefix with no dist, run helper, expect dist populated.
    // We sidestep node_modules by copying from the repo's plugin/ + linking.
    const repoRoot = resolve(import.meta.dir, "../..")
    const e2ePrefix = join(root, "e2e")
    mkdirSync(join(e2ePrefix, "plugin"), { recursive: true })
    // Copy plugin sources (no dist).
    for (const entry of readdirSync(join(repoRoot, "plugin"))) {
      if (entry === "dist" || entry === "node_modules") continue
      cpSync(join(repoRoot, "plugin", entry), join(e2ePrefix, "plugin", entry), {
        recursive: true,
      })
    }
    // Symlink node_modules so bun can resolve.
    const fs = require("node:fs") as typeof import("node:fs")
    fs.symlinkSync(
      join(repoRoot, "node_modules"),
      join(e2ePrefix, "node_modules"),
      "dir",
    )

    const result = ensurePluginBuilt({ prefix: e2ePrefix, dryRun: false })
    expect(result.ran).toBe(true)
    expect(result.built).toBe(true)
    for (const f of PLUGIN_DIST_FILES) {
      expect(existsSync(join(e2ePrefix, "plugin/dist", f))).toBe(true)
    }
  }, 60_000)
})
