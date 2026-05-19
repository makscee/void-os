import { mkdirSync, copyFileSync, writeFileSync, watch as fsWatch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const watch = process.argv.includes("--watch");
const out = process.env.VOID_OS_PLUGIN_OUT
  ?? join(homedir(), "void", ".obsidian", "plugins", "void-os");

mkdirSync(out, { recursive: true });

async function buildOnce() {
  const result = await Bun.build({
    entrypoints: ["src/main.ts"],
    outdir: out,
    format: "cjs",
    target: "browser", // Obsidian renderer is browser-like (window/document)
    external: ["obsidian"],
    minify: !watch,
    loader: { ".tsx": "tsx", ".ts": "ts" },
    define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  });
  if (!result.success) {
    console.error(result.logs);
    if (!watch) process.exit(1);
    return;
  }
  copyFileSync("manifest.json", join(out, "manifest.json"));

  // Tailwind v4 CLI: compile chat stylesheet to styles.css alongside main.js.
  // preflight off + `vos-` prefix + scoped @source live in src/chat/tailwind.css.
  const tw = Bun.spawnSync({
    cmd: [
      "bunx",
      "@tailwindcss/cli",
      "-i", "src/chat/tailwind.css",
      "-o", join(out, "styles.css"),
      ...(watch ? [] : ["--minify"]),
    ],
    stderr: "inherit",
    stdout: "inherit",
  });
  if (tw.exitCode !== 0) {
    if (!watch) process.exit(tw.exitCode ?? 1);
    return;
  }

  // VOS-149 T2: sentinel for Obsidian's "Hot Reload" community plugin. It
  // watches plugin dirs for `.hotreload` mtime bumps and reloads on change —
  // no Obsidian restart needed during the dogfood loop. Content is irrelevant;
  // mtime is the signal.
  writeFileSync(join(out, ".hotreload"), "");

  console.log(`[void-os/plugin] built → ${out}`);
}

await buildOnce();

if (watch) {
  const debounce = (fn: () => void, ms = 100) => {
    let h: any;
    return () => { clearTimeout(h); h = setTimeout(fn, ms); };
  };
  const rebuild = debounce(() => { buildOnce().catch(console.error); });
  fsWatch("src", { recursive: true }, rebuild);
  fsWatch("manifest.json", rebuild);
  console.log("[void-os/plugin] watching src/...");
}
