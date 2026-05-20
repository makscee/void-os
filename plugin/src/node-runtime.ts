/**
 * Lazy-require node built-ins. Bun's `target: "browser"` bundler (see
 * plugin/build.ts) replaces static `import "node:os"` / `node:fs` / etc. with
 * empty browser polyfills, which means `homedir()`, `spawn()`, `statSync()`
 * etc. become undefined in the Obsidian renderer at runtime — causing a
 * TypeError on plugin onload that Obsidian swallows silently.
 *
 * Strategy: route every node-built-in access through a runtime `require(...)`
 * call inside a function body. Obsidian's plugin host injects a working Node
 * `require` into renderer scope (Electron preload). Bun's tree-shaker leaves
 * `require("os")` strings alone because they are NOT static `import` syntax.
 *
 * The `try { require(...) } catch { ... }` shape also keeps Bun's unit-test
 * runtime happy: when `globalThis.require` is missing, we fall back to a
 * synchronous `require(name)` which Bun resolves natively in test context.
 *
 * Keep this module free of ANY static `import "node:*"` — that's the whole
 * point. Even an unused import gets bundled and re-triggers the bug.
 */

type OsLike = { homedir: () => string };
type FsLike = {
  // Overloaded: an explicit encoding yields a string, no encoding yields a Buffer.
  readFileSync: {
    (p: string, e: string): string;
    (p: string): Buffer;
  };
  writeFileSync: (p: string, d: string | Buffer) => void;
  appendFileSync: (p: string, d: string | Buffer) => void;
  existsSync: (p: string) => boolean;
  statSync: (p: string) => { isFile: () => boolean };
  accessSync: (p: string, mode?: number) => void;
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
  constants: { X_OK: number };
};
type CpLike = {
  spawn: (cmd: string, args?: string[], opts?: any) => any;
};
type PathLike = {
  join: (...p: string[]) => string;
  resolve: (...p: string[]) => string;
  dirname: (p: string) => string;
};

function load<T>(name: string): T {
  const g: any = globalThis as any;
  const req = g.require;
  if (typeof req === "function") {
    try {
      return req(name) as T;
    } catch {
      /* fall through to native require */
    }
  }
  // Bun / Node test context: dynamic require resolves at call time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(name) as T;
}

export const nodeOs: OsLike = load<OsLike>("os");
export const nodeFs: FsLike = load<FsLike>("fs");
export const nodeCp: CpLike = load<CpLike>("child_process");
export const nodePath: PathLike = load<PathLike>("path");
